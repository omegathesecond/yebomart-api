import { Response } from 'express';
import Joi from 'joi';
import { PrismaClient } from '@prisma/client';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';

const prisma = new PrismaClient();

// ==================== Validation schemas ====================

export const createPurchaseOrderSchema = Joi.object({
  supplierId: Joi.string().required(),
  // DRAFT = not yet placed, SENT = ordered/placed with supplier.
  status: Joi.string().valid('DRAFT', 'SENT').optional().default('DRAFT'),
  tax: Joi.number().optional().min(0).default(0),
  expectedDate: Joi.date().optional(),
  notes: Joi.string().optional().max(1000),
  items: Joi.array()
    .min(1)
    .required()
    .items(
      Joi.object({
        productId: Joi.string().required(),
        qtyOrdered: Joi.number().integer().min(1).required(),
        unitCost: Joi.number().min(0).required(),
      })
    ),
});

export const listPurchaseOrdersSchema = Joi.object({
  page: Joi.number().optional().integer().min(1).default(1),
  limit: Joi.number().optional().integer().min(1).max(100).default(50),
  supplierId: Joi.string().optional(),
  status: Joi.string().valid('DRAFT', 'SENT', 'PARTIAL', 'RECEIVED', 'CANCELLED').optional(),
});

export const receivePurchaseOrderSchema = Joi.object({
  // Optional: receive specific line items with specific quantities.
  // If omitted, every line is received in full (the remaining qty).
  items: Joi.array()
    .optional()
    .items(
      Joi.object({
        poItemId: Joi.string().required(),
        quantity: Joi.number().integer().min(1).required(),
      })
    ),
  // When true, each received product's costPrice is updated to the PO unitCost.
  updateCost: Joi.boolean().optional().default(false),
  notes: Joi.string().optional().max(1000),
});

export class PurchaseOrderController {
  /**
   * Create a purchase order for a supplier with line items.
   * Snapshots productName/unitCost and computes totals server-side.
   */
  static async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const shopId = req.user.shopId;
      const { supplierId, status, tax, expectedDate, notes, items } = req.body;

      // Supplier must belong to this shop.
      const supplier = await prisma.supplier.findFirst({
        where: { id: supplierId, shopId },
      });
      if (!supplier) {
        ApiResponse.notFound(res, 'Supplier not found');
        return;
      }

      // All ordered products must belong to this shop.
      const productIds: string[] = items.map((i: any) => i.productId);
      const products = await prisma.product.findMany({
        where: { id: { in: productIds }, shopId },
        select: { id: true, name: true },
      });
      const productById = new Map(products.map((p) => [p.id, p]));

      const missing = productIds.filter((id) => !productById.has(id));
      if (missing.length > 0) {
        ApiResponse.badRequest(res, `Unknown product(s) for this shop: ${missing.join(', ')}`);
        return;
      }

      const lineItems = items.map((i: any) => {
        const totalCost = i.qtyOrdered * i.unitCost;
        return {
          productId: i.productId,
          productName: productById.get(i.productId)!.name,
          quantity: i.qtyOrdered,
          unitCost: i.unitCost,
          totalCost,
        };
      });

      const subtotal = lineItems.reduce((sum: number, i: any) => sum + i.totalCost, 0);
      const totalAmount = subtotal + (tax || 0);
      const orderNumber = `PO-${Date.now()}`;

      const po = await prisma.purchaseOrder.create({
        data: {
          shopId,
          supplierId,
          orderNumber,
          status,
          subtotal,
          tax: tax || 0,
          totalAmount,
          expectedDate: expectedDate || undefined,
          notes,
          items: { create: lineItems },
        },
        include: {
          supplier: { select: { id: true, name: true, phone: true, currency: true } },
          items: true,
        },
      });

