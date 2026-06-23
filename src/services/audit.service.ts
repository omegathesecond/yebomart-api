import { prisma } from '@config/prisma';
import type { AuthRequest } from '@middleware/auth.middleware';

export type AuditAction =
  | 'LOGIN' | 'LOGOUT'
  | 'PRODUCT_CREATE' | 'PRODUCT_UPDATE' | 'PRODUCT_DELETE'
  | 'PRICE_CHANGE'
  | 'SALE_CREATE' | 'SALE_VOID'
  | 'STOCK_ADJUST' | 'STOCK_RECEIVE'
  | 'CUSTOMER_CREATE' | 'CUSTOMER_UPDATE' | 'CUSTOMER_DELETE'
  | 'CREDIT_ADD'
  | 'USER_CREATE' | 'USER_UPDATE' | 'USER_DELETE' | 'STAFF_PIN_CHANGE'
  | 'EXPENSE_CREATE' | 'EXPENSE_DELETE'
  | 'SETTINGS_UPDATE' | 'LICENSE_APPLY';

/**
 * Who performed an action. Built once per request via {@link auditContext} and
 * spread into every {@link AuditService.log} call so controllers stay DRY.
 *
 * userId is null for shop OWNERs (they authenticate via YeboID and have no User
 * row); actorRole/actorName keep the action attributable regardless.
 */
export interface AuditActor {
  shopId: string;
  userId: string | null;
  actorRole: string | null;
  actorName: string | null;
  ipAddress?: string;
}

interface AuditLogEntry extends AuditActor {
  action: AuditAction;
  entityType: string;
  entityId?: string;
  details?: Record<string, any>;
}

/**
 * Derive the actor context from an authenticated request. Returns null if the
 * request isn't authenticated (caller should skip logging — never fabricate an
 * actor). Staff (type === 'user') carry a real User id; owners do not, so their
 * userId is null and identity is preserved in actorRole/actorName.
 */
export function auditContext(req: AuthRequest): AuditActor | null {
  if (!req.user) return null;
  const isStaff = req.user.type === 'user';
  return {
    shopId: req.user.shopId,
    userId: isStaff ? req.user.id : null,
    actorRole: req.user.role ?? null,
    actorName: req.user.phone ?? req.user.email ?? (isStaff ? 'Staff' : 'Owner'),
    ipAddress: req.ip,
  };
}

export class AuditService {
  /**
   * Log a mutating action. Fire-and-forget: a failed audit write must never
   * break the business operation it records, so errors are swallowed (and
   * logged to the server console for ops). This is the ONE acceptable
   * silent-failure carve-out — audit is non-vital telemetry around an action
   * that has already succeeded.
   */
  static async log(entry: AuditLogEntry): Promise<void> {
    try {
      await prisma.auditLog.create({
        data: {
          shopId: entry.shopId,
          userId: entry.userId,
          actorRole: entry.actorRole,
          actorName: entry.actorName,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId ?? null,
          details: entry.details ?? {},
          ipAddress: entry.ipAddress ?? null,
        },
      });
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
