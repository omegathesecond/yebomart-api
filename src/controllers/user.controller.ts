import { Response } from 'express';
import Joi from 'joi';
import { UserService } from '@services/user.service';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';

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
  pin: Joi.string().optional().length(4).pattern(/^\d+$/).allow(''),
  role: Joi.string().optional().valid('MANAGER', 'CASHIER'),
  isActive: Joi.boolean().optional(),
  canDiscount: Joi.boolean().optional(),
  canVoid: Joi.boolean().optional(),
  canViewReports: Joi.boolean().optional(),
  canManageStock: Joi.boolean().optional(),
});

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

      // Only owners can update users (except self)
      if (req.user.role !== 'OWNER' && req.params.id !== req.user.id) {
        ApiResponse.forbidden(res, 'Only owners can update other users');
        return;
      }

      const { id } = req.params;
      const user = await UserService.update(id, req.user.shopId, req.body);
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
      await UserService.delete(id, req.user.shopId);
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
}
