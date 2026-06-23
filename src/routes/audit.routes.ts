import { Router } from 'express';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest, ownerAuth } from '@middleware/auth.middleware';
import { AuditService } from '@services/audit.service';

const router = Router();

// Audit logs are available to all shops (pay-as-you-go; owner-only access).
router.use(ownerAuth);

router.get('/', async (req: AuthRequest, res) => {
  try {
    if (!req.user) {
      ApiResponse.unauthorized(res, 'Unauthorized');
      return;
    }

    const { page, limit, userId, action, startDate, endDate } = req.query as any;

    const result = await AuditService.getLogs(req.user.shopId, {
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      userId: userId || undefined,
      action: action || undefined,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
    });

    ApiResponse.success(res, result);
  } catch (error: any) {
    ApiResponse.serverError(res, error.message);
  }
});

export default router;
