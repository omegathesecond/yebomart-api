import { Response } from 'express';
import Joi from 'joi';
import { ShopService } from '@services/shop.service';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';
import { AuditService, auditContext } from '@services/audit.service';
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

export const updateNotificationSettingsSchema = Joi.object({
  notifyWhatsAppReports: Joi.boolean().optional(),
  notifyLowStock: Joi.boolean().optional(),
  // E.164 override, or empty string to clear it (fall back to ownerPhone).
  notifyPhone: Joi.string().allow('', null).pattern(/^\+[1-9]\d{6,14}$/).optional()
    .messages({ 'string.pattern.base': 'notifyPhone must be E.164 (e.g. +26876123456)' }),
}).min(1);

export const updateTaxSettingsSchema = Joi.object({
  taxRate: Joi.number().min(0).max(100).optional(),
  taxInclusive: Joi.boolean().optional(),
  // VAT registration number; empty string clears it (back to null).
  taxNumber: Joi.string().allow('', null).trim().max(50).optional(),
}).min(1);

export class ShopController {
  /**
   * GET /api/shops/notifications — current shop's notification prefs + recipient.
   */
  static async getNotificationSettings(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }
      const settings = await ShopService.getNotificationSettings(req.user.shopId);
      ApiResponse.success(res, settings);
    } catch (error: any) {
      if (error.message?.includes('not found')) {
        ApiResponse.notFound(res, error.message);
      } else {
        ApiResponse.serverError(res, error.message, error);
      }
    }
  }

  /**
   * PATCH /api/shops/notifications — update the current shop's notification prefs.
   * Owner-only (route-gated). Scoped to req.user.shopId — no shop id in the path,
   * so an owner can only ever touch their own shop.
   */
  static async updateNotificationSettings(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }
      const settings = await ShopService.updateNotificationSettings(req.user.shopId, req.body);

      const actor = auditContext(req);
      if (actor) {
        await AuditService.log({
          ...actor,
          action: 'SETTINGS_UPDATE',
          entityType: 'shop',
          entityId: req.user.shopId,
          details: { settings: 'notifications', changes: req.body },
        });
      }

      ApiResponse.success(res, settings, 'Notification settings updated');
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * GET /api/shops/tax — current shop's VAT / tax configuration.
   */
  static async getTaxSettings(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }
      const settings = await ShopService.getTaxSettings(req.user.shopId);
      ApiResponse.success(res, settings);
    } catch (error: any) {
      if (error.message?.includes('not found')) {
        ApiResponse.notFound(res, error.message);
      } else {
        ApiResponse.serverError(res, error.message, error);
      }
    }
  }

  /**
   * PATCH /api/shops/tax — update the current shop's VAT / tax configuration.
   * Owner-only (route-gated). Scoped to req.user.shopId.
   */
  static async updateTaxSettings(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }
      const settings = await ShopService.updateTaxSettings(req.user.shopId, req.body);

      const actor = auditContext(req);
      if (actor) {
        await AuditService.log({
          ...actor,
          action: 'SETTINGS_UPDATE',
          entityType: 'shop',
          entityId: req.user.shopId,
          details: { settings: 'tax', changes: req.body },
        });
      }

      ApiResponse.success(res, settings, 'Tax settings updated');
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

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

      const actor = auditContext(req);
      if (actor) {
        await AuditService.log({
          ...actor,
          action: 'SETTINGS_UPDATE',
          entityType: 'shop',
          entityId: id,
          details: { settings: 'shop', changes: req.body },
        });
      }

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
