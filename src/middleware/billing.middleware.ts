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
 * Pre-charge a fixed credit amount BEFORE the wrapped handler runs. On
 * insufficient balance, returns 402 with the cost so the frontend can route
 * the user to /billing/topup.
 *
 * Usage:
 *   router.post('/ai/query',
 *     authMiddleware,
 *     requireCredits(CREDIT_COSTS.AI_FLASH, 'AI assistant (Flash)'),
 *     handler);
 */
export const requireCredits = (amount: number, description: string) => {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Authentication required');
        return;
      }

      const { BillingService } = await import('@services/billing.service');
      const { YeboPayChargeError } = await import('@services/yebopay.client');

      try {
        const charge = await BillingService.chargeShopCredits({
          shopId: req.user.shopId,
          amount,
          description,
          // Idempotency on a per-request basis: (shop, route, ~10s window).
          // Accidental double-submits within the window don't double-charge.
          idempotencyKey: `${req.user.shopId}:${req.originalUrl}:${Math.floor(Date.now() / 10000)}`,
        });
        (req as any).creditCharge = charge;

        // Attach a fresh balance hint for the frontend.
        const balance = await BillingService.getShopBalance(req.user.shopId).catch(() => null);
        if (balance) (req as any).creditBalance = balance;

        next();
      } catch (err) {
        if (err instanceof YeboPayChargeError && err.code === 'INSUFFICIENT_BALANCE') {
          res.status(402).json({
            success: false,
            error: `Insufficient credits. This action costs ${amount} credits.`,
            code: 'INSUFFICIENT_CREDITS',
            cost: amount,
          });
          return;
        }
        throw err;
      }
    } catch (err) {
      console.error('[Billing] requireCredits failed:', err instanceof Error ? err.message : err);
      ApiResponse.serverError(res, 'Failed to charge credits');
    }
  };
};

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
