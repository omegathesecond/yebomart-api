import { CashSessionService } from "@services/cashSession.service";
import { Prisma } from "@prisma/client";
import { applyCustomerCredit } from "@services/customerCredit.service";
import { computeTax, round2 } from "@utils/tax";
import {
  validateCreditReturn,
  settleCreditReturn,
} from "@services/return-credit";
import {
  lockSale,
  loadEntitlement,
  refundCents,
  ReturnEligibilityError,
} from "@services/return-entitlement";
import { Response } from "express";
import Joi from "joi";
import { prisma } from "@config/prisma";
import { ApiResponse } from "@utils/ApiResponse";
import { AuthRequest } from "@middleware/auth.middleware";

const returnDetails = Prisma.validator<Prisma.ReturnInclude>()({
  items: true,
  exchangeItems: true,
  customer: { select: { id: true, name: true } },
  creditReversal: true,
});

// Shared by creation and completion; validate even lines that do not move stock.
async function validateReturnProducts(
  db: Pick<Prisma.TransactionClient, "product">,
  shopId: string,
  lines: Array<{ productId: string }>,
) {
  for (const productId of new Set(lines.map((line) => line.productId))) {
    const product = await db.product.findFirst({
      where: { id: productId, shopId },
    });
    if (!product)
      throw new ReturnEligibilityError(
        `Product ${productId} not found in this shop`,
      );
  }
}

// Replacement prices are current retail prices, with the shop's current VAT.
// Allocate the basket's rounded total across lines so stored values sum exactly.
function validateExchangeShape(type: string, saleId: string | null | undefined, lines?: unknown[]) {
  if (type === "EXCHANGE") {
    if (!lines?.length) throw new ReturnEligibilityError("Choose at least one replacement item");
    if (!saleId) throw new ReturnEligibilityError("Exchanges require an original sale receipt");
  } else if (lines !== undefined && lines.length > 0) {
    throw new ReturnEligibilityError("Only exchanges can contain replacement items");
  }
}

async function priceReplacements(
  tx: Prisma.TransactionClient, shopId: string,
  lines: Array<{ productId: string; quantity: number }>, returnedValue: number,
) {
  const grouped = new Map<string, number>();
  for (const line of lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1)
      throw new ReturnEligibilityError("Replacement quantities must be positive whole numbers");
    const quantity = (grouped.get(line.productId) ?? 0) + line.quantity;
    if (!Number.isSafeInteger(quantity)) throw new ReturnEligibilityError("Invalid replacement quantity");
    grouped.set(line.productId, quantity);
  }
  const shop = await tx.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw new ReturnEligibilityError("Shop not found");
  const products = [];
  for (const [productId, quantity] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    const product = await tx.product.findFirst({ where: { id: productId, shopId } });
    if (!product) throw new ReturnEligibilityError(`Product ${productId} not found in this shop`);
    if (!product.isActive) throw new ReturnEligibilityError(`Replacement ${product.name} is inactive`);
    if (!Number.isFinite(product.sellPrice) || product.sellPrice < 0)
      throw new ReturnEligibilityError("Invalid replacement price");
    products.push({ productId, productName: product.name, quantity, base: product.sellPrice * quantity });
  }
  const subtotal = products.reduce((sum, p) => sum + p.base, 0);
  const totalCents = Math.round(computeTax(subtotal, 0, shop).total * 100);
  if (!Number.isSafeInteger(totalCents) || totalCents !== Math.round(returnedValue * 100))
    throw new ReturnEligibilityError("Only equal-value exchanges are supported. Replacement value must equal returned value, including tax and original discounts.");
  let cumulative = 0, allocated = 0;
  return products.map(({ base, ...line }) => {
    cumulative += base;
    const boundary = subtotal ? Math.round(totalCents * cumulative / subtotal) : 0;
    const unitPrice = (boundary - allocated) / 100 / line.quantity;
    allocated = boundary;
    return { ...line, unitPrice };
  });
}

