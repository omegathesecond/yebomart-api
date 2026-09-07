import { Response } from 'express';
import Joi from 'joi';
import { prisma } from '@config/prisma';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';

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
  // Accepted for backward compatibility but IGNORED — the server always derives
  // the refund from the (sale-validated) line items. See ReturnController.create.
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

      // NOTE: refundAmount is deliberately NOT read from the body — it is always
      // derived server-side below. saleId/customerId from the body are treated as
      // untrusted references and validated against the caller's shop before use.
      const { saleId, customerId, reason, type, items, exchangeItems, notes } = req.body;
      const shopId = req.user.shopId;

      // A customer reference must belong to the caller's shop — never trust a
      // customerId that points at another shop's customer.
      if (customerId) {
        const customer = await prisma.customer.findFirst({
          where: { id: customerId, shopId },
        });
        if (!customer) {
          ApiResponse.badRequest(res, 'Customer not found in this shop');
          return;
        }
      }

      // Build the return line items. When a sale is referenced, the sale must
      // belong to the caller's shop and every returned item must be a line on
      // that sale; quantities are capped at what was sold and prices are taken
      // from the sale snapshot (NOT the request) so a cashier cannot inflate the
      // refund or reference another shop's sale.
      let returnLines: Array<{
        productId: string;
        productName: string;
        quantity: number;
        unitPrice: number;
        restockable: boolean;
      }>;

      if (saleId) {
        const sale = await prisma.sale.findFirst({
          where: { id: saleId, shopId },
          include: { items: true },
        });
        if (!sale) {
          ApiResponse.badRequest(res, 'Sale not found in this shop');
          return;
        }

        // Aggregate what was sold, per product (a product may span multiple lines).
        const soldByProduct = new Map<
          string,
          { quantity: number; unitPrice: number; productName: string }
        >();
        for (const line of sale.items) {
          const existing = soldByProduct.get(line.productId);
          if (existing) {
            existing.quantity += line.quantity;
          } else {
            soldByProduct.set(line.productId, {
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              productName: line.productName,
            });
          }
        }

        // Tally the requested return quantities per product so that duplicate
        // lines for the same product can't collectively exceed what was sold.
        const requestedByProduct = new Map<string, number>();
        for (const item of items) {
          requestedByProduct.set(
            item.productId,
            (requestedByProduct.get(item.productId) ?? 0) + item.quantity
          );
        }

        for (const [productId, requestedQty] of requestedByProduct) {
          const sold = soldByProduct.get(productId);
          if (!sold) {
            ApiResponse.badRequest(res, `Item ${productId} was not part of sale ${saleId}`);
            return;
          }
          if (requestedQty > sold.quantity) {
            ApiResponse.badRequest(
              res,
              `Cannot return ${requestedQty} of "${sold.productName}"; only ${sold.quantity} were sold`
            );
            return;
          }
        }

        returnLines = items.map((item: any) => {
          const sold = soldByProduct.get(item.productId)!;
          return {
            productId: item.productId,
            productName: sold.productName, // snapshot from the sale, not the request
            quantity: item.quantity,
            unitPrice: sold.unitPrice, // server-side price, not the request
            restockable: item.restockable ?? true,
          };
        });
      } else {
        // Receiptless return (no sale reference): there is no server-side price
        // to validate against, so keep the supplied lines as-is. The refund is
        // still derived from these lines below (never an arbitrary body value).
        returnLines = items.map((item: any) => ({
          productId: item.productId,
          productName: item.productName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          restockable: item.restockable ?? true,
        }));
      }

      // Refund is ALWAYS computed from the validated lines — never trusted from
      // the request body.
      const calculatedRefund = returnLines.reduce(
        (sum, item) => sum + item.quantity * item.unitPrice,
        0
      );

      // Create the return
      const returnRecord = await prisma.return.create({
        data: {
          shopId,
          saleId: saleId ?? undefined,
          customerId: customerId ?? undefined,
          userId: req.user.type === 'user' ? req.user.id : undefined,
          reason,
          type,
          refundAmount: type === 'REFUND' ? calculatedRefund : 0,
          status: 'PENDING',
          notes,
          items: {
            create: returnLines.map((item) => ({
              productId: item.productId,
              productName: item.productName,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              restockable: item.restockable,
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
        case 'complete': {
          newStatus = 'COMPLETED';
          updateData.processedAt = new Date();

          const userId = req.user.type === 'user' ? req.user.id : undefined;
          const shopId = req.user.shopId;

          // Restock returned items and deduct exchanged-out items atomically so
          // the product quantity and the StockLog audit trail stay consistent.
          await prisma.$transaction(async (tx) => {
            // Restock items if restockable
            for (const item of returnRecord.items) {
              if (item.restockable && !item.restocked) {
                const product = await tx.product.findUnique({
                  where: { id: item.productId },
                });
                if (!product) continue;

                const previousQty = product.quantity;
                const newQty = previousQty + item.quantity;

                await tx.product.update({
                  where: { id: item.productId },
                  data: { quantity: newQty },
                });
                await tx.returnItem.update({
                  where: { id: item.id },
                  data: { restocked: true },
                });
                // Log stock movement (positive quantity = stock added back)
                await tx.stockLog.create({
                  data: {
                    shopId,
                    productId: item.productId,
                    userId,
                    type: 'RETURN',
                    quantity: item.quantity,
                    previousQty,
                    newQty,
                    note: `Return #${returnRecord.id}`,
                    reference: returnRecord.id,
                  },
                });
              }
            }

            // Deduct exchange items from stock (these leave the shop again)
            if (returnRecord.exchangeItems) {
              for (const item of returnRecord.exchangeItems) {
                const product = await tx.product.findUnique({
                  where: { id: item.productId },
                });
                if (!product) continue;

                const previousQty = product.quantity;
                const newQty = previousQty - item.quantity;

                await tx.product.update({
                  where: { id: item.productId },
                  data: { quantity: newQty },
                });
                // Log stock movement (negative quantity = stock removed)
                await tx.stockLog.create({
                  data: {
                    shopId,
                    productId: item.productId,
                    userId,
                    type: 'SALE',
                    quantity: -item.quantity,
                    previousQty,
                    newQty,
                    note: `Exchange on return #${returnRecord.id}`,
                    reference: returnRecord.id,
                  },
                });
              }
            }
          });
          break;
        }
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
