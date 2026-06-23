import { Response } from 'express';
import Joi from 'joi';
import { UserService } from '@services/user.service';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';
import { AuditService, auditContext } from '@services/audit.service';

export const createUserSchema = Joi.object({
  name: Joi.string().required().trim().min(2).max(100),
  phone: Joi.string().required().min(7).max(20), // Allow any phone format
  email: Joi.string().email().optional().lowercase().trim(),
  password: Joi.string().optional().min(4), // Optional - staff can use PIN instead
  pin: Joi.string().required().length(4).pattern(/^\d+$/).messages({
    'string.length': 'PIN must be exactly 4 digits',
    'string.pattern.base': 'PIN must be 4 digits only'
  }),
  role: Joi.string().required().valid('MANAGER', 'CASHIER'),
  canDiscount: Joi.boolean().optional().default(false),
  canVoid: Joi.boolean().optional().default(false),
  canViewReports: Joi.boolean().optional().default(false),
  canManageStock: Joi.boolean().optional().default(false),
});

export const updateUserSchema = Joi.object({
  name: Joi.string().optional().trim().min(2).max(100),
  phone: Joi.string().optional().min(7).max(20),
  email: Joi.string().email().optional().lowercase().trim().allow(''),
  password: Joi.string().optional().min(6),
  pin: Joi.alternatives().try(
    Joi.string().length(4).pattern(/^\d+$/).messages({
      'string.length': 'PIN must be exactly 4 digits',
      'string.pattern.base': 'PIN must be 4 digits only'
    }),
    Joi.string().allow('').max(0) // Allow empty string
  ).optional(),
  role: Joi.string().optional().valid('MANAGER', 'CASHIER'),
  isActive: Joi.boolean().optional(),
  canDiscount: Joi.boolean().optional(),
  canVoid: Joi.boolean().optional(),
  canViewReports: Joi.boolean().optional(),
  canManageStock: Joi.boolean().optional(),
});

/**
 * Fields on a user that grant or change authority. Only a shop OWNER may set
 * these — touching any of them is a privilege change, never a profile edit.
 * Exported so the route layer can gate the same set (defense in depth).
 */
export const PRIVILEGED_USER_FIELDS = [
  'role',
  'isActive',
  'canDiscount',
  'canVoid',
  'canViewReports',
  'canManageStock',
] as const;

/** True if `body` attempts to set any authority-granting field. */
export function hasPrivilegedFields(body: Record<string, unknown> | undefined): boolean {
  if (!body) return false;
  return PRIVILEGED_USER_FIELDS.some((f) => f in body);
}

export class UserController {
  /**
   * Create a new user
   */
  static async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      // Only owners can create users
      if (req.user.role !== 'OWNER') {
        ApiResponse.forbidden(res, 'Only owners can create users');
        return;
      }

      const user = await UserService.create({
        ...req.body,
        shopId: req.user.shopId,
      });

      const actor = auditContext(req);
      if (actor) {
        // NEVER log the PIN/password — only safe identity + authority fields.
        await AuditService.log({
          ...actor,
          action: 'USER_CREATE',
          entityType: 'user',
          entityId: user.id,
          details: { name: user.name, phone: user.phone, role: user.role },
        });
      }

