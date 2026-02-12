import { Response } from 'express';
import Joi from 'joi';
import { PrismaClient } from '@prisma/client';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';

const prisma = new PrismaClient();

export const createReturnSchema = Joi.object({
  saleId: Joi.string().optional(),
  customerId: Joi.string().optional(),
  reason: Joi.string().required().min(3).max(500),
  type: Joi.string().required().valid('REFUND', 'EXCHANGE', 'STORE_CREDIT'),
  items: Joi.array().items(
    Joi.object({
      productId: Joi.string().required(),
      productName: Joi.string().required(),
      quantity: Joi.number().required().integer().min(1),
      unitPrice: Joi.number().required().min(0),
      restockable: Joi.boolean().optional().default(true),
    })
  ).required().min(1),
  exchangeItems: Joi.array().items(
    Joi.object({
      productId: Joi.string().required(),
      productName: Joi.string().required(),
      quantity: Joi.number().required().integer().min(1),
      unitPrice: Joi.number().required().min(0),
    })
  ).optional(),
  refundAmount: Joi.number().optional().min(0),
  notes: Joi.string().optional().max(1000),
});

export const listReturnsSchema = Joi.object({
  page: Joi.number().optional().integer().min(1).default(1),
  limit: Joi.number().optional().integer().min(1).max(100).default(20),
  status: Joi.string().optional().valid('PENDING', 'APPROVED', 'COMPLETED', 'REJECTED'),
  type: Joi.string().optional().valid('REFUND', 'EXCHANGE', 'STORE_CREDIT'),
  startDate: Joi.date().optional(),
  endDate: Joi.date().optional(),
});

export const processReturnSchema = Joi.object({
  action: Joi.string().required().valid('approve', 'reject', 'complete'),
  notes: Joi.string().optional().max(1000),
});

export class ReturnController {
  /**
   * Create a new return
   */
  static async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { saleId, customerId, reason, type, items, exchangeItems, refundAmount, notes } = req.body;
      const shopId = req.user.shopId;

      // Calculate total refund if not provided
      const calculatedRefund = refundAmount ?? items.reduce(
        (sum: number, item: any) => sum + (item.quantity * item.unitPrice),
        0
      );

      // Create the return
      const returnRecord = await prisma.return.create({
        data: {
          shopId,
          saleId,
          customerId,
          userId: req.user.type === 'user' ? req.user.id : undefined,
          reason,
          type,
          refundAmount: type === 'REFUND' ? calculatedRefund : 0,
          status: 'PENDING',
          notes,
          items: {
            create: items.map((item: any) => ({
              productId: item.productId,
              productName: item.productName,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              restockable: item.restockable ?? true,
            })),
          },
          exchangeItems: exchangeItems ? {
            create: exchangeItems.map((item: any) => ({
              productId: item.productId,
              productName: item.productName,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
            })),
          } : undefined,
        },
        include: {
          items: true,
          exchangeItems: true,
        },
      });

      ApiResponse.created(res, returnRecord, 'Return created successfully');
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * List returns
   */
  static async list(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { page = 1, limit = 20, status, type, startDate, endDate } = req.query as any;
      const skip = (page - 1) * limit;

      const where: any = { shopId: req.user.shopId };
      if (status) where.status = status;
      if (type) where.type = type;
      if (startDate || endDate) {
        where.createdAt = {};
        if (startDate) where.createdAt.gte = new Date(startDate);
        if (endDate) where.createdAt.lte = new Date(endDate);
      }

      const [returns, total] = await Promise.all([
        prisma.return.findMany({
          where,
          skip,
          take: parseInt(limit),
          orderBy: { createdAt: 'desc' },
          include: {
            items: true,
            exchangeItems: true,
          },
        }),
        prisma.return.count({ where }),
      ]);

      ApiResponse.success(res, returns, undefined, 200, {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        hasNext: skip + returns.length < total,
        hasPrev: page > 1,
      });
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Get return by ID
   */
  static async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const returnRecord = await prisma.return.findFirst({
        where: {
          id: req.params.id,
          shopId: req.user.shopId,
        },
        include: {
          items: true,
          exchangeItems: true,
        },
      });

      if (!returnRecord) {
        ApiResponse.notFound(res, 'Return not found');
        return;
      }

      ApiResponse.success(res, returnRecord);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Process return (approve/reject/complete)
   */
  static async process(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { action, notes } = req.body;
      const returnId = req.params.id;

      const returnRecord = await prisma.return.findFirst({
        where: {
          id: returnId,
          shopId: req.user.shopId,
        },
        include: { items: true, exchangeItems: true },
      });

      if (!returnRecord) {
        ApiResponse.notFound(res, 'Return not found');
        return;
      }

      let newStatus: string;
      let updateData: any = { notes: notes || returnRecord.notes };

      switch (action) {
        case 'approve':
          newStatus = 'APPROVED';
          break;
        case 'reject':
          newStatus = 'REJECTED';
          break;
        case 'complete':
          newStatus = 'COMPLETED';
          updateData.processedAt = new Date();

          // Restock items if restockable
          for (const item of returnRecord.items) {
            if (item.restockable && !item.restocked) {
              await prisma.product.update({
                where: { id: item.productId },
                data: { quantity: { increment: item.quantity } },
              });
              await prisma.returnItem.update({
                where: { id: item.id },
                data: { restocked: true },
              });
              // Log stock movement
              await prisma.stockLog.create({
                data: {
                  shopId: req.user.shopId,
                  productId: item.productId,
                  userId: req.user.type === 'user' ? req.user.id : undefined,
                  type: 'RETURN',
                  quantity: item.quantity,
                  previousQty: 0, // Will be calculated properly in real implementation
                  newQty: 0,
                  note: `Return #${returnRecord.id}`,
                  reference: returnRecord.id,
                },
              });
            }
          }

          // Deduct exchange items from stock
          if (returnRecord.exchangeItems) {
            for (const item of returnRecord.exchangeItems) {
              await prisma.product.update({
                where: { id: item.productId },
                data: { quantity: { decrement: item.quantity } },
              });
            }
          }
          break;
        default:
          ApiResponse.badRequest(res, 'Invalid action');
          return;
      }

      updateData.status = newStatus;

      const updated = await prisma.return.update({
        where: { id: returnId },
        data: updateData,
        include: { items: true, exchangeItems: true },
      });

      ApiResponse.success(res, updated, `Return ${action}d successfully`);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }
}
