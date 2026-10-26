import { validateCreditReturn, settleCreditReturn } from '@services/return-credit';
import { Prisma } from '@prisma/client';
import { round2 } from '@utils/tax';
import {
  lockSale,
  loadEntitlement,
  refundCents,
  ReturnEligibilityError,
} from '@services/return-entitlement';
import { Response } from 'express';
import Joi from 'joi';
import { prisma } from '@config/prisma';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';

// Shared by creation and completion; validate even lines that do not move stock.
async function validateReturnProducts(
  db: Pick<Prisma.TransactionClient, 'product'>,
  shopId: string,
  lines: Array<{ productId: string }>
) {
  for (const productId of new Set(lines.map((line) => line.productId))) {
    const product = await db.product.findFirst({ where: { id: productId, shopId } });
    if (!product) throw new ReturnEligibilityError(`Product ${productId} not found in this shop`);
  }
}

export const createReturnSchema = Joi.object({
  saleId: Joi.string().optional(),
  customerId: Joi.string().optional(),
  reason: Joi.string().required().min(3).max(500),
  type: Joi.string().required().valid('REFUND', 'EXCHANGE', 'STORE_CREDIT'),
  items: Joi.array()
    .items(
      Joi.object({
        productId: Joi.string().required(),
        productName: Joi.string().required(),
        quantity: Joi.number().required().integer().min(1),
        unitPrice: Joi.number().required().min(0),
        restockable: Joi.boolean().optional().default(true),
      }),
    )
    .required()
    .min(1),
  exchangeItems: Joi.array()
    .items(
      Joi.object({
        productId: Joi.string().required(),
        productName: Joi.string().required(),
        quantity: Joi.number().required().integer().min(1),
        unitPrice: Joi.number().required().min(0),
      }),
    )
    .optional(),
  // Accepted for backward compatibility but IGNORED — the server always derives
  // the refund from the (sale-validated) line items. See ReturnController.create.
  refundAmount: Joi.number().optional().min(0),
  notes: Joi.string().optional().max(1000),
});

export const listReturnsSchema = Joi.object({
  page: Joi.number().optional().integer().min(1).default(1),
  limit: Joi.number().optional().integer().min(1).max(100).default(20),
  status: Joi.string()
    .optional()
    .valid('PENDING', 'APPROVED', 'COMPLETED', 'REJECTED'),
  type: Joi.string().optional().valid('REFUND', 'EXCHANGE', 'STORE_CREDIT'),
  startDate: Joi.date().optional(),
  endDate: Joi.date().optional(),
});

const refundMethods = ['CASH', 'CARD', 'MOMO', 'EMALI'];

