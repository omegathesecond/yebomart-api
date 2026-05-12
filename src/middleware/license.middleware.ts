import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth.middleware';
import { LicenseService } from '@services/license.service';
import { ApiResponse } from '@utils/ApiResponse';
import { prisma } from '@config/prisma';

/**
 * Pay-as-you-go: tier-based feature gating is DELETED.
 * All features are available to every shop. Billable actions deduct credits
 * from the shop's yebopay wallet via BillingService.chargeShopCredits().
 *
 * These middleware functions remain as no-ops to avoid breaking imports in
 * routes that haven't been touched yet — they call next() unconditionally.
 * Once all routes are audited, the require* exports can be deleted entirely.
 */

export const requireFeature = (_feature: string) => {
  return async (_req: AuthRequest, _res: Response, next: NextFunction): Promise<void> => {
    next();
  };
};

export const requirePro = requireFeature('unlimited_products');
export const requireBusiness = requireFeature('advanced_analytics');

/**
 * Pay-as-you-go: product + user limits are GONE. All shops can add unlimited
 * products and staff. The cost-recovery path is per-action credit charging
 * (AI queries, comms sends), not arbitrary count caps. These functions stay
 * as no-ops to avoid breaking imports until callers migrate.
 */
export const checkProductLimit = async (_req: AuthRequest, _res: Response, next: NextFunction): Promise<void> => {
  next();
};

export const checkUserLimit = async (_req: AuthRequest, _res: Response, next: NextFunction): Promise<void> => {
  next();
};

/**
 * Pay-as-you-go AI charging.
 *
 * Pre-charges the shop's yebopay wallet BEFORE the AI handler runs. If the
 * balance is insufficient, returns 402 with a "Top up to continue" hint;
 * frontend routes the user to /billing/topup.
 *
 * Usage: `router.post('/ai/query', authMiddleware, requireCredits(CREDIT_COSTS.AI_FLASH, 'AI assistant (Flash)'), handler)`
 *
 * Credit costs by model: import from `@config/creditPacks` CREDIT_COSTS.
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
          // Idempotency on a per-request basis: hash of (shop, route, time-window)
          // so accidental double-submits within ~10s don't double-charge.
          idempotencyKey: `${req.user.shopId}:${req.originalUrl}:${Math.floor(Date.now() / 10000)}`,
        });
        (req as any).creditCharge = charge;

        // Attach an updated balance hint for the frontend.
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
 * Legacy: AI usage tracking via tier limits.
 * Replaced by requireCredits. Kept as a no-op shim for route imports until
 * all callers are migrated.
 */
export const checkAiUsage = async (_req: AuthRequest, _res: Response, next: NextFunction): Promise<void> => {
  next();
};

/**
 * Track monthly usage
 */
export const trackUsage = (type: 'transaction' | 'stockMove') => {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        next();
        return;
      }

      // Update usage counter in background (don't block request)
      prisma.shop.update({
        where: { id: req.user.shopId },
        data: {
          [type === 'transaction' ? 'monthlyTransactions' : 'monthlyStockMoves']: {
            increment: 1,
          },
        },
      }).catch(console.error);

      next();
    } catch (error) {
      next();
    }
  };
};
