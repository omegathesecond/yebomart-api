import { Response } from 'express';
import Joi from 'joi';
import { AIService, AIUnavailableError } from '@services/ai.service';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';

export const chatSchema = Joi.object({
  message: Joi.string().required().min(1).max(1000),
});

export const voiceSchema = Joi.object({
  transcription: Joi.string().required().min(1).max(1000),
});

export class AIController {
  /**
   * Reverse the credits pre-charged by requireCredits() when the AI action
   * they paid for didn't produce output. requireCredits() debits the wallet
   * BEFORE the handler runs, so any failure past that point would otherwise
   * bill the shop for nothing. Returns whether the refund succeeded so the
   * caller can be honest in the user-facing message. A failed refund is logged
   * loudly (never swallowed) — it means a customer is wrongly billed and ops
   * must reconcile.
   */
  private static async refundPrecharge(req: AuthRequest, reason: string): Promise<boolean> {
    const charge = (req as any).creditCharge as { id?: string } | undefined;
    if (!charge?.id) return false;
    try {
      const { BillingService } = await import('@services/billing.service');
      await BillingService.refundShopCredits({ chargeId: charge.id, reason });
      return true;
    } catch (refundErr) {
      console.error(
        `[AI] CREDIT REFUND FAILED for charge ${charge.id} (shop ${req.user?.shopId}): ${
          refundErr instanceof Error ? refundErr.message : refundErr
        }`,
      );
      return false;
    }
  }

  /**
   * Chat with AI assistant
   */
  static async chat(req: AuthRequest, res: Response): Promise<void> {
    if (!req.user) {
      ApiResponse.unauthorized(res, 'Unauthorized');
      return;
    }

    try {
      const { message } = req.body;
      const result = await AIService.chat({
        shopId: req.user.shopId,
        message,
      });

      ApiResponse.success(res, result);
    } catch (error: any) {
      // Credits were pre-charged before the AI call; it failed, so reverse them.
      const refunded = await AIController.refundPrecharge(req, 'AI chat failed');
      const note = refunded ? ' You were not charged.' : '';
      if (error.message?.includes('not configured')) {
        ApiResponse.error(res, `AI service is not available.${note}`, 503, error, {
          code: 'AI_UNAVAILABLE',
          meta: { refunded },
        });
      } else {
        ApiResponse.error(res, `AI chat failed.${note} Please try again shortly.`, 500, error, {
          code: 'AI_CHAT_FAILED',
          meta: { refunded },
        });
      }
    }
  }

  /**
   * Process voice query
   */
  static async voice(req: AuthRequest, res: Response): Promise<void> {
    if (!req.user) {
      ApiResponse.unauthorized(res, 'Unauthorized');
      return;
    }

    try {
      const { transcription } = req.body;
      const result = await AIService.voice(req.user.shopId, transcription);

      ApiResponse.success(res, result);
    } catch (error: any) {
      // Credits were pre-charged before the AI call; it failed, so reverse them.
      const refunded = await AIController.refundPrecharge(req, 'AI voice query failed');
      const note = refunded ? ' You were not charged.' : '';
      ApiResponse.error(res, `AI voice query failed.${note} Please try again shortly.`, 500, error, {
        code: 'AI_VOICE_FAILED',
        meta: { refunded },
      });
    }
  }

  /**
   * Get AI-generated insights
   */
  static async getInsights(req: AuthRequest, res: Response): Promise<void> {
    if (!req.user) {
      ApiResponse.unauthorized(res, 'Unauthorized');
      return;
    }

    try {
      const insights = await AIService.generateInsights({
        shopId: req.user.shopId,
      });

      ApiResponse.success(res, insights);
    } catch (error: any) {
      // The shop was pre-charged AI credits by requireCredits() before this ran,
      // but no AI insight was produced — reverse the charge and fail loudly. We
      // never return canned offline text dressed up as a successful AI result.
      const refunded = await AIController.refundPrecharge(req, 'AI insights generation failed');
      const note = refunded ? ' You were not charged.' : '';
      const unavailable = error instanceof AIUnavailableError;
      ApiResponse.error(
        res,
        `AI insights are temporarily unavailable.${note} Please try again shortly.`,
        unavailable ? 503 : 500,
        error,
        { code: 'AI_INSIGHTS_UNAVAILABLE', meta: { refunded } },
      );
    }
  }

  /**
   * Get slow-moving products analysis
   */
  static async getSlowMovers(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const analysis = await AIService.getSlowMovers(req.user.shopId);
      ApiResponse.success(res, analysis);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Get business summary with actions
   */
  static async getSummary(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const summary = await AIService.getBusinessSummary(req.user.shopId);
      ApiResponse.success(res, summary);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }
}
