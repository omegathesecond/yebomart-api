import { Response } from 'express';
import Joi from 'joi';
import { prisma } from '@config/prisma';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';
import {
  resolveReturnTransition,
  InvalidReturnTransitionError,
  ReturnAction,
  ReturnTransition,
} from '@services/return.service';
import { creditBalanceChange } from '@services/customerCredit.service';

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
   * Create a new return.
   *
   * Validates that every referenced entity (sale, customer, products) belongs to
   * the caller's shop, and that the returned quantity never exceeds what was
   * actually sold (net of prior returns) — preventing cross-tenant references
   * and refunding more than was bought.
   */
  static async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { saleId, customerId, reason, type, items, exchangeItems, refundAmount, notes } = req.body;
      const shopId = req.user.shopId;

      // --- Tenancy: the sale, if referenced, must belong to this shop. We pull
      // its items here too so we can enforce the quantity ceiling below. ---
      let sale: { id: string; items: Array<{ productId: string; quantity: number }> } | null = null;
      if (saleId) {
        sale = await prisma.sale.findFirst({
          where: { id: saleId, shopId },
          include: { items: { select: { productId: true, quantity: true } } },
        });
        if (!sale) {
          ApiResponse.badRequest(res, 'Sale not found for this shop');
          return;
        }
      }

      // --- Tenancy: the customer, if referenced, must belong to this shop. ---
      if (customerId) {
        const customer = await prisma.customer.findFirst({ where: { id: customerId, shopId } });
        if (!customer) {
          ApiResponse.badRequest(res, 'Customer not found for this shop');
          return;
        }
      }

      // A store-credit return must target a customer to credit; otherwise the
      // money would be recorded nowhere.
      if (type === 'STORE_CREDIT' && !customerId) {
        ApiResponse.badRequest(res, 'A store-credit return requires a customerId');
        return;
      }

      // --- Tenancy: every returned and exchanged product must belong to this shop. ---
      const exchange: Array<any> = exchangeItems ?? [];
      const referencedProductIds = [
        ...items.map((i: any) => i.productId),
        ...exchange.map((i: any) => i.productId),
      ];
      const uniqueProductIds = [...new Set(referencedProductIds)];
      const ownedProducts = await prisma.product.findMany({
        where: { id: { in: uniqueProductIds }, shopId },
        select: { id: true },
      });
      const ownedIds = new Set(ownedProducts.map((p) => p.id));
      const missing = uniqueProductIds.filter((id) => !ownedIds.has(id));
      if (missing.length > 0) {
        ApiResponse.badRequest(res, `Product(s) not found for this shop: ${missing.join(', ')}`);
        return;
      }

      // --- Quantity: never return more of a product than was sold on the
      // referenced sale, accounting for quantities already returned on prior
      // (non-rejected) returns of the same sale. ---
      if (sale) {
        // Sold quantity per product on the original sale.
        const soldByProduct = new Map<string, number>();
        for (const si of sale.items) {
          soldByProduct.set(si.productId, (soldByProduct.get(si.productId) ?? 0) + si.quantity);
        }

        // Quantity already returned per product on prior non-rejected returns.
        const priorReturns = await prisma.return.findMany({
          where: { saleId: sale.id, shopId, status: { not: 'REJECTED' } },
          include: { items: { select: { productId: true, quantity: true } } },
        });
        const returnedByProduct = new Map<string, number>();
        for (const r of priorReturns) {
          for (const ri of r.items) {
            returnedByProduct.set(ri.productId, (returnedByProduct.get(ri.productId) ?? 0) + ri.quantity);
          }
        }

        // Requested quantity per product on THIS return.
        const requestedByProduct = new Map<string, number>();
        for (const it of items) {
          requestedByProduct.set(it.productId, (requestedByProduct.get(it.productId) ?? 0) + it.quantity);
        }

        for (const [productId, requested] of requestedByProduct) {
          const sold = soldByProduct.get(productId) ?? 0;
          const alreadyReturned = returnedByProduct.get(productId) ?? 0;
          const remaining = sold - alreadyReturned;
          if (requested > remaining) {
            ApiResponse.badRequest(
              res,
              `Cannot return ${requested} of product ${productId}: only ${remaining} of ${sold} sold ` +
                `remain returnable (${alreadyReturned} already returned).`,
            );
            return;
          }
        }
      }

      // Calculate the monetary value handed back if not explicitly provided.
      const calculatedRefund =
        refundAmount ??
        items.reduce((sum: number, item: any) => sum + item.quantity * item.unitPrice, 0);
      // REFUND pays cash, STORE_CREDIT issues ledger credit — both carry the
      // value. EXCHANGE is value-neutral here.
      const monetaryAmount = type === 'EXCHANGE' ? 0 : calculatedRefund;

      const returnRecord = await prisma.return.create({
        data: {
          shopId,
          saleId,
          customerId,
          userId: req.user.type === 'user' ? req.user.id : undefined,
          reason,
          type,
          refundAmount: monetaryAmount,
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
          exchangeItems: exchange.length
            ? {
                create: exchange.map((item: any) => ({
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
   * Process return (approve/reject/complete).
   *
   * The status transition is governed by a strict state machine
   * (PENDING → APPROVED → COMPLETED, plus REJECTED). `complete` may only run on
   * an APPROVED return and only ONCE applies its side effects — restocking
   * returned items, deducting exchanged-out items, booking the refund cash
   * movement (tied to the open till) or the store-credit ledger entry. Every
   * stock/money side effect is individually idempotent, and the whole thing runs
   * in a single transaction so status + stock + money commit together.
   */
  static async process(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const action = req.body.action as ReturnAction;
      const { notes } = req.body;
      const returnId = req.params.id;
      const shopId = req.user.shopId;
      const userId = req.user.type === 'user' ? req.user.id : undefined;

      const returnRecord = await prisma.return.findFirst({
        where: { id: returnId, shopId },
        include: { items: true, exchangeItems: true },
      });

      if (!returnRecord) {
        ApiResponse.notFound(res, 'Return not found');
        return;
      }

      // --- State-machine guard. Illegal transitions (e.g. complete-from-PENDING
      // or rejecting a COMPLETED return) are rejected loudly with 409. ---
      let transition: ReturnTransition;
      try {
        transition = resolveReturnTransition(returnRecord.status, action);
      } catch (err) {
        if (err instanceof InvalidReturnTransitionError) {
          ApiResponse.error(res, err.message, 409, undefined, {
            code: err.code,
            meta: { currentStatus: returnRecord.status, action },
          });
          return;
        }
        throw err;
      }

      // Re-issuing a terminal action is an idempotent no-op: return the record
      // unchanged, WITHOUT re-running restock/stock-out/cash/credit booking.
      if (transition.idempotent) {
        ApiResponse.success(res, returnRecord, `Return already ${returnRecord.status.toLowerCase()}`);
        return;
      }

      const updated = await prisma.$transaction(async (tx) => {
        const updateData: any = {
          status: transition.nextStatus,
          notes: notes ?? returnRecord.notes,
        };

        if (transition.appliesCompletion) {
          updateData.processedAt = new Date();

          // 1. Restock returned items (idempotent via the per-item restocked flag).
          for (const item of returnRecord.items) {
            if (!item.restockable || item.restocked) continue;
            const product = await tx.product.findUnique({ where: { id: item.productId } });
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

          // 2. Deduct exchanged-out items (idempotent via the per-item deducted
          //    flag — previously these had NO guard and were deducted again on
          //    every re-complete).
          for (const item of returnRecord.exchangeItems) {
            if (item.deducted) continue;
            const product = await tx.product.findUnique({ where: { id: item.productId } });
            if (!product) continue;

            const previousQty = product.quantity;
            const newQty = previousQty - item.quantity;
            await tx.product.update({
              where: { id: item.productId },
              data: { quantity: newQty },
            });
            await tx.returnExchangeItem.update({
              where: { id: item.id },
              data: { deducted: true },
            });
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

          // 3. Book the money movement.
          if (returnRecord.type === 'REFUND' && returnRecord.refundAmount > 0) {
            // Cash leaving the drawer: tie the refund to the OPEN till session so
            // the end-of-day cash-up subtracts it from expected cash. If no till
            // is open, the refund still completes — the Return row (refundAmount)
            // is the money-movement record either way.
            const openSession = await tx.cashSession.findFirst({
              where: { shopId, status: 'OPEN' },
              select: { id: true },
            });
            if (openSession) updateData.cashSessionId = openSession.id;
          } else if (returnRecord.type === 'STORE_CREDIT' && returnRecord.refundAmount > 0) {
            // Issue store credit: a REFUND ledger entry plus the matching balance
            // decrement (positive balance = customer owes us, so a refund lowers
            // it). customerId is guaranteed by create-time validation.
            if (!returnRecord.customerId) {
              throw new Error('Store-credit return has no customer to credit');
            }
            const balanceChange = creditBalanceChange('REFUND', returnRecord.refundAmount);
            await tx.customerCredit.create({
              data: {
                shopId,
                customerId: returnRecord.customerId,
                type: 'REFUND',
                amount: returnRecord.refundAmount,
                saleId: returnRecord.saleId ?? undefined,
                note: `Store credit for return #${returnRecord.id}`,
                userId,
              },
            });
            await tx.customer.update({
              where: { id: returnRecord.customerId },
              data: { balance: { increment: balanceChange } },
            });
          }
        }

        return tx.return.update({
          where: { id: returnId },
          data: updateData,
          include: { items: true, exchangeItems: true },
        });
      });

      ApiResponse.success(res, updated, `Return ${action}d successfully`);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }
}
