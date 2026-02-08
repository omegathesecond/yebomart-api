import { Router } from 'express';
import { prisma } from '@config/prisma';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest, ownerAuth } from '@middleware/auth.middleware';
import { requireFeature } from '@middleware/license.middleware';

const router = Router();

// Audit logs require BUSINESS tier
router.use(ownerAuth);
router.use(requireFeature('advanced_analytics'));

router.get('/', async (req: AuthRequest, res) => {
  try {
    if (!req.user) {
      ApiResponse.unauthorized(res, 'Unauthorized');
      return;
    }

    const { page = 1, limit = 50, userId, action, startDate, endDate } = req.query as any;
    const skip = (page - 1) * limit;

    const where: any = { shopId: req.user.shopId };
    if (userId) where.userId = userId;
    if (action) where.action = action;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        skip,
        take: Number(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { name: true, role: true } },
        },
      }),
      prisma.auditLog.count({ where }),
    ]);

    ApiResponse.success(res, {
      logs,
      pagination: { page: Number(page), limit: Number(limit), total, pages: Math.ceil(total / Number(limit)) },
    });
  } catch (error: any) {
    ApiResponse.serverError(res, error.message);
  }
});

export default router;
