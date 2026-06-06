import { Request, Response } from 'express';
import Joi from 'joi';
import { NotificationService } from '@services/notification.service';
import { ApiResponse } from '@utils/ApiResponse';

export const runNotificationsSchema = Joi.object({
  // Optional override for backfills / manual runs; defaults to "now".
  date: Joi.date().optional(),
});

export class NotificationController {
  /**
   * POST /api/internal/notifications/run
   *
   * Fired by Cloud Scheduler (shared-secret gated, NOT a user route). Runs the
   * daily WhatsApp report + low-stock pass across all opted-in shops and returns
   * a per-run summary so the scheduler log / operator can see what happened.
   */
  static async run(req: Request, res: Response): Promise<void> {
    try {
      const date = req.body?.date ? new Date(req.body.date) : undefined;
      const summary = await NotificationService.runDailyNotifications(date);
      // 200 even with per-shop failures — the run itself succeeded; failures are
      // surfaced in the summary (and already logged loudly).
      ApiResponse.success(res, summary, 'Notification run complete');
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }
}