export const processReturnSchema = Joi.object({
  action: Joi.string().required().valid('approve', 'reject', 'complete'),
  settlementMethod: Joi.string().valid(...refundMethods).optional(),
  settlementReference: Joi.string().trim().min(1).max(200).optional(),
  paymentConfirmed: Joi.boolean().optional(),
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
      const { saleId, customerId, reason, type, items, exchangeItems, notes } =
        req.body;
      const shopId = req.user!.shopId;

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

      const returnRecord = await prisma.$transaction(async (tx) => {
        let debtorId = customerId;
        await validateReturnProducts(tx, shopId, [...items, ...(exchangeItems ?? [])]);
        if (saleId) {
          await lockSale(tx, saleId);
          const debt = await validateCreditReturn(tx, { saleId, shopId, customerId, type, exchangeItems: exchangeItems ?? [] });
          if (debt) debtorId = debt.customerId;
          const remaining = await loadEntitlement(tx, saleId, shopId);
          const requested = new Map<string, any>();
          for (const item of items) {
            const existing = requested.get(item.productId);
            if (existing && existing.restockable !== (item.restockable ?? true))
              throw new ReturnEligibilityError(
                'Duplicate lines must agree on restocking',
              );
            requested.set(item.productId, {
              ...item,
              restockable: item.restockable ?? true,
              quantity: (existing?.quantity || 0) + item.quantity,
            });
          }
          returnLines = [...requested.values()].map((item) => {
            const p = remaining.find((p) => p.productId === item.productId);
            if (!p)
              throw new ReturnEligibilityError('Item was not part of the sale');
            const cents = refundCents(p, item.quantity);
            return {
              productId: p.productId,
              productName: p.productName,
              quantity: item.quantity,
              unitPrice: cents / 100 / item.quantity,
              restockable: item.restockable,
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
        const calculatedRefund = round2(
          returnLines.reduce(
            (sum, item) => sum + item.quantity * item.unitPrice,
            0,
          ),
        );

        // Create the return
        return tx.return.create({
          data: {
            shopId,
            saleId: saleId ?? undefined,
            customerId: debtorId ?? undefined,
            userId: req.user!.type === 'user' ? req.user!.id : undefined,
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
            exchangeItems: exchangeItems
              ? {
                  create: exchangeItems.map((item: any) => ({
                    productId: item.productId,
                    productName: item.productName,
                    quantity: item.quantity,
                    unitPrice: item.unitPrice,
                  })),
                }
              : undefined,
          },
          include: {
            items: true,
            exchangeItems: true,
          },
        });
      });

      ApiResponse.created(res, returnRecord, 'Return created successfully');
    } catch (error: any) {
      if (error instanceof ReturnEligibilityError) {
        ApiResponse.badRequest(res, error.message);
        return;
      }
      ApiResponse.serverError(res, error.message, error);
    }
  }

  static async remaining(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }
      const data = await prisma.$transaction(async (tx) => {
        await lockSale(tx, req.params.saleId);
        return loadEntitlement(tx, req.params.saleId, req.user!.shopId);
      });
      ApiResponse.success(res, data);
    } catch (error: any) {
      if (error instanceof ReturnEligibilityError) {
        ApiResponse.badRequest(res, error.message);
        return;
      }
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

      const {
        page = 1,
        limit = 20,
        status,
        type,
        startDate,
        endDate,
      } = req.query as any;
      const skip = (page - 1) * limit;

      const where: any = { shopId: req.user!.shopId };
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
      if (error instanceof ReturnEligibilityError) {
        ApiResponse.badRequest(res, error.message);
        return;
      }
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
          shopId: req.user!.shopId,
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
      if (error instanceof ReturnEligibilityError) {
        ApiResponse.badRequest(res, error.message);
        return;
      }
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

      const updated = await prisma.$transaction(async (tx) => {
        const reference = await tx.return.findFirst({
          where: { id: returnId, shopId: req.user!.shopId },
        });
        if (!reference) throw new ReturnEligibilityError('Return not found');
        if (reference.saleId) await lockSale(tx, reference.saleId);
        await tx.$queryRaw`SELECT id FROM "Return" WHERE id = ${returnId} FOR UPDATE`;
        const returnRecord = await tx.return.findFirst({
          where: {
            id: returnId,
            shopId: req.user!.shopId,
          },
          include: { items: true, exchangeItems: true, creditReversal: true },
        });

        if (!returnRecord) {
          throw new ReturnEligibilityError('Return not found');
        }
        if (!['PENDING', 'APPROVED'].includes(returnRecord.status))
          throw new ReturnEligibilityError('Return is already final');
        if (action !== 'reject' && returnRecord.saleId) {
          const remaining = await loadEntitlement(
            tx,
            returnRecord.saleId,
            req.user!.shopId,
            returnId,
          );
          const grouped = new Map<
            string,
            { quantity: number; cents: number }
          >();
          for (const item of returnRecord.items) {
            const prior = grouped.get(item.productId) || {
              quantity: 0,
              cents: 0,
            };
            prior.quantity += item.quantity;
            prior.cents += item.quantity * item.unitPrice * 100;
            grouped.set(item.productId, prior);
          }
          for (const [productId, value] of grouped) {
            const p = remaining.find((p) => p.productId === productId);
            if (
              !p ||
              value.quantity > p.remainingQuantity ||
              Math.round(value.cents) > p.remainingCents
            )
              throw new ReturnEligibilityError('Return is no longer eligible');
          }
          if (
            returnRecord.type === 'REFUND' &&
            Math.round(returnRecord.refundAmount * 100) !==
              Math.round([...grouped.values()].reduce((n, v) => n + v.cents, 0))
          )
            throw new ReturnEligibilityError(
              'Return refund does not match reserved value',
            );
        }

        // Rejection only releases the reservation; missing or moved inventory
        // must not prevent cancelling a pending return.
        if (action !== 'reject') {
          await validateReturnProducts(tx, req.user!.shopId, [...returnRecord.items, ...returnRecord.exchangeItems]);
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

            const userId = req.user!.type === 'user' ? req.user!.id : undefined;
            const shopId = req.user!.shopId;

            await settleCreditReturn(tx, returnRecord, userId);
            if (returnRecord.type === 'REFUND' && returnRecord.status !== 'APPROVED')
              throw new ReturnEligibilityError('Approve the return before confirming settlement');
            if (returnRecord.type === 'REFUND') {
              const { settlementMethod, settlementReference, paymentConfirmed } = req.body;
              if (paymentConfirmed !== true || !refundMethods.includes(settlementMethod))
                throw new ReturnEligibilityError('Confirm actual refund payment and select its settlement method');
              if (settlementMethod !== 'CASH' && !settlementReference?.trim())
                throw new ReturnEligibilityError('A confirmed noncash payment reference is required');
              if (settlementMethod === 'CASH') {
                // Serialize with close: after waiting, recheck OPEN rather than
                // attributing a payout to an immutable closed drawer.
                const sessions = await tx.$queryRaw<Array<{id: string}>>`
                  SELECT id FROM "CashSession" WHERE "shopId" = ${shopId}
                  AND status = 'OPEN' FOR UPDATE`;
                if (sessions.length !== 1)
                  throw new ReturnEligibilityError('Cash payout requires exactly one open till in this shop');
                updateData.cashSessionId = sessions[0].id;
              }
              updateData.settlementMethod = settlementMethod;
              updateData.settlementReference = settlementReference?.trim() || null;
              updateData.settledAt = new Date();
            } else if (req.body.settlementMethod || req.body.paymentConfirmed) {
              throw new ReturnEligibilityError('Only refund returns can record money paid');
            }

            // Restock returned items and deduct exchanged-out items atomically so
            // the product quantity and the StockLog audit trail stay consistent.
            {
              // Restock items if restockable
              for (const item of returnRecord.items) {
                if (item.restockable && !item.restocked) {
                  const product = await tx.product.findUnique({
                    where: { id: item.productId },
                  });
                  if (!product || product.shopId !== shopId)
                    throw new ReturnEligibilityError(
                      'Return product not found in this shop',
                    );

                  if (!product.trackStock) continue;

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
                  if (!product || product.shopId !== shopId)
                    throw new ReturnEligibilityError(
                      'Return product not found in this shop',
                    );

                  if (!product.trackStock) continue;

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
            }
            break;
          }
          default:
            throw new ReturnEligibilityError('Invalid action');
        }

        updateData.status = newStatus;

        return tx.return.update({
          where: { id: returnId },
          data: updateData,
          include: { items: true, exchangeItems: true, creditReversal: true },
        });
      });
      ApiResponse.success(res, updated, `Return ${action}d successfully`);
    } catch (error: any) {
      if (error instanceof ReturnEligibilityError) {
        ApiResponse.badRequest(res, error.message);
        return;
      }
      ApiResponse.serverError(res, error.message, error);
    }
  }
}
