import { Response } from 'express';
import Joi from 'joi';
import { StockService } from '@services/stock.service';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';

export const adjustStockSchema = Joi.object({
  productId: Joi.string().required(),
  type: Joi.string().required().valid('ADJUSTMENT', 'DAMAGED', 'EXPIRED', 'TRANSFER', 'RETURN'),
  quantity: Joi.number().required().integer(), // Can be negative
  note: Joi.string().optional().max(500),
  reference: Joi.string().optional(),
});

export const receiveStockSchema = Joi.object({
  items: Joi.array().items(
    Joi.object({
      productId: Joi.string().required(),
      quantity: Joi.number().required().integer().min(1),
      note: Joi.string().optional(),
    })
  ).required().min(1),
  reference: Joi.string().optional(), // PO number, supplier, etc.
});

export const listMovementsSchema = Joi.object({
  page: Joi.number().optional().integer().min(1).default(1),
  limit: Joi.number().optional().integer().min(1).max(100).default(20),
  productId: Joi.string().optional(),
  type: Joi.string().optional().valid('SALE', 'RESTOCK', 'ADJUSTMENT', 'DAMAGED', 'EXPIRED', 'TRANSFER', 'RETURN', 'INITIAL'),
  startDate: Joi.date().optional(),
  endDate: Joi.date().optional(),
});

export class StockController {
  /**
   * Get current stock levels
   */
  static async getStock(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const stock = await StockService.getStockLevels(req.user.shopId);
      ApiResponse.success(res, stock);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Adjust stock for a single product
   */
  static async adjust(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const result = await StockService.adjust({
        ...req.body,
        shopId: req.user.shopId,
        userId: req.user.type === 'user' ? req.user.id : undefined,
      });

      ApiResponse.success(res, result, 'Stock adjusted successfully');
    } catch (error: any) {
      if (error.message.includes('not found')) {
        ApiResponse.notFound(res, error.message);
      } else if (error.message.includes('Cannot reduce')) {
        ApiResponse.badRequest(res, error.message);
      } else {
        ApiResponse.serverError(res, error.message, error);
      }
    }
  }

  /**
   * Receive stock (bulk restock)
   */
  static async receive(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const result = await StockService.receive({
        ...req.body,
        shopId: req.user.shopId,
        userId: req.user.type === 'user' ? req.user.id : undefined,
      });

      ApiResponse.success(res, result, 'Stock received successfully');
    } catch (error: any) {
      if (error.message.includes('not found')) {
        ApiResponse.notFound(res, error.message);
      } else {
        ApiResponse.badRequest(res, error.message, error);
      }
    }
  }

  /**
   * Get low stock alerts
   */
  static async getAlerts(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const alerts = await StockService.getLowStockAlerts(req.user.shopId);
      ApiResponse.success(res, alerts);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Get stock movements
   */
  static async getMovements(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      // Parse dates if provided
      const params: any = { ...req.query, shopId: req.user.shopId };
      if (params.startDate) {
        params.startDate = new Date(params.startDate);
      }
      if (params.endDate) {
        params.endDate = new Date(params.endDate);
      }

      const result = await StockService.getMovements(params);

      ApiResponse.success(res, result.movements, undefined, 200, {
        total: result.total,
        page: result.page,
        limit: result.limit,
        hasNext: result.hasNext,
        hasPrev: result.hasPrev,
      });
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }
}
