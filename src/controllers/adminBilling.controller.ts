/**
 * Admin billing — the operator's view of (and lever on) a shop's credit wallet.
 *
 * yebomart is pay-as-you-go: the balance and its ledger live in yebopay, keyed
 * on Shop.ownerYeboidSub. yebomart stores no balance column. So these handlers
 * are mostly a proxy — except the adjustment audit trail (CreditAdjustment),
 * which is yebomart's own, because yebopay has no concept of a yebomart Admin.
 *
 * Role split: any authenticated admin (incl. SUPPORT) may READ billing — that's
 * the whole point of making tickets actionable. Only ADMIN/SUPER_ADMIN may
 * MOVE money (`requireAdminWrite` in admin.routes.ts).
 */

import { Response } from 'express';
import Joi from 'joi';
import { prisma } from '@config/prisma';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';
import { BillingService } from '@services/billing.service';
import { YeboPayAdjustmentError } from '@services/yebopay.client';

// Mirrors the ceiling yebopay enforces, so an over-large amount is rejected
// here with a clear message instead of bouncing off the remote API.
const MAX_ABS_ADJUSTMENT = 100_000;

export const adjustCreditsSchema = Joi.object({
  // Signed: positive grants, negative claws back. Zero is meaningless.
  amount: Joi.number()
    .required()
    .invalid(0)
    .min(-MAX_ABS_ADJUSTMENT)
    .max(MAX_ABS_ADJUSTMENT)
    .messages({
      'any.invalid': 'amount must not be zero',
      'number.min': `amount must be at least -${MAX_ABS_ADJUSTMENT}`,
      'number.max': `amount must be at most ${MAX_ABS_ADJUSTMENT}`,
    }),
  type: Joi.string().valid('GOODWILL', 'REFUND', 'CORRECTION').required(),
  reason: Joi.string().trim().min(3).max(500).required().messages({
    'string.min': 'reason must be at least 3 characters — adjustments must be auditable',
  }),
});

export const billingQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(200).default(50),
  offset: Joi.number().integer().min(0).default(0),
});

export class AdminBillingController {
  /**
   * GET /api/admin/shops/:id/billing
   *
   * Returns the shop's wallet balance, its yebopay ledger page, and yebomart's
   * local adjustment audit trail.
   *
   * On a yebopay outage this responds 200 with `balance: null`, `ledger: null`
   * and a NON-NULL `walletError`. That is a deliberate, explicit partial — not
   * a silent fallback: the client MUST render walletError as a failure. We do
   * it this way (rather than failing the whole request) because the local audit
   * trail is often exactly what an operator needs while yebopay is down, and
   * fabricating a zero balance would be far worse than reporting the outage.
   */
  static async getShopBilling(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { limit, offset } = req.query as unknown as { limit: number; offset: number };

      const shop = await prisma.shop.findUnique({
        where: { id },
        select: { id: true, name: true, currency: true, currencySymbol: true, status: true },
      });
      if (!shop) {
        ApiResponse.notFound(res, 'Shop not found');
        return;
      }

      // Local audit trail — always available, independent of yebopay.
      const adjustments = await BillingService.getShopAdjustments(id, { limit: 50 });

      let balance: { available: number; currency: string } | null = null;
      let ledger: Awaited<ReturnType<typeof BillingService.getShopLedger>> | null = null;
      let walletError: string | null = null;

      try {
        [balance, ledger] = await Promise.all([
          BillingService.getShopBalance(id),
          BillingService.getShopLedger(id, { limit, offset }),
        ]);
      } catch (error: any) {
        walletError = error?.message || 'Failed to reach yebopay';
        console.error(`[AdminBilling] Wallet lookup failed for shop ${id}:`, walletError);
      }

      ApiResponse.success(res, { shop, balance, ledger, adjustments, walletError });
    } catch (error) {
      console.error('Admin get shop billing error:', error);
      ApiResponse.error(res, 'Failed to fetch shop billing');
    }
  }

  /**
   * POST /api/admin/shops/:id/billing/adjust
   *
   * Manually credit (positive amount) or claw back (negative amount) a shop's
   * credits. Every call writes a CreditAdjustment audit row — including ones
   * that fail, so an unresolved ticket leaves a trace rather than vanishing.
   */
  static async adjustShopCredits(req: AuthRequest, res: Response): Promise<void> {
    const { id } = req.params;
    const { amount, type, reason } = req.body as {
      amount: number;
      type: 'GOODWILL' | 'REFUND' | 'CORRECTION';
      reason: string;
    };

    try {
      const adminId = req.user?.id;
      if (!adminId) {
        ApiResponse.unauthorized(res, 'Admin access required');
        return;
      }

      const shop = await prisma.shop.findUnique({ where: { id }, select: { id: true } });
      if (!shop) {
        ApiResponse.notFound(res, 'Shop not found');
        return;
      }

      // Read the admin's email from the DB rather than the JWT: admin tokens
      // live 24h, so a token minted before a profile change carries a stale
      // email — and an audit row must name the account as it actually is.
      const admin = await prisma.admin.findUnique({
        where: { id: adminId },
        select: { email: true },
      });
      if (!admin) {
        ApiResponse.unauthorized(res, 'Admin account not found');
        return;
      }

      const result = await BillingService.adjustShopCredits({
        shopId: id,
        amount,
        type,
        reason,
        adminId,
        adminEmail: admin.email,
      });

      ApiResponse.success(
        res,
        result,
        `${amount > 0 ? 'Credited' : 'Debited'} ${Math.abs(amount)} credits`
      );
    } catch (error: any) {
      // yebopay rejected it for a reason the operator can act on (over-debit,
      // no wallet, missing wallet.write scope). Echo its status + code faithfully
      // instead of flattening everything to a 500.
      if (error instanceof YeboPayAdjustmentError) {
        ApiResponse.error(res, error.message, error.httpStatus, undefined, {
          code: error.code,
          meta: { shopId: id, amount },
        });
        return;
      }
      console.error('Admin adjust shop credits error:', error);
      // The wallet did NOT move. 502 makes it unambiguous that this is an
      // upstream failure, and the FAILED audit row records why.
      ApiResponse.error(res, error?.message || 'Failed to apply credit adjustment', 502, undefined, {
        code: 'ADJUSTMENT_FAILED',
      });
    }
  }
}
