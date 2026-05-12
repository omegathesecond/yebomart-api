import crypto from 'node:crypto';
import { prisma } from '@config/prisma';
import { YeboPayClient, YeboPayChargeError } from './yebopay.client';
import { CREDIT_PACKS, findPack, type CreditPack } from '@config/creditPacks';

// Synthetic YeboID UUID derived from shopId via SHA-256 → UUID format.
// Yebomart shops aren't YeboID-linked yet; this gives each shop a stable
// yebopay wallet that survives shop-owner changes. Replace with the real
// owner's yeboid_sub once shop accounts are linked to YeboID.
export function shopIdToYeboidSub(shopId: string): string {
  const hash = crypto.createHash('sha256').update(`yebomart-shop:${shopId}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

export class BillingService {
  /**
   * Lists available credit packs (the new "plans" — no subscription tiers).
   * The frontend renders these on the top-up page.
   */
  static getCreditPacks() {
    return CREDIT_PACKS;
  }

  /**
   * Returns the shop's current credit balance from yebopay.
   * Errors propagate (no silent fallback).
   */
  static async getShopBalance(shopId: string): Promise<{ available: number; currency: string }> {
    const yeboidSub = shopIdToYeboidSub(shopId);
    const balance = await YeboPayClient.getBalance(yeboidSub);
    return { available: balance.available, currency: balance.currency };
  }

  /**
   * Charge the shop's wallet for a billable action (AI query, message send).
   * Throws YeboPayChargeError with code='INSUFFICIENT_BALANCE' on 402 — route
   * handlers map this to a 402 user-facing response with a "Top up" prompt.
   */
  static async chargeShopCredits(opts: {
    shopId: string;
    amount: number;
    description: string;
    idempotencyKey?: string;
    metadata?: Record<string, unknown>;
  }) {
    return YeboPayClient.chargeWallet({
      yeboidSub: shopIdToYeboidSub(opts.shopId),
      amount: opts.amount,
      description: opts.description,
      idempotencyKey: opts.idempotencyKey,
      metadata: { shopId: opts.shopId, ...(opts.metadata ?? {}) },
    });
  }

  /**
   * Create a top-up checkout for the given credit pack (or a custom amount).
   * Returns the yebopay-hosted Stripe Checkout URL. On payment success,
   * yebopay's webhook handler reads checkout.metadata.credit_amount and
   * credits the wallet automatically.
   */
  static async createTopUpCheckout(opts: {
    shopId: string;
    shopEmail?: string;
    packId?: string;
    customAmountSzl?: number;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey?: string;
  }) {
    // Resolve pack OR custom amount → (priceSzl, creditAmount).
    let priceSzl: number;
    let credits: number;
    let packLabel: string;

    if (opts.packId) {
      const pack = findPack(opts.packId);
      if (!pack) throw new Error(`Unknown credit pack: ${opts.packId}`);
      priceSzl = pack.priceSzl;
      credits = pack.credits;
      packLabel = pack.id;
    } else if (typeof opts.customAmountSzl === 'number' && opts.customAmountSzl >= 10) {
      // Custom top-up: 1:1, no bonus.
      priceSzl = Math.round(opts.customAmountSzl);
      credits = priceSzl;
      packLabel = 'CUSTOM';
    } else {
      throw new Error('Either packId or customAmountSzl (>=10) is required');
    }

    const yeboidSub = shopIdToYeboidSub(opts.shopId);
    const checkout = await YeboPayClient.createCheckout({
      amount: priceSzl,
      currency: 'SZL',
      yeboidSub,
      paymentMethod: 'CARD',
      successUrl: opts.successUrl,
      cancelUrl: opts.cancelUrl,
      description: `Top up ${credits} credits for shop ${opts.shopId}`,
      email: opts.shopEmail,
      // credit_amount is the key yebopay's webhook handler reads to credit
      // the wallet. Without it, the checkout would record a payment but
      // never deliver credits.
      metadata: {
        credit_amount: String(credits),
        credit_pack: packLabel,
        shopId: opts.shopId,
        flow: 'yebomart-credit-topup',
      },
      idempotencyKey: opts.idempotencyKey,
    });

    return {
      checkoutId: checkout.id,
      url: checkout.hosted_url,
      expiresAt: checkout.expires_at,
      status: checkout.status,
      pack: packLabel,
      priceSzl,
      credits,
    };
  }

  /**
   * Verify a top-up checkout completed. Called from the success-URL redirect
   * flow. Yebopay's webhook will have already credited the wallet by the time
   * this runs (or it will shortly); this endpoint returns the current balance
   * so the frontend can show "+500 credits, new balance: 1245".
   */
  static async confirmTopUp(opts: { shopId: string; checkoutId: string }) {
    const checkout = await YeboPayClient.getCheckout(opts.checkoutId);
    const balance = await BillingService.getShopBalance(opts.shopId);
    return {
      completed: checkout.status === 'COMPLETED',
      status: checkout.status,
      chargeId: checkout.charge_id ?? null,
      balance,
    };
  }
}

export type { CreditPack };
