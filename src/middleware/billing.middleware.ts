/**
 * Billing middleware — pay-as-you-go credits.
 *
 * Replaces the legacy license.middleware.ts which gated by subscription tier.
 * The tier concept is gone; every shop has equal feature access. Cost recovery
 * happens per-action through credit deductions from the shop's yebopay wallet.
 */

import type { Response, NextFunction } from 'express';
import type { AuthRequest } from './auth.middleware';
import { ApiResponse } from '@utils/ApiResponse';
import { prisma } from '@config/prisma';

/**
 * Pending charge stashed on the request by `requireCreditBalance`, settled by
 * `settlePendingCharge` AFTER the handler succeeds.
 */
export interface PendingCharge {
  amount: number;
  description: string;
}

/**
 * Gate a billable action on the shop having enough credits, WITHOUT debiting.
 *
 * WHY this is a gate and not a charge: the wallet has no refund endpoint, so a
 * pre-charge that runs before the handler would bill the shop even when the
 * downstream call (e.g. a Gemini AI request) fails — there'd be no way to give
 * the credit back. Instead we:
 *   1. here: verify `balance.available >= amount` and 402 if not (no debit);
 *   2. stash a PendingCharge on the request;
 *   3. the handler calls `settlePendingCharge(req)` ONLY after it has produced a
 *      successful result, which is when the debit actually happens.
 * The shop is therefore never charged for a failed call. See ai.routes.ts.
 *
 * Usage:
 *   router.get('/ai/insights',
 *     authMiddleware,
 *     requireCreditBalance(CREDIT_COSTS.AI_FLASH, 'AI assistant (Flash)'),
 *     handler);   // handler must `await settlePendingCharge(req)` on success
 */
export const requireCreditBalance = (amount: number, description: string) => {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Authentication required');
        return;
      }

      const { BillingService } = await import('@services/billing.service');
      const balance = await BillingService.getShopBalance(req.user.shopId);

      if (balance.available < amount) {
        res.status(402).json({
          success: false,
          error: `Insufficient credits. This action costs ${amount} credits.`,
          code: 'INSUFFICIENT_CREDITS',
          cost: amount,
        });
        return;
      }

      const pending: PendingCharge = { amount, description };
      (req as any).pendingCharge = pending;
      next();
    } catch (err) {
      console.error('[Billing] requireCreditBalance failed:', err instanceof Error ? err.message : err);
      ApiResponse.serverError(res, 'Failed to verify credits');
    }
  };
};

/**
 * Settle the PendingCharge stashed by `requireCreditBalance` — call this ONLY
 * after the handler has successfully produced its result. This is the actual
 * wallet debit, deferred to post-success so the shop is never billed for work
 * it didn't get.
 *
 * If the charge itself fails here (e.g. the balance dropped in a race since the
 * pre-check, or yebopay is momentarily down) we DO NOT fail the request — the
 * customer already has their result, and per the post-success billing model we
 * err toward not charging rather than charging for nothing. The failure is
 * logged loudly for ops (never silently swallowed). Idempotency on a (shop,
 * route, ~10s) key means a client retry can't double-charge.
 */
export async function settlePendingCharge(req: AuthRequest): Promise<void> {
  const pending = (req as any).pendingCharge as PendingCharge | undefined;
  if (!pending || !req.user) return;
  // Guard against an accidental second settle on the same request.
  (req as any).pendingCharge = undefined;

  try {
    const { BillingService } = await import('@services/billing.service');
    await BillingService.chargeShopCredits({
      shopId: req.user.shopId,
      amount: pending.amount,
      description: pending.description,
      idempotencyKey: `${req.user.shopId}:${req.originalUrl}:${Math.floor(Date.now() / 10000)}`,
    });
  } catch (err) {
    console.error(
      '[Billing] settlePendingCharge failed AFTER a successful response (customer NOT charged):',
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Usage counter — analytics only, not billing. Tracks per-shop monthly
 * transaction or stock-move volume; useful for dashboards + ops insight.
 * Failures are swallowed so analytics writes can't break the request.
 */
export const trackUsage = (type: 'transaction' | 'stockMove') => {
  return async (req: AuthRequest, _res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      next();
      return;
    }
    prisma.shop
      .update({
        where: { id: req.user.shopId },
        data: {
          [type === 'transaction' ? 'monthlyTransactions' : 'monthlyStockMoves']: { increment: 1 },
        },
      })
      .catch(console.error);
    next();
  };
};
