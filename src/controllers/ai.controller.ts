import { Response } from 'express';
import Joi from 'joi';
import { AIService } from '@services/ai.service';
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
   * Chat with AI assistant
   */
  static async chat(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { message } = req.body;
      const result = await AIService.chat({
        shopId: req.user.shopId,
        message,
      });

      ApiResponse.success(res, result);
    } catch (error: any) {
      if (error.message.includes('not configured')) {
        ApiResponse.badRequest(res, 'AI service is not available');
      } else {
        ApiResponse.serverError(res, error.message, error);
      }
    }
  }

  /**
   * Process voice query
   */
  static async voice(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { transcription } = req.body;
      const result = await AIService.voice(req.user.shopId, transcription);

      ApiResponse.success(res, result);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Get AI-generated insights
   */
  static async getInsights(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const insights = await AIService.generateInsights({
        shopId: req.user.shopId,
      });

      ApiResponse.success(res, insights);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
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