      ApiResponse.created(res, po, 'Purchase order created successfully');
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * List purchase orders (filter by supplier / status).
   */
  static async list(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { page = 1, limit = 50, supplierId, status } = req.query as any;
      const skip = (page - 1) * limit;

      const where: any = { shopId: req.user.shopId };
      if (supplierId) where.supplierId = supplierId;
      if (status) where.status = status;

      const [orders, total] = await Promise.all([
        prisma.purchaseOrder.findMany({
          where,
          skip,
          take: parseInt(limit),
          orderBy: { createdAt: 'desc' },
          include: {
            supplier: { select: { id: true, name: true, phone: true } },
            _count: { select: { items: true } },
          },
        }),
        prisma.purchaseOrder.count({ where }),
      ]);

      ApiResponse.success(res, orders, undefined, 200, {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        hasNext: skip + orders.length < total,
        hasPrev: page > 1,
      });
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Get a single purchase order with its line items.
   */
  static async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const po = await prisma.purchaseOrder.findFirst({
        where: { id: req.params.id, shopId: req.user.shopId },
        include: {
          supplier: { select: { id: true, name: true, phone: true, currency: true, email: true } },
          items: true,
        },
      });

      if (!po) {
        ApiResponse.notFound(res, 'Purchase order not found');
        return;
      }

      ApiResponse.success(res, po);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Receive a purchase order (full or partial).
   *
   * For each received POItem we bump Product.quantity and write a StockLog with
   * the CORRECT previousQty/newQty (type RESTOCK) — all inside a single
   * transaction so stock levels and the audit trail never drift apart. The PO
   * status moves to RECEIVED (everything in) or PARTIAL (some outstanding).
   */
  static async receive(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const shopId = req.user.shopId;
      // StockLog.userId is a real User FK; only staff tokens carry a User id.
      // A shop-owner token's `id` is the Shop id, so leave userId null for it.
      const userId = req.user.type === 'user' ? req.user.id : undefined;
      const poId = req.params.id;
      const { items: receiveItems, updateCost, notes } = req.body;

      const po = await prisma.purchaseOrder.findFirst({
        where: { id: poId, shopId },
        include: { items: true },
      });

      if (!po) {
        ApiResponse.notFound(res, 'Purchase order not found');
        return;
      }

      if (po.status === 'RECEIVED') {
        ApiResponse.badRequest(res, 'Purchase order is already fully received');
        return;
      }
      if (po.status === 'CANCELLED') {
        ApiResponse.badRequest(res, 'Cannot receive a cancelled purchase order');
        return;
      }

      const itemById = new Map(po.items.map((i) => [i.id, i]));

      // Build the list of (poItem, qtyToReceive) pairs. When no explicit items
      // are supplied, receive the full outstanding quantity of every line.
      const toReceive: Array<{ item: (typeof po.items)[number]; qty: number }> = [];

      if (receiveItems && receiveItems.length > 0) {
        for (const r of receiveItems as Array<{ poItemId: string; quantity: number }>) {
          const item = itemById.get(r.poItemId);
          if (!item) {
            ApiResponse.badRequest(res, `Line item ${r.poItemId} does not belong to this purchase order`);
            return;
          }
          const outstanding = item.quantity - item.receivedQty;
          if (outstanding <= 0) {
            ApiResponse.badRequest(res, `Line item ${r.poItemId} is already fully received`);
            return;
          }
          if (r.quantity > outstanding) {
            ApiResponse.badRequest(
              res,
              `Cannot receive ${r.quantity} of "${item.productName}" — only ${outstanding} outstanding`
            );
            return;
          }
          toReceive.push({ item, qty: r.quantity });
        }
      } else {
        for (const item of po.items) {
          const outstanding = item.quantity - item.receivedQty;
          if (outstanding > 0) toReceive.push({ item, qty: outstanding });
        }
      }

      if (toReceive.length === 0) {
        ApiResponse.badRequest(res, 'Nothing to receive — all items already received');
        return;
      }

      const updatedPo = await prisma.$transaction(async (tx) => {
        for (const { item, qty } of toReceive) {
          const product = await tx.product.findUnique({ where: { id: item.productId } });
          // Product may have been deleted after the PO was raised; receiving the
          // remaining lines should still succeed, so skip the stock bump but
          // still record the receipt against the PO line below.
          if (product) {
            const previousQty = product.quantity;
            const newQty = previousQty + qty;

            await tx.product.update({
              where: { id: item.productId },
              data: {
                quantity: newQty,
                ...(updateCost ? { costPrice: item.unitCost } : {}),
              },
            });

            await tx.stockLog.create({
              data: {
                shopId,
                productId: item.productId,
                userId,
                type: 'RESTOCK',
                quantity: qty, // positive = stock added
                previousQty,
                newQty,
                note: `Received PO ${po.orderNumber ?? po.id}`,
                reference: po.id,
              },
            });
          }

          await tx.pOItem.update({
            where: { id: item.id },
            data: { receivedQty: item.receivedQty + qty },
          });
        }

        // Recompute PO status from the line receipts.
        const fullyReceived = po.items.every((item) => {
          const extra = toReceive.find((t) => t.item.id === item.id)?.qty ?? 0;
          return item.receivedQty + extra >= item.quantity;
        });

        return tx.purchaseOrder.update({
          where: { id: poId },
          data: {
            status: fullyReceived ? 'RECEIVED' : 'PARTIAL',
            receivedDate: fullyReceived ? new Date() : po.receivedDate ?? new Date(),
            notes: notes ?? po.notes,
          },
          include: {
            supplier: { select: { id: true, name: true, phone: true } },
            items: true,
          },
        });
      });

      ApiResponse.success(res, updatedPo, 'Purchase order received');
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }
}
