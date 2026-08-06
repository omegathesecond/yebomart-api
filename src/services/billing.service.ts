import { prisma } from '@config/prisma';
import { YeboPayClient, YeboPayChargeError, YeboPayAdjustmentError } from './yebopay.client';
import { CREDIT_PACKS, findPack, type CreditPack } from '@config/creditPacks';
import type { CreditAdjustmentType } from '@prisma/client';

/**
 * Get the shop owner's YeboID UUID. This is what yebopay keys wallets on,
 * so cross-product credits unify under one real identity. Throws if the
 * shop has no owner — should never happen given the schema's @unique
 * constraint on ownerYeboidSub.
 */
export async function getShopOwnerYeboidSub(shopId: string): Promise<string> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { ownerYeboidSub: true },
  });
  if (!shop) throw new Error(`Shop not found: ${shopId}`);
  return shop.ownerYeboidSub;
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
    const yeboidSub = await getShopOwnerYeboidSub(shopId);
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
    const yeboidSub = await getShopOwnerYeboidSub(opts.shopId);
    return YeboPayClient.chargeWallet({
      yeboidSub,
      amount: opts.amount,
      description: opts.description,
      idempotencyKey: opts.idempotencyKey,
      metadata: { shopId: opts.shopId, ...(opts.metadata ?? {}) },
    });
  }

  /**
   * The shop's wallet ledger — the rows behind the balance. Support needs this
   * to answer "where did my credits go" and "did my top-up land".
   * Errors propagate (no silent fallback).
   */
  static async getShopLedger(
    shopId: string,
    opts: { limit?: number; offset?: number } = {}
  ) {
    const yeboidSub = await getShopOwnerYeboidSub(shopId);
    return YeboPayClient.getWalletTransactions(yeboidSub, opts);
  }

  /**
   * Apply a manual, admin-authorised credit adjustment to a shop's wallet.
   *
   * Two-phase on purpose:
   *   1. Write the local CreditAdjustment row FIRST, status=PENDING. Its id is
   *      then passed to yebopay as `external_ref`.
   *   2. Call yebopay. On success mark APPLIED and record the ledger txn id +
   *      resulting balance; on failure mark FAILED with the reason and rethrow.
   *
   * Phase 1 before phase 2 is what makes this safe to retry: the external_ref
   * is stable, so if the network drops after yebopay committed, a retry replays
   * the same ledger row rather than crediting twice. It also means a call that
   * never landed leaves a FAILED row behind — visible evidence for the ticket,
   * instead of a silent no-op.
   *
   * NOTE: the local row is never deleted on failure. An audit trail that erases
   * its own failed attempts isn't an audit trail.
   */
  static async adjustShopCredits(opts: {
    shopId: string;
    /** SIGNED: positive grants credits, negative claws them back. Never zero. */
    amount: number;
    type: CreditAdjustmentType;
    reason: string;
    adminId: string;
    adminEmail: string;
  }) {
    const yeboidSub = await getShopOwnerYeboidSub(opts.shopId);

    const adjustment = await prisma.creditAdjustment.create({
      data: {
        shopId: opts.shopId,
        amount: opts.amount,
        type: opts.type,
        reason: opts.reason,
        adminId: opts.adminId,
        adminEmail: opts.adminEmail,
        status: 'PENDING',
      },
    });

    try {
      const result = await YeboPayClient.adjustWallet({
        yeboidSub,
        amount: opts.amount,
        reason: opts.reason,
        actor: opts.adminEmail,
        externalRef: adjustment.id,
        metadata: {
          shopId: opts.shopId,
          adjustmentId: adjustment.id,
          adjustmentType: opts.type,
        },
      });

      const applied = await prisma.creditAdjustment.update({
        where: { id: adjustment.id },
        data: {
          status: 'APPLIED',
          yebopayTxnId: result.transaction.id,
          balanceAfter: result.balance.available,
        },
      });

      return { adjustment: applied, balance: result.balance, replayed: result.replayed };
    } catch (error: any) {
      const failureReason =
        error instanceof YeboPayAdjustmentError
          ? `${error.code}: ${error.message}`
          : error?.message || 'Unknown error calling yebopay';

      // Record the failure, then rethrow — the operator must SEE that the
      // balance did not move, never be told it worked.
      await prisma.creditAdjustment.update({
        where: { id: adjustment.id },
        data: { status: 'FAILED', failureReason },
      });

      console.error(
        `[Billing] Credit adjustment ${adjustment.id} FAILED for shop ${opts.shopId}:`,
        failureReason
      );
      throw error;
    }
  }

  /** Local audit history of admin adjustments for a shop, newest first. */
  static async getShopAdjustments(shopId: string, opts: { limit?: number } = {}) {
    return prisma.creditAdjustment.findMany({
      where: { shopId },
      orderBy: { createdAt: 'desc' },
      take: opts.limit ?? 50,
    });
  }

  /**
   * Create a top-up checkout for the given credit pack (or a custom amount).
   * Returns the yebopay-hosted checkout URL. On payment success, yebopay's
   * webhook handler reads checkout.metadata.credit_amount and credits the
   * wallet automatically.
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

    const yeboidSub = await getShopOwnerYeboidSub(opts.shopId);
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