// Store credit is a new entitlement from a paid receipt, never CREDIT debt settlement.
async function validateStoreCredit(
  tx: Prisma.TransactionClient,
  record: {
    type: string;
    saleId?: string | null;
    customerId?: string | null;
    exchangeItems?: unknown[];
  },
  shopId: string,
) {
  if (record.type !== "STORE_CREDIT") return;
  if (!record.customerId)
    throw new ReturnEligibilityError("Store credit requires a customer");
  const customer = await tx.customer.findFirst({
    where: { id: record.customerId, shopId },
  });
  if (!customer)
    throw new ReturnEligibilityError("Customer not found in this shop");
  if (!record.saleId)
    throw new ReturnEligibilityError(
      "Store credit requires a paid sale receipt",
    );
  const sale = await tx.sale.findFirst({
    where: { id: record.saleId, shopId },
  });
  if (
    !sale ||
    sale.status !== "COMPLETED" ||
    sale.paymentMethod === "CREDIT" ||
    round2(sale.amountPaid) < round2(sale.totalAmount)
  )
    throw new ReturnEligibilityError(
      "Store credit requires a fully paid non-CREDIT sale; debt settlement is separate",
    );
  if (record.exchangeItems?.length)
    throw new ReturnEligibilityError(
      "Store credit cannot also provide exchange items",
    );
}

export const createReturnSchema = Joi.object({
  saleId: Joi.string().optional(),
  customerId: Joi.string().optional(),
  reason: Joi.string().required().min(3).max(500),
  type: Joi.string().required().valid("REFUND", "EXCHANGE", "STORE_CREDIT"),
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
  exchangeItems: Joi.when('type', {
    is: 'EXCHANGE',
    then: Joi.array().items(Joi.object({
      productId: Joi.string().required(),
      quantity: Joi.number().required().integer().min(1),
    })).min(1).required(),
    otherwise: Joi.forbidden(),
  }),
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
    .valid("PENDING", "APPROVED", "COMPLETED", "REJECTED"),
  type: Joi.string().optional().valid("REFUND", "EXCHANGE", "STORE_CREDIT"),
  startDate: Joi.date().optional(),
  endDate: Joi.date().optional(),
});

export const processReturnSchema = Joi.object({
  action: Joi.string().required().valid('approve', 'reject', 'complete'),
  settlement: Joi.object({
    method: Joi.string().required().valid('CASH', 'CARD', 'MOMO', 'EMALI'),
    confirmed: Joi.boolean().valid(true).required(),
    reference: Joi.string().trim().min(1).max(200).when('method', {
      is: 'CASH', then: Joi.optional(), otherwise: Joi.required(),
    }),
  }).when('action', { is: 'complete', then: Joi.optional(), otherwise: Joi.forbidden() }),
  notes: Joi.string().optional().max(1000),
});

