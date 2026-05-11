import { prisma } from '@config/prisma';
import { ShopTier } from '@prisma/client';
import { getPricingForCountry, getActiveTierPrice } from '@config/pricing';
import { getCurrencyForCountry } from '@utils/currencies';
import { YeboPayClient } from './yebopay.client';

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

    // Same logic as the pre-cutover code: send local-currency amount if the
    // currency is Stripe-supported, else convert to USD. YeboPay's gateway
    // expects a numeric amount (it'll do the cents conversion inside the
    // Stripe adapter), so we pass the human-readable unit value.
    let amount: number;
    let chargeCurrency: string;
    if (currency.stripeSupported) {
      amount = activePrice;
      chargeCurrency = currency.code;
    } else {
      amount = Math.round((activePrice / currency.rate) * 100) / 100;
      chargeCurrency = 'USD';
    }

    const checkout = await YeboPayClient.createCheckout({
      amount,
      currency: chargeCurrency,
      yeboidSub: null, // shop owners aren't YeboID-linked yet; guest checkout
      paymentMethod: 'CARD',
      successUrl: opts.successUrl,
      cancelUrl: opts.cancelUrl,
      description: `YeboMart ${TIER_NAMES[opts.tier]} Plan — monthly subscription`,
      email: opts.shopEmail,
      metadata: {
        shopId: opts.shopId,
        tier: opts.tier,
        countryCode: opts.countryCode,
        unitPriceLocal: String(activePrice),
        localCurrency: currency.code,
        localSymbol: pricing.currencySymbol,
      },
      idempotencyKey: opts.idempotencyKey,
    });

    return {
      checkoutId: checkout.id,
      url: checkout.hosted_url,
      expiresAt: checkout.expires_at,
      status: checkout.status,
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
