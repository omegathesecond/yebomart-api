/**
 * Internal, machine-only routes. NOT for browsers/users — gated by a shared
 * secret (X-Internal-Secret) rather than the YeboID/staff auth middleware.
 * Currently hosts the daily notification run fired by Cloud Scheduler.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { NotificationController, runNotificationsSchema } from '@controllers/notification.controller';
import { validateRequest } from '@middleware/validation.middleware';
import { ApiResponse } from '@utils/ApiResponse';

const router = Router();

/**
 * Shared-secret guard. The secret lives in INTERNAL_NOTIFICATIONS_SECRET
 * (Secret Manager → Cloud Run env) and is sent by Cloud Scheduler in the
 * X-Internal-Secret header. Missing env = misconfiguration → fail loud (500),
 * never silently allow.
 */
function internalSecretAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.INTERNAL_NOTIFICATIONS_SECRET;
  if (!expected) {
    ApiResponse.serverError(res, 'INTERNAL_NOTIFICATIONS_SECRET is not configured');
    return;
  }

  const provided = req.header('X-Internal-Secret') ?? '';
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  // Constant-time compare; length mismatch is an immediate reject.
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    ApiResponse.unauthorized(res, 'Invalid internal secret');
    return;
  }

  next();
}

router.use(internalSecretAuth);

router.post(
  '/notifications/run',
  validateRequest(runNotificationsSchema),
  NotificationController.run,
);

export default router;
