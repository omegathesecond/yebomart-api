import Stripe from 'stripe';
import { prisma } from '@config/prisma';
import { ShopTier } from '@prisma/client';
import { COUNTRY_PRICING, getPricingForCountry, getActiveTierPrice } from '@config/pricing';
import { getCurrencyForCountry } from '@utils/currencies';

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-11-20.acacia' as any })
  : null;

const TIER_NAMES: Record<string, string> = {
  LITE: 'Lite',
  STARTER: 'Starter',
  BUSINESS: 'Business',
  PRO: 'Pro',
  ENTERPRISE: 'Enterprise',
};

export class BillingService {
  static getMode(): 'live' | 'test' {
    return (process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live_') ? 'live' : 'test';
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
  }) {
    if (!stripe) throw new Error('Stripe not configured');

    const pricing = getPricingForCountry(opts.countryCode);
    const activePrice = getActiveTierPrice(opts.countryCode, opts.tier);
    const currency = getCurrencyForCountry(opts.countryCode);
    const chargeCurrency = currency.stripeSupported ? currency : { code: 'USD', rate: 1, decimals: 100 };

    // Convert local price to stripe amount
    // activePrice is already in local currency units (e.g. 499 SZL)
    // For stripe-supported currencies, send as smallest unit
    // For non-supported, convert to USD cents
    let amount: number;
    if (currency.stripeSupported) {
      amount = Math.round(activePrice * (currency.decimals === 1 ? 1 : 100));
    } else {
      // Fallback: convert using rate
      const usdAmount = activePrice / currency.rate;
      amount = Math.round(usdAmount * 100);
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: opts.shopEmail || undefined,
      line_items: [
        {
          price_data: {
            currency: chargeCurrency.code.toLowerCase(),
            product_data: {
              name: `YeboMart ${TIER_NAMES[opts.tier]} Plan`,
              description: `Monthly subscription — ${pricing.currencySymbol}${activePrice.toLocaleString()}`,
            },
            unit_amount: amount,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: opts.successUrl,
      cancel_url: opts.cancelUrl,
      client_reference_id: opts.shopId,
      metadata: {
        shopId: opts.shopId,
        tier: opts.tier,
        countryCode: opts.countryCode,
      },
    });

    return { sessionId: session.id, url: session.url! };
  }

  static async handleWebhookEvent(payload: Buffer, signature: string) {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
      throw new Error('Stripe webhook not configured');
    }

    const event = stripe.webhooks.constructEvent(payload, signature, process.env.STRIPE_WEBHOOK_SECRET);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const shopId = session.client_reference_id;
      const tier = session.metadata?.tier as ShopTier;

      if (shopId && tier) {
        const now = new Date();
        const expiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        await prisma.shop.update({
          where: { id: shopId },
          data: {
            tier,
            licenseExpiry: expiry,
          },
        });

        console.log(`[Billing] Shop ${shopId} upgraded to ${tier}, expires ${expiry.toISOString()}`);
      }
    }

    return { received: true, type: event.type };
  }
}