      ApiResponse.created(res, user, 'User created successfully');
    } catch (error: any) {
      if (error.message.includes('already exists')) {
        ApiResponse.conflict(res, error.message);
      } else {
        ApiResponse.badRequest(res, error.message, error);
      }
    }
  }

  /**
   * List users
   */
  static async list(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const includeInactive = req.query.includeInactive === 'true';
      const users = await UserService.list(req.user.shopId, includeInactive);
      ApiResponse.success(res, users);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Get user by ID
   */
  static async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { id } = req.params;
      const user = await UserService.getById(id, req.user.shopId);
      ApiResponse.success(res, user);
    } catch (error: any) {
      if (error.message.includes('not found')) {
        ApiResponse.notFound(res, error.message);
      } else {
        ApiResponse.serverError(res, error.message, error);
      }
    }
  }

  /**
   * Update user
   */
  static async update(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      // Only owners can update OTHER users.
      if (req.user.role !== 'OWNER' && req.params.id !== req.user.id) {
        ApiResponse.forbidden(res, 'Only owners can update other users');
        return;
      }

      // Privilege-escalation guard: only an OWNER may change role / active
      // status / permission flags — even on one's own record. A non-owner is
      // allowed a narrow self-edit of profile fields only (name/phone/email/
      // PIN/password). We reject (rather than silently strip) so the caller
      // sees the denial instead of a quietly-ignored change.
      if (req.user.role !== 'OWNER' && hasPrivilegedFields(req.body)) {
        ApiResponse.forbidden(
          res,
          'Only owners can change role, active status, or permission flags',
        );
        return;
      }

      const { id } = req.params;
      const before = await UserService.getById(id, req.user.shopId);
      const user = await UserService.update(id, req.user.shopId, req.body);

      const actor = auditContext(req);
      if (actor) {
        // A PIN edit is a distinct security event. We record THAT it changed,
        // never the value. Treat a non-empty `pin` in the body as a change.
        const pinChanged = typeof req.body.pin === 'string' && req.body.pin.length > 0;
        const passwordChanged = typeof req.body.password === 'string' && req.body.password.length > 0;
        await AuditService.log({
          ...actor,
          action: pinChanged ? 'STAFF_PIN_CHANGE' : 'USER_UPDATE',
          entityType: 'user',
          entityId: id,
          details: {
            targetName: before.name,
            pinChanged,
            passwordChanged,
            before: {
              role: before.role,
              isActive: before.isActive,
              canDiscount: before.canDiscount,
              canVoid: before.canVoid,
              canViewReports: before.canViewReports,
              canManageStock: before.canManageStock,
            },
            after: {
              role: user.role,
              isActive: user.isActive,
              canDiscount: user.canDiscount,
              canVoid: user.canVoid,
              canViewReports: user.canViewReports,
              canManageStock: user.canManageStock,
            },
          },
        });
      }

      ApiResponse.success(res, user, 'User updated successfully');
    } catch (error: any) {
      if (error.message.includes('not found')) {
        ApiResponse.notFound(res, error.message);
      } else if (error.message.includes('already exists')) {
        ApiResponse.conflict(res, error.message);
      } else {
        ApiResponse.badRequest(res, error.message, error);
      }
    }
  }

  /**
   * Delete user
   */
  static async delete(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      // Only owners can delete users
      if (req.user.role !== 'OWNER') {
        ApiResponse.forbidden(res, 'Only owners can delete users');
        return;
      }

      const { id } = req.params;
      const before = await UserService.getById(id, req.user.shopId);
      await UserService.delete(id, req.user.shopId);

      const actor = auditContext(req);
      if (actor) {
        await AuditService.log({
          ...actor,
          action: 'USER_DELETE',
          entityType: 'user',
          entityId: id,
          details: { name: before.name, phone: before.phone, role: before.role },
        });
      }

      ApiResponse.success(res, null, 'User deleted successfully');
    } catch (error: any) {
      if (error.message.includes('not found')) {
        ApiResponse.notFound(res, error.message);
      } else if (error.message.includes('Cannot delete')) {
        ApiResponse.badRequest(res, error.message);
      } else {
        ApiResponse.serverError(res, error.message, error);
      }
    }
  }

  /**
   * Get user stats
   */
  static async getStats(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { id } = req.params;
      const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;

      const stats = await UserService.getStats(id, req.user.shopId, startDate, endDate);
      ApiResponse.success(res, stats);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Get detailed user stats with daily breakdown and insights
   */
  static async getDetail(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { id } = req.params;
      const days = req.query.days ? Number(req.query.days) : 30;

      const detail = await UserService.getDetailedStats(id, req.user.shopId, days);
      ApiResponse.success(res, detail);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }
}
