import { Response } from 'express';
import Joi from 'joi';
import { ShopService } from '@services/shop.service';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';
import { getAllBusinessTypes, getBusinessConfig, BUSINESS_TYPES } from '@config/businessTypes';

export const updateShopSchema = Joi.object({
  name: Joi.string().optional().trim().min(2).max(100),
  ownerName: Joi.string().optional().trim().min(2).max(100),
  assistantName: Joi.string().optional().trim().max(50),
  businessType: Joi.string().optional().valid(...Object.keys(BUSINESS_TYPES)),
  currency: Joi.string().optional().valid('SZL', 'ZAR', 'USD'),
  timezone: Joi.string().optional(),
  address: Joi.string().optional().max(500),
  logoUrl: Joi.string().optional().uri(),
});

export class ShopController {
  /**
   * Get shop by ID
   */
  static async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { id } = req.params;

      // Ensure user can only access their own shop
      if (id !== req.user.shopId) {
        ApiResponse.forbidden(res, 'Access denied');
        return;
      }

      const shop = await ShopService.getById(id);
      ApiResponse.success(res, shop);
    } catch (error: any) {
      if (error.message.includes('not found')) {
        ApiResponse.notFound(res, error.message);
      } else {
        ApiResponse.serverError(res, error.message, error);
      }
    }
  }

  /**
   * Update shop
   */
  static async update(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { id } = req.params;

      // Ensure user can only update their own shop
      if (id !== req.user.shopId) {
        ApiResponse.forbidden(res, 'Access denied');
        return;
      }

      // Only owners can update shop settings
      if (req.user.role !== 'OWNER') {
        ApiResponse.forbidden(res, 'Only owners can update shop settings');
        return;
      }

      const shop = await ShopService.update(id, req.body);
      ApiResponse.success(res, shop, 'Shop updated successfully');
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Get shop stats
   */
  static async getStats(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { id } = req.params;

      // Ensure user can only access their own shop
      if (id !== req.user.shopId) {
        ApiResponse.forbidden(res, 'Access denied');
        return;
      }

      const stats = await ShopService.getStats(id);
      ApiResponse.success(res, stats);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Get all available business types
   */
  static async getBusinessTypes(req: AuthRequest, res: Response): Promise<void> {
    try {
      const types = getAllBusinessTypes();
      ApiResponse.success(res, types);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Get config for shop's business type
   */
  static async getConfig(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const shop = await ShopService.getById(req.user.shopId);
      const config = getBusinessConfig(shop.businessType || 'general');

      ApiResponse.success(res, {
        businessType: shop.businessType || 'general',
        config,
      });
    } catch (error: any) {
      ApiResponse.serverError(res, error.message);
    }
  }
}
