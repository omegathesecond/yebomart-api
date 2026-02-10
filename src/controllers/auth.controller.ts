import { Request, Response } from 'express';
import Joi from 'joi';
import { AuthService } from '@services/auth.service';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';

// Validation schemas
export const registerSchema = Joi.object({
  name: Joi.string().required().trim().min(2).max(100),
  ownerName: Joi.string().required().trim().min(2).max(100),
  ownerPhone: Joi.string().required().pattern(/^\+[1-9]\d{1,14}$/).messages({
    'string.pattern.base': 'Phone must be in E.164 format (e.g., +26878422613)',
  }),
  ownerEmail: Joi.string().email().optional().lowercase().trim(),
  password: Joi.string().min(6).required(),
  assistantName: Joi.string().optional().trim().max(50),
  businessType: Joi.string().optional().valid(
    'general', 'tuckshop', 'spaza', 'tyre', 'hardware', 'grocery', 
    'pharmacy', 'salon', 'restaurant', 'clothing', 'electronics', 'butchery'
  ).default('general'),
});

export const loginSchema = Joi.object({
  phone: Joi.string().required(),
  password: Joi.string().required(),
});

export const userLoginSchema = Joi.object({
  phone: Joi.string().required(),
  pin: Joi.string().required().length(4),
});

export const refreshTokenSchema = Joi.object({
  refreshToken: Joi.string().required(),
});

export class AuthController {
  /**
   * Register a new shop
   */
  static async register(req: Request, res: Response): Promise<void> {
    try {
      const result = await AuthService.registerShop(req.body);
      ApiResponse.created(res, result, 'Shop registered successfully');
    } catch (error: any) {
      if (error.message.includes('already registered')) {
        ApiResponse.conflict(res, error.message);
      } else {
        ApiResponse.badRequest(res, error.message, error);
      }
    }
  }

  /**
   * Login as shop owner
   */
  static async login(req: Request, res: Response): Promise<void> {
    try {
      const { phone, password } = req.body;
      const result = await AuthService.loginShop(phone, password);
      ApiResponse.success(res, result, 'Login successful');
    } catch (error: any) {
      ApiResponse.unauthorized(res, error.message);
    }
  }

  /**
   * Login as staff user (with PIN)
   */
  static async userLogin(req: Request, res: Response): Promise<void> {
    try {
      const { phone, pin } = req.body;
      const result = await AuthService.loginUser(phone, pin);
      ApiResponse.success(res, result, 'Staff login successful');
    } catch (error: any) {
      ApiResponse.unauthorized(res, error.message);
    }
  }

  /**
   * Refresh access token
   */
  static async refreshToken(req: Request, res: Response): Promise<void> {
    try {
      const { refreshToken } = req.body;
      const result = await AuthService.refreshToken(refreshToken);
      ApiResponse.success(res, result, 'Token refreshed');
    } catch (error: any) {
      ApiResponse.unauthorized(res, error.message);
    }
  }

  /**
   * Get current user/shop info
   */
  static async getMe(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const result = await AuthService.getMe(req.user.id, req.user.type);
      ApiResponse.success(res, result);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }
}
