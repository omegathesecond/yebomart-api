import { Response } from 'express';
import Joi from 'joi';
import { SaleService } from '@services/sale.service';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';

export const createSaleSchema = Joi.object({
  items: Joi.array().items(
    Joi.object({
      productId: Joi.string().required(),
      quantity: Joi.number().required().integer().min(1),
      discount: Joi.number().optional().min(0).default(0),
    })
  ).required().min(1),
  paymentMethod: Joi.string().required().valid('CASH', 'MOMO', 'EMALI', 'CARD', 'MIXED', 'CREDIT'),
  amountPaid: Joi.number().required().min(0),
  discount: Joi.number().optional().min(0).default(0),
  localId: Joi.string().optional(),
  offlineAt: Joi.date().optional(),
});

export const listSalesSchema = Joi.object({
  page: Joi.number().optional().integer().min(1).default(1),
  limit: Joi.number().optional().integer().min(1).max(100).default(20),
  status: Joi.string().optional().valid('PENDING', 'COMPLETED', 'VOIDED', 'REFUNDED'),
  paymentMethod: Joi.string().optional().valid('CASH', 'MOMO', 'EMALI', 'CARD', 'MIXED', 'CREDIT'),
  startDate: Joi.date().optional(),
  endDate: Joi.date().optional(),
  userId: Joi.string().optional(),
});

export const voidSaleSchema = Joi.object({
  reason: Joi.string().required().min(5).max(500),
});

export class SaleController {
  /**
   * Create a new sale
   */
  static async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const sale = await SaleService.create({
        ...req.body,
        shopId: req.user.shopId,
        userId: req.user.type === 'user' ? req.user.id : undefined,
      });

      ApiResponse.created(res, sale, 'Sale completed successfully');
    } catch (error: any) {
      if (error.message.includes('Insufficient')) {
        ApiResponse.badRequest(res, error.message);
      } else if (error.message.includes('not found')) {
        ApiResponse.notFound(res, error.message);
      } else {
        ApiResponse.serverError(res, error.message, error);
      }
    }
  }

  /**
   * List sales
   */
  static async list(req: AuthRequest, res: Response): Promise<void> {
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

      const result = await SaleService.list(params);

      ApiResponse.success(res, result.sales, undefined, 200, {
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

  /**
   * Get sale by ID
   */
  static async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { id } = req.params;
      const sale = await SaleService.getById(id, req.user.shopId);
      ApiResponse.success(res, sale);
    } catch (error: any) {
      if (error.message.includes('not found')) {
        ApiResponse.notFound(res, error.message);
      } else {
        ApiResponse.serverError(res, error.message, error);
      }
    }
  }

  /**
   * Void a sale
   */
  static async voidSale(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      // Check permission
      if (req.user.type === 'user') {
        // Would need to check user permissions here
        // For now, only owner and managers can void
        if (req.user.role === 'CASHIER') {
          ApiResponse.forbidden(res, 'You do not have permission to void sales');
          return;
        }
      }

      const { id } = req.params;
      const { reason } = req.body;

      const sale = await SaleService.voidSale(
        id,
        req.user.shopId,
        req.user.id,
        reason
      );

      ApiResponse.success(res, sale, 'Sale voided successfully');
    } catch (error: any) {
      if (error.message.includes('not found')) {
        ApiResponse.notFound(res, error.message);
      } else {
        ApiResponse.badRequest(res, error.message, error);
      }
    }
  }

  /**
   * Get daily summary
   */
  static async getDailySummary(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const date = req.query.date ? new Date(req.query.date as string) : undefined;
      const summary = await SaleService.getDailySummary(req.user.shopId, date);
      ApiResponse.success(res, summary);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Search sale by receipt number
   */
  static async searchByReceipt(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { receiptNumber } = req.query;
      if (!receiptNumber) {
        ApiResponse.badRequest(res, 'Receipt number is required');
        return;
      }

      const sale = await SaleService.getByReceiptNumber(
        receiptNumber as string,
        req.user.shopId
      );
      ApiResponse.success(res, sale);
    } catch (error: any) {
      if (error.message.includes('not found')) {
        ApiResponse.notFound(res, error.message);
      } else {
        ApiResponse.serverError(res, error.message, error);
      }
    }
  }
}
