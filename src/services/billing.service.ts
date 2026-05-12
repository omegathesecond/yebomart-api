import crypto from 'node:crypto';
import { prisma } from '@config/prisma';
import { ShopTier } from '@prisma/client';
import { getPricingForCountry, getActiveTierPrice } from '@config/pricing';
import { getCurrencyForCountry } from '@utils/currencies';
import { YeboPayClient } from './yebopay.client';

// Synthetic YeboID UUID derived from shopId via SHA-256 → UUIDv8-style hex.
// Used so YeboPay charges/invoices for the same shop always resolve to the
// same yeboidUserId, even before YeboMart shop owners are YeboID-linked.
// When real YeboID linkage lands, this function is replaced by a lookup of
// the shop owner's actual sub from the User table.
function shopIdToYeboidSub(shopId: string): string {
  const hash = crypto.createHash('sha256').update(`yebomart-shop:${shopId}`).digest('hex');
  // Format as a UUID — 8-4-4-4-12.
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

const TIER_NAMES: Record<string, string> = {
  LITE: 'Lite',
  STARTER: 'Starter',
  BUSINESS: 'Business',
  PRO: 'Pro',
  ENTERPRISE: 'Enterprise',
};

// Subscription period (30d) — extracted so confirm + initial activation agree.
const SUBSCRIPTION_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

export class BillingService {
  // No longer a Stripe-mode flag — YeboPay controls its own mode. Frontend can
  // still surface "test mode" badges by reading the mode field on the response
  // (defaulted to whatever yebopay is in; can plumb through later if needed).
  static getMode(): 'live' | 'test' {
    return process.env.YEBOPAY_MODE_HINT === 'live' ? 'live' : 'test';
  }

  static getPlans(countryCode: string) {
    const pricing = getPricingForCountry(countryCode);
    const tiers = Object.keys(TIER_NAMES) as Array<keyof typeof TIER_NAMES>;

    return {
      country: pricing.country,
      countryCode: pricing.countryCode,
      currency: pricing.currency,
      currencySymbol: pricing.currencySymbol,
      discountLabel: pricing.discountLabel,
      discountPercent: pricing.discountPercent,
      plans: tiers.map((tier) => ({
        tier,
        name: TIER_NAMES[tier],
        price: pricing.tiers[tier as keyof typeof pricing.tiers],
        discountPrice: pricing.discountTiers?.[tier as keyof typeof pricing.discountTiers],
        activePrice: getActiveTierPrice(countryCode, tier),
      })),
    };
  }

  static async createCheckout(opts: {
    shopId: string;
    shopEmail?: string;
    countryCode: string;
    tier: ShopTier;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey?: string;
  }) {
    const pricing = getPricingForCountry(opts.countryCode);
    const activePrice = getActiveTierPrice(opts.countryCode, opts.tier);
    const currency = getCurrencyForCountry(opts.countryCode);

    // Same currency-conversion logic as before: send local-currency amount if
    // Stripe-supported, else convert to USD. The Invoice is recorded in the
    // CHARGE currency (what Stripe will actually charge), not the local
    // display currency — that's the source of truth for accounting.
    let amount: number;
    let chargeCurrency: string;
    if (currency.stripeSupported) {
      amount = activePrice;
      chargeCurrency = currency.code;
    } else {
      amount = Math.round((activePrice / currency.rate) * 100) / 100;
      chargeCurrency = 'USD';
    }

    // Shop owners aren't YeboID-linked yet; we use a synthetic UUID derived
    // from shopId so charges/invoices map consistently to the same shop over
    // time. When YeboMart wires YeboID, this becomes the shop owner's real sub.
    const yeboidSub = shopIdToYeboidSub(opts.shopId);

    const subscriptionDescription = `YeboMart ${TIER_NAMES[opts.tier]} Plan — monthly subscription`;
    const lineItems = [{
      description: subscriptionDescription,
      quantity: 1,
      unitPrice: amount,
    }];

    // 1. Create the invoice (DRAFT, due in 1 day — payment IS the activation).
    const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    let invoice;
    try {
      invoice = await YeboPayClient.createInvoice({
        yeboidSub,
        currency: chargeCurrency,
        dueDate,
        lineItems,
        toEmail: opts.shopEmail ?? '',
        toName: undefined,
        description: subscriptionDescription,
        metadata: {
          shopId: opts.shopId,
          tier: opts.tier,
          countryCode: opts.countryCode,
          flow: 'yebomart-subscription',
        },
      });
    } catch (err) {
      // If invoice creation fails (e.g. no shopEmail), fall back to checkout-only
      // so the user can still pay. Invoice is an artifact, not a blocker.
      console.warn('[Billing] invoice creation failed, falling back to checkout-only:', err instanceof Error ? err.message : err);
      invoice = null;
    }

    // 2. Create the checkout — linked to invoice if we have one.
    const checkout = await YeboPayClient.createCheckout({
      amount,
      currency: chargeCurrency,
      yeboidSub,
      paymentMethod: 'CARD',
      successUrl: opts.successUrl,
      cancelUrl: opts.cancelUrl,
      description: subscriptionDescription,
      email: opts.shopEmail,
      metadata: {
        shopId: opts.shopId,
        tier: opts.tier,
        countryCode: opts.countryCode,
        unitPriceLocal: String(activePrice),
        localCurrency: currency.code,
        localSymbol: pricing.currencySymbol,
        invoiceId: invoice?.id ?? '',
      },
      idempotencyKey: opts.idempotencyKey,
      invoiceId: invoice?.id,
    });

    // 3. Email the invoice (best-effort — if YeboLink is down, the checkout
    // URL still works; the email is just a record). Skip silently if there's
    // no email to send to.
    let invoicePdfUrl: string | null = invoice?.pdf_url ?? null;
    if (invoice && opts.shopEmail) {
      try {
        const sent = await YeboPayClient.sendInvoice(invoice.id);
        invoicePdfUrl = sent.pdf_url ?? null;
      } catch (err) {
        // Don't block checkout on email failure — log + continue.
        console.warn('[Billing] invoice email send failed:', err instanceof Error ? err.message : err);
      }
    }

    return {
      checkoutId: checkout.id,
      url: checkout.hosted_url,
      expiresAt: checkout.expires_at,
      status: checkout.status,
      invoiceId: invoice?.id ?? null,
      invoiceNumber: invoice?.number ?? null,
      invoicePdfUrl,
    };
  }

  // Status confirmation on the success-URL redirect. Frontend stashes
  // checkoutId before redirect, reads it back from sessionStorage on the
  // success page, and POSTs it here together with the tier.
  // Webhook-driven confirmation (Phase 3 yebopay outbound webhooks) will
  // arrive later and is the preferred path; this polling stays as a fallback.
  static async confirmCheckout(opts: { shopId: string; checkoutId: string; tier: ShopTier }) {
    const checkout = await YeboPayClient.getCheckout(opts.checkoutId);

    if (checkout.status !== 'COMPLETED') {
      return { activated: false, status: checkout.status, chargeId: checkout.charge_id ?? null };
    }

    const now = new Date();
    const expiry = new Date(now.getTime() + SUBSCRIPTION_PERIOD_MS);

    await prisma.shop.update({
      where: { id: opts.shopId },
      data: {
        tier: opts.tier,
        licenseExpiry: expiry,
      },
    });

    return {
      activated: true,
      status: 'COMPLETED' as const,
      chargeId: checkout.charge_id ?? null,
      tier: opts.tier,
      licenseExpiry: expiry.toISOString(),
    };
  }
}
