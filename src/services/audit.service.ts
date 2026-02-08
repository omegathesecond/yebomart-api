import crypto from 'crypto';
import { prisma } from '@config/prisma';

export type AuditAction = 
  | 'LOGIN' | 'LOGOUT'
  | 'PRODUCT_CREATE' | 'PRODUCT_UPDATE' | 'PRODUCT_DELETE'
  | 'SALE_CREATE' | 'SALE_VOID'
  | 'STOCK_ADJUST' | 'STOCK_RECEIVE'
  | 'USER_CREATE' | 'USER_UPDATE' | 'USER_DELETE'
  | 'EXPENSE_CREATE' | 'EXPENSE_DELETE'
  | 'SETTINGS_UPDATE' | 'LICENSE_APPLY';

interface AuditLogEntry {
  shopId: string;
  userId: string;
  action: AuditAction;
  entityType: string;
  entityId?: string;
  details?: Record<string, any>;
  ipAddress?: string;
}

export class AuditService {
  /**
   * Log an action (fire and forget)
   */
  static async log(entry: AuditLogEntry): Promise<void> {
    try {
      await prisma.$executeRaw`
        INSERT INTO "AuditLog" ("id", "shopId", "userId", "action", "entityType", "entityId", "details", "ipAddress", "createdAt")
        VALUES (${crypto.randomUUID()}, ${entry.shopId}, ${entry.userId}, ${entry.action}, ${entry.entityType}, ${entry.entityId || null}, ${JSON.stringify(entry.details || {})}, ${entry.ipAddress || null}, NOW())
      `;
    } catch (error) {
      console.error('Audit log failed:', error);
    }
  }

  /**
   * Get audit logs
   */
  static async getLogs(shopId: string, options: {
    page?: number;
    limit?: number;
    userId?: string;
    action?: string;
    startDate?: Date;
    endDate?: Date;
  } = {}) {
    const { page = 1, limit = 50 } = options;
    const skip = (page - 1) * limit;

    const where: any = { shopId };
    if (options.userId) where.userId = options.userId;
    if (options.action) where.action = options.action;
    if (options.startDate || options.endDate) {
      where.createdAt = {};
      if (options.startDate) where.createdAt.gte = options.startDate;
      if (options.endDate) where.createdAt.lte = options.endDate;
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { name: true, role: true } },
        },
      }),
      prisma.auditLog.count({ where }),
    ]);

    return {
      logs,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }
}
