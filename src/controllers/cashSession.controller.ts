import { Response } from 'express';
import Joi from 'joi';
import { CashSessionService } from '@services/cashSession.service';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';

// ==================== Validation schemas ====================

export const openCashSessionSchema = Joi.object({
  openingFloat: Joi.number().required().min(0),
});

export const closeCashSessionSchema = Joi.object({
  countedCash: Joi.number().required().min(0),
  notes: Joi.string().optional().max(1000),
});

export class CashSessionController {
  /**
   * Open a till for the authenticated shop with a starting float.
   * 409 if one is already open.
   */
  static async open(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const session = await CashSessionService.open({
        shopId: req.user.shopId,
        // Only staff (PIN) tokens map to a real User row; an owner token's id
        // is the Shop id, so leave the cashier null for it.
        userId: req.user.type === 'user' ? req.user.id : undefined,
        openingFloat: req.body.openingFloat,
      });

      ApiResponse.created(res, session, 'Till opened');
    } catch (error: any) {
      if (error.code === 'CONFLICT') {
        ApiResponse.conflict(res, error.message);
      } else {
        ApiResponse.serverError(res, error.message, error);
      }
    }
  }

  /**
   * The open session for this shop (or null) with a live cash-sales tally.
   */
  static async current(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const session = await CashSessionService.getCurrent(req.user.shopId);
      ApiResponse.success(res, session);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Cash up: close the session, compute expected vs counted, record variance.
   */
  static async close(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const session = await CashSessionService.close({
        sessionId: req.params.id,
        shopId: req.user.shopId,
        countedCash: req.body.countedCash,
        notes: req.body.notes,
      });

      ApiResponse.success(res, session, 'Till cashed up');
    } catch (error: any) {
      if (error.code === 'NOT_FOUND') {
        ApiResponse.notFound(res, error.message);
      } else if (error.code === 'CONFLICT') {
        ApiResponse.conflict(res, error.message);
      } else {
        ApiResponse.serverError(res, error.message, error);
      }
    }
  }

  /**
   * Z-report for a session: payment-method breakdown, counts, totals, variance.
   */
  static async zReport(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const report = await CashSessionService.zReport(req.params.id, req.user.shopId);
      ApiResponse.success(res, report);
    } catch (error: any) {
      if (error.code === 'NOT_FOUND') {
        ApiResponse.notFound(res, error.message);
      } else {
        ApiResponse.serverError(res, error.message, error);
      }
    }
  }
}