export class ReturnController {
  /**
   * Create a new return
   */
  static async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, "Unauthorized");
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
          ApiResponse.badRequest(res, "Customer not found in this shop");
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
        validateExchangeShape(type, saleId, exchangeItems);
        if (type !== "EXCHANGE" && exchangeItems !== undefined)
          throw new ReturnEligibilityError("Only exchanges can contain replacement items");
        let debtorId = customerId;
        let isCreditSale = false;
        await validateReturnProducts(tx, shopId, [
          ...items,
          ...(exchangeItems ?? []),
        ]);
        if (!saleId)
          await validateStoreCredit(
            tx,
            { type, saleId, customerId, exchangeItems },
            shopId,
          );
        if (saleId) {
          await lockSale(tx, saleId);
          const debt = await validateCreditReturn(tx, {
            saleId,
            shopId,
            customerId,
            type,
            exchangeItems: exchangeItems ?? [],
          });
          isCreditSale = debt !== null;
          if (debt) debtorId = debt.customerId;
          else
            await validateStoreCredit(
              tx,
              { type, saleId, customerId, exchangeItems },
              shopId,
            );
          const remaining = await loadEntitlement(tx, saleId, shopId);
          const requested = new Map<string, any>();
          for (const item of items) {
            const existing = requested.get(item.productId);
            if (existing && existing.restockable !== (item.restockable ?? true))
              throw new ReturnEligibilityError(
                "Duplicate lines must agree on restocking",
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
              throw new ReturnEligibilityError("Item was not part of the sale");
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

        if (type === "STORE_CREDIT" && calculatedRefund <= 0)
          throw new ReturnEligibilityError(
            "Store credit entitlement must be positive",
          );

        const replacements = type === "EXCHANGE"
          ? await priceReplacements(tx, shopId, exchangeItems, calculatedRefund)
          : [];

        // Create the return
        return tx.return.create({
          data: {
            shopId,
            saleId: saleId ?? undefined,
            customerId: debtorId ?? undefined,
            userId: req.user!.type === "user" ? req.user!.id : undefined,
            reason,
            type,
            refundAmount:
              type === "REFUND" || (type === "STORE_CREDIT" && !isCreditSale)
                ? calculatedRefund
                : 0,
            status: "PENDING",
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
            exchangeItems: { create: replacements },
          },
          include: returnDetails,
        });
      });

      ApiResponse.created(res, returnRecord, "Return created successfully");
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
        ApiResponse.unauthorized(res, "Unauthorized");
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
        ApiResponse.unauthorized(res, "Unauthorized");
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
          orderBy: { createdAt: "desc" },
          include: returnDetails,
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
        ApiResponse.unauthorized(res, "Unauthorized");
        return;
      }

      const returnRecord = await prisma.return.findFirst({
        where: {
          id: req.params.id,
          shopId: req.user!.shopId,
        },
        include: returnDetails,
      });

      if (!returnRecord) {
        ApiResponse.notFound(res, "Return not found");
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
        ApiResponse.unauthorized(res, "Unauthorized");
        return;
      }

      const { action, notes, settlement } = req.body;
      const returnId = req.params.id;

      const updated = await prisma.$transaction(async (tx) => {
        const reference = await tx.return.findFirst({
          where: { id: returnId, shopId: req.user!.shopId },
        });
        if (!reference) throw new ReturnEligibilityError("Return not found");
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
          throw new ReturnEligibilityError("Return not found");
        }
        if (!["PENDING", "APPROVED"].includes(returnRecord.status))
          throw new ReturnEligibilityError("Return is already final");
        let isCreditSale = false;
        if (action !== "reject") {
          validateExchangeShape(returnRecord.type, returnRecord.saleId, returnRecord.exchangeItems);
          const debt = returnRecord.saleId
            ? await validateCreditReturn(tx, {
                ...returnRecord,
                saleId: returnRecord.saleId,
              })
            : null;
          isCreditSale = debt !== null;
          if (!debt)
            await validateStoreCredit(tx, returnRecord, req.user!.shopId);
        }
        if (action !== "reject" && returnRecord.saleId) {
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
              throw new ReturnEligibilityError("Return is no longer eligible");
          }
          if (
            (returnRecord.type === "REFUND" ||
              (returnRecord.type === "STORE_CREDIT" && !isCreditSale)) &&
            Math.round(returnRecord.refundAmount * 100) !==
              Math.round([...grouped.values()].reduce((n, v) => n + v.cents, 0))
          )
            throw new ReturnEligibilityError(
              "Return refund does not match reserved value",
            );
        }

        // Rejection only releases the reservation; missing or moved inventory
        // must not prevent cancelling a pending return.
        if (action !== "reject") {
          await validateReturnProducts(tx, req.user!.shopId, [
            ...returnRecord.items,
            ...returnRecord.exchangeItems,
          ]);
        }

        let newStatus: string;
        let updateData: any = { notes: notes || returnRecord.notes };

        switch (action) {
          case "approve":
            newStatus = "APPROVED";
            break;
          case "reject":
            newStatus = "REJECTED";
            break;
          case "complete": {
            newStatus = "COMPLETED";
            updateData.processedAt = new Date();
            if (returnRecord.type === 'REFUND' && returnRecord.status !== 'APPROVED')
              throw new ReturnEligibilityError('Approve the return before completing it');
            if (returnRecord.type === 'REFUND') {
              // Credit repayments are customer-ledger entries, not proof that
              // this sale was paid. Never manufacture a payout from unpaid debt.
              if (returnRecord.saleId) {
                const sale = await tx.sale.findFirst({ where: { id: returnRecord.saleId, shopId: req.user!.shopId } });
                if (!sale || sale.paymentMethod === 'CREDIT')
                  throw new ReturnEligibilityError('CREDIT-sale refunds require debt settlement; payout is unsupported');
              }
              if (!settlement || settlement.confirmed !== true ||
                  !['CASH', 'CARD', 'MOMO', 'EMALI'].includes(settlement.method))
                throw new ReturnEligibilityError('Confirm the actual refund payment and settlement method');
              if (settlement.method !== 'CASH' && !settlement.reference?.trim())
                throw new ReturnEligibilityError('Record the successful external refund reference');
              updateData.settlementMethod = settlement.method;
              updateData.settlementReference = settlement.reference?.trim() || null;
              if (settlement.method === 'CASH') {
                // Same row lock as close(): a payout either commits before the
                // closing tally or is refused after close. Prior-sale dates do
                // not affect attribution; cash leaves the current drawer.
                const sessionId = await CashSessionService.lockOpenSessionId(tx, req.user!.shopId);
                if (!sessionId)
                  throw new ReturnEligibilityError('Open till required; till may have closed before refund confirmation');
                updateData.cashSessionId = sessionId;
              }
              updateData.settledAt = new Date();
            } else if (settlement) {
              throw new ReturnEligibilityError('Only REFUND returns can record a money payout');
            }

            const userId = req.user!.type === "user" ? req.user!.id : undefined;
            const shopId = req.user!.shopId;
            await settleCreditReturn(tx, returnRecord, userId);
            if (returnRecord.type === "STORE_CREDIT" && !isCreditSale) {
              if (returnRecord.refundAmount <= 0)
                throw new ReturnEligibilityError(
                  "Store credit entitlement must be positive",
                );
              await applyCustomerCredit(
                tx,
                {
                  shopId,
                  customerId: returnRecord.customerId!,
                  type: "REFUND",
                  amount: returnRecord.refundAmount,
                  returnId,
                  userId,
                  note: `Store credit for return #${returnId}`,
                },
                { currencySymbol: "" },
              );
            }

            // Lock the entire return/exchange batch in the same stable order as
            // StockService.receive, before reading any inventory snapshots.
            const productIds = [...new Set(
              [...returnRecord.items, ...returnRecord.exchangeItems].map(item => item.productId),
            )];
            if (productIds.length) await tx.$queryRaw`
              SELECT id FROM "Product"
              WHERE id IN (${Prisma.join(productIds)}) AND "shopId" = ${shopId}
              ORDER BY id FOR UPDATE`;

            let replacements: Array<{ productId: string; quantity: number }> = returnRecord.exchangeItems;
            if (returnRecord.type === "EXCHANGE") {
              const priced = await priceReplacements(tx, shopId, returnRecord.exchangeItems,
                returnRecord.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0));
              // Persisted prices must still match authoritative prices, including
              // historical records. A changed price requires a new exchange.
              for (const line of priced) {
                const persisted = returnRecord.exchangeItems.filter(item => item.productId === line.productId);
                if (Math.round(persisted.reduce((sum, item) => sum + item.quantity * item.unitPrice * 100, 0)) !== Math.round(line.quantity * line.unitPrice * 100))
                  throw new ReturnEligibilityError("Replacement prices changed; create a new exchange");
              }
              replacements = priced;
              for (const item of replacements) {
                const product = await tx.product.findUnique({ where: { id: item.productId } });
                if (!product || product.shopId !== shopId) throw new ReturnEligibilityError("Replacement product not found in this shop");
                const restock = returnRecord.items.filter(line => line.productId === item.productId && line.restockable && !line.restocked)
                  .reduce((sum, line) => sum + line.quantity, 0);
                if (product.trackStock && product.quantity + restock < item.quantity)
                  throw new ReturnEligibilityError(`Insufficient stock for ${product.name}`);
              }
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
                      "Return product not found in this shop",
                    );

                  if (!product.trackStock) continue;

                  const previousQty = product.quantity;
                  const newQty = previousQty + item.quantity;

                  await tx.product.update({
                    where: { id: item.productId },
                    data: { quantity: { increment: item.quantity } },
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
                      type: "RETURN",
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
              if (replacements.length) {
                for (const item of replacements) {
                  const product = await tx.product.findUnique({
                    where: { id: item.productId },
                  });
                  if (!product || product.shopId !== shopId)
                    throw new ReturnEligibilityError(
                      "Return product not found in this shop",
                    );

                  const shop = await tx.shop.findUnique({ where: { id: shopId } });
                  if (!shop) throw new ReturnEligibilityError("Shop not found");
                  // Replacement unitPrice already includes VAT. Keep snapshots on
                  // each persisted line; stock demand above is grouped by product.
                  for (const line of returnRecord.exchangeItems.filter(line => line.productId === item.productId)) {
                    const valuation = computeTax(line.quantity * line.unitPrice, 0, { ...shop, taxInclusive: true });
                    await tx.returnExchangeItem.update({
                      where: { id: line.id },
                      data: { costPrice: product.costPrice, tax: valuation.tax, totalAmount: valuation.total },
                    });
                  }
                  if (!product.trackStock) continue;

                  const previousQty = product.quantity;
                  const newQty = previousQty - item.quantity;

                  await tx.product.update({
                    where: { id: item.productId },
                    data: { quantity: { decrement: item.quantity } },
                  });
                  // Log stock movement (negative quantity = stock removed)
                  await tx.stockLog.create({
                    data: {
                      shopId,
                      productId: item.productId,
                      userId,
                      type: "SALE",
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
            throw new ReturnEligibilityError("Invalid action");
        }

        updateData.status = newStatus;

        return tx.return.update({
          where: { id: returnId },
          data: updateData,
          include: returnDetails,
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
