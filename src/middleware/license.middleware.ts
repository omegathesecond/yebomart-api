import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth.middleware';
import { LicenseService } from '@services/license.service';
import { ApiResponse } from '@utils/ApiResponse';
import { prisma } from '@config/prisma';

/**
 * Require a specific feature (checks license tier)
 */
export const requireFeature = (feature: string) => {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Authentication required');
        return;
      }

      const shop = await prisma.shop.findUnique({
        where: { id: req.user.shopId },
        select: { tier: true, licenseExpiry: true },
      });

      if (!shop) {
        ApiResponse.notFound(res, 'Shop not found');
        return;
      }

      // Check if license is expired
      if (shop.licenseExpiry && shop.licenseExpiry < new Date()) {
        ApiResponse.forbidden(res, 'License expired. Please renew to access this feature.');
        return;
      }

      // Check if feature is available
      if (!LicenseService.hasFeature(shop.tier, feature)) {
        ApiResponse.forbidden(res, `This feature requires an upgraded plan. Current: ${shop.tier}`);
        return;
      }

      next();
    } catch (error) {
      ApiResponse.serverError(res, 'Failed to verify license');
    }
  };
};

/**
 * Require PRO tier or higher
 */
export const requirePro = requireFeature('unlimited_products');

/**
 * Require BUSINESS tier
 */
export const requireBusiness = requireFeature('advanced_analytics');

/**
 * Check product limit
 */
export const checkProductLimit = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      ApiResponse.unauthorized(res, 'Authentication required');
      return;
    }

    const shop = await prisma.shop.findUnique({
      where: { id: req.user.shopId },
      select: {
        tier: true,
        _count: { select: { products: true } },
      },
    });

    if (!shop) {
      ApiResponse.notFound(res, 'Shop not found');
      return;
    }

    const limits = LicenseService.getTierLimits(shop.tier)!;
    if (shop._count.products >= limits.maxProducts) {
      ApiResponse.forbidden(res, `Product limit reached (${limits.maxProducts}). Upgrade to add more products.`);
      return;
    }

    next();
  } catch (error) {
    ApiResponse.serverError(res, 'Failed to check product limit');
  }
};

/**
 * Check user limit for adding staff
 */
export const checkUserLimit = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      ApiResponse.unauthorized(res, 'Authentication required');
      return;
    }

    const shop = await prisma.shop.findUnique({
      where: { id: req.user.shopId },
      select: {
        tier: true,
        _count: { select: { users: true } },
      },
    });

    if (!shop) {
      ApiResponse.notFound(res, 'Shop not found');
      return;
    }

    const limits = LicenseService.getTierLimits(shop.tier)!;
    if (shop._count.users >= limits.maxUsers) {
      ApiResponse.forbidden(res, `User limit reached (${limits.maxUsers}). Upgrade to add more staff.`);
      return;
    }

    next();
  } catch (error) {
    ApiResponse.serverError(res, 'Failed to check user limit');
  }
};

/**
 * Track monthly usage
 */
export const trackUsage = (type: 'transaction' | 'stockMove') => {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        next();
        return;
      }

      // Update usage counter in background (don't block request)
      prisma.shop.update({
        where: { id: req.user.shopId },
        data: {
          [type === 'transaction' ? 'monthlyTransactions' : 'monthlyStockMoves']: {
            increment: 1,
          },
        },
      }).catch(console.error);

      next();
    } catch (error) {
      next();
    }
  };
};
