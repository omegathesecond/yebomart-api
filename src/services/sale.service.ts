import { prisma } from '@config/prisma';
import { Prisma, PaymentMethod, SaleStatus } from '@prisma/client';
import { paginate, paginationMeta } from '@utils/pagination';
import { computeTax } from '@utils/tax';
import { ShopService } from './shop.service';
import { CashSessionService } from './cashSession.service';

/**
 * Is `err` a Prisma unique-constraint violation (P2002) on a constraint that
 * involves `field`? Sale now has TWO unique constraints that can both raise
 * P2002 from create() — @@unique([shopId, localId]) and
 * @@unique([shopId, receiptNumber]) — so we must distinguish them by the
 * offending column. `meta.target` is either the field-name array (Prisma's
 * default) or the constraint name string (e.g. "Sale_shopId_receiptNumber_key"),
 * both of which contain the field name, so a substring check is robust to either.
 */
function isUniqueViolationOn(err: unknown, field: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return false;
  }
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  if (Array.isArray(target)) return target.some((t) => String(t).includes(field));
  return String(target ?? '').includes(field);
}

interface SaleItemInput {
  productId: string;
  quantity: number;
  discount?: number;
}

interface CreateSaleInput {
  shopId: string;
  userId?: string;
  customerId?: string | null;
  items: SaleItemInput[];
  paymentMethod: PaymentMethod;
  amountPaid: number;
  discount?: number;
  localId?: string;
  offlineAt?: Date;
}

interface ListSalesParams {
  shopId: string;
  page?: number;
  limit?: number;
  status?: SaleStatus;
  paymentMethod?: PaymentMethod;
  startDate?: Date;
  endDate?: Date;
  userId?: string;
}

export class SaleService {
  /**
   * Create a new sale
   */
  static async create(input: CreateSaleInput) {
    // Idempotency: offline sales carry a client-generated `localId`. If the
    // device replays a queued sale (or a request whose response was lost on a
    // flaky link), return the already-committed sale instead of creating a
    // duplicate / double-decrementing stock. This is the server-side half of
    // the POS offline outbox; the @@unique([shopId, localId]) index is the
    // race-proof backstop for the findFirst below.
    if (input.localId) {
      const existing = await prisma.sale.findFirst({
        where: { shopId: input.shopId, localId: input.localId },
        include: { items: true },
      });
      if (existing) return existing;
    }

    // Get all products
    const productIds = input.items.map(item => item.productId);
    const products = await prisma.product.findMany({
      where: {
        id: { in: productIds },
        shopId: input.shopId,
        isActive: true,
      },
    });

    if (products.length !== productIds.length) {
      throw new Error('One or more products not found');
    }

    const productMap = new Map(products.map(p => [p.id, p]));

    // Calculate totals
    let subtotal = 0;
    const saleItems: Prisma.SaleItemCreateWithoutSaleInput[] = [];

    for (const item of input.items) {
      const product = productMap.get(item.productId)!;

      // NOTE: stock availability is NOT checked here. This read is outside the
      // transaction and therefore stale — checking it here would be a
      // check-then-act race (two concurrent sales both pass, both decrement).
      // The authoritative, race-proof check is the atomic guarded decrement
      // inside the $transaction below.

      const itemDiscount = item.discount || 0;
      const itemTotal = (product.sellPrice * item.quantity) - itemDiscount;

      subtotal += itemTotal;

      saleItems.push({
        product: { connect: { id: item.productId } },
        productName: product.name,
        quantity: item.quantity,
        unitPrice: product.sellPrice,
        costPrice: product.costPrice,
        discount: itemDiscount,
        totalPrice: itemTotal,
      });
    }

    const discount = input.discount || 0;

    // VAT. The shop's tax config is authoritative — the client computes the
    // same figure for display, but we recompute here so the persisted Sale.tax
    // and totalAmount can't be spoofed by the request body. Existing shops
    // default to taxRate 0 → tax 0, total = subtotal - discount (unchanged).
    const shop = await prisma.shop.findUnique({
      where: { id: input.shopId },
      select: { taxRate: true, taxInclusive: true },
    });
    if (!shop) {
      throw new Error('Shop not found');
    }
    const { tax, total: totalAmount } = computeTax(subtotal, discount, {
      taxRate: shop.taxRate,
      taxInclusive: shop.taxInclusive,
    });
    const change = input.amountPaid - totalAmount;

    if (change < 0) {
      throw new Error(`Insufficient payment. Required: ${totalAmount}, Received: ${input.amountPaid}`);
    }

    // Cash-drawer attribution: tag CASH sales to the open till session so the
    // end-of-day cash-up reconciles against exactly this shift. Best-effort —
    // a lookup failure or no open session must never block the sale, so we
    // swallow errors and leave cashSessionId null.
    let cashSessionId: string | null = null;
    if (input.paymentMethod === 'CASH') {
      try {
        cashSessionId = await CashSessionService.findOpenSessionId(input.shopId);
      } catch {
        cashSessionId = null;
      }
    }

    // Create sale and decrement stock in a transaction.
    //
    // The whole transaction is wrapped in a retry loop for ONE reason: receipt
    // numbers are minted from a per-shop daily count, and two concurrent sales
    // can compute the same number. The @@unique([shopId, receiptNumber])
    // constraint turns that collision into a P2002 on insert; we catch it,
    // re-run the transaction (which recomputes the count — now including the
    // winner — and so advances to the next number), and try again. A failed
    // statement aborts the whole Postgres transaction, so the retry MUST be at
    // the transaction boundary, not inside it.
    const MAX_RECEIPT_RETRIES = 5;
    let sale;
    for (let attempt = 0; ; attempt++) {
      try {
        sale = await prisma.$transaction(async (tx) => {
          // Generate receipt number (e.g., RCP-240212-0001)
          const today = new Date();
          const dateStr = today.toISOString().slice(2, 10).replace(/-/g, ''); // YYMMDD

          // Get count of sales today for this shop
          const startOfDay = new Date(today);
          startOfDay.setHours(0, 0, 0, 0);
          const endOfDay = new Date(today);
          endOfDay.setHours(23, 59, 59, 999);

          const todaySalesCount = await tx.sale.count({
            where: {
              shopId: input.shopId,
              createdAt: {
                gte: startOfDay,
                lte: endOfDay,
              },
            },
          });

          const receiptNumber = `RCP-${dateStr}-${String(todaySalesCount + 1).padStart(4, '0')}`;

          // Decrement stock FIRST with an atomic, guarded write so an oversell
          // can never even create the sale. Doing this before tx.sale.create
          // means a stock shortfall throws before any Sale/SaleItem rows exist,
          // and the transaction rolls back cleanly.
          const stockLogData: Prisma.StockLogCreateManyInput[] = [];
          for (const item of input.items) {
            const product = productMap.get(item.productId)!;
            if (!product.trackStock) continue;

            // Atomic conditional decrement: updateMany lets us put the
            // `quantity >= qty` guard in the WHERE (update() only accepts unique
            // fields) and tells us how many rows it touched. count === 0 means
            // another concurrent sale already took the stock — fail loudly, NO
            // silent partial sale. There is no stale read here: the guard is
            // evaluated against the row's CURRENT committed value.
            const res = await tx.product.updateMany({
              where: {
                id: item.productId,
                shopId: input.shopId,
                trackStock: true,
                quantity: { gte: item.quantity },
              },
              data: { quantity: { decrement: item.quantity } },
            });

            if (res.count === 0) {
              // Re-read the live quantity purely for an accurate error message.
              const live = await tx.product.findUnique({
                where: { id: item.productId },
                select: { quantity: true },
              });
              throw new Error(
                `Insufficient stock for ${product.name}. Available: ${live?.quantity ?? 0}`
              );
            }

            // Re-read the post-decrement quantity for the stock-log snapshot.
            const updated = await tx.product.findUnique({
              where: { id: item.productId },
              select: { quantity: true },
            });
            const newQty = updated!.quantity;

            stockLogData.push({
              shopId: input.shopId,
              productId: item.productId,
              userId: input.userId,
              type: 'SALE',
              quantity: -item.quantity,
              previousQty: newQty + item.quantity,
              newQty,
              // reference (sale.id) is filled in after the sale is created.
              reference: '',
            });
          }

          // Create sale (stock already reserved atomically above).
          const sale = await tx.sale.create({
            data: {
              shopId: input.shopId,
              userId: input.userId,
              customerId: input.customerId || undefined,
              cashSessionId: cashSessionId || undefined,
              receiptNumber,
              subtotal,
              discount,
              tax,
              totalAmount,
              paymentMethod: input.paymentMethod,
              amountPaid: input.amountPaid,
              change,
              status: 'COMPLETED',
              localId: input.localId,
              offlineAt: input.offlineAt,
              syncedAt: new Date(),
              items: {
                create: saleItems,
              },
            },
            include: {
              items: true,
            },
          });

          // Now that we have the sale id, write the stock logs.
          for (const log of stockLogData) {
            await tx.stockLog.create({ data: { ...log, reference: sale.id } });
          }

          return sale;
        });
        break; // committed successfully
      } catch (err) {
        // Race-proof idempotency backstop: two in-flight replays of the same
        // localId — the loser hits the @@unique([shopId, localId]) constraint.
        // Return the winner's committed sale instead of surfacing a 500.
        if (input.localId && isUniqueViolationOn(err, 'localId')) {
          const existing = await prisma.sale.findFirst({
            where: { shopId: input.shopId, localId: input.localId },
            include: { items: true },
          });
          if (existing) return existing;
        }

        // Receipt-number collision under concurrency: the @@unique([shopId,
        // receiptNumber]) constraint fired. Retry the whole transaction — the
        // recomputed count now includes the winner, so we advance to the next
        // number. Bounded so a genuine, persistent fault can't spin forever.
        if (isUniqueViolationOn(err, 'receiptNumber') && attempt < MAX_RECEIPT_RETRIES) {
          continue;
        }

        throw err;
      }
    }

    // Increment usage counter
    await ShopService.incrementUsage(input.shopId, 'transaction');

    return sale;
  }

  /**
   * List sales with filtering and pagination
   */
  static async list(params: ListSalesParams) {
    const { skip, take, page, limit } = paginate(params);

    const where: Prisma.SaleWhereInput = {
      shopId: params.shopId,
    };

    if (params.status) {
      where.status = params.status;
    }

    if (params.paymentMethod) {
      where.paymentMethod = params.paymentMethod;
    }

    if (params.userId) {
      where.userId = params.userId;
    }

    if (params.startDate || params.endDate) {
      where.createdAt = {};
      if (params.startDate) {
        where.createdAt.gte = params.startDate;
      }
      if (params.endDate) {
        where.createdAt.lte = params.endDate;
      }
    }

    const [sales, total] = await Promise.all([
      prisma.sale.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          items: {
            select: {
              id: true,
              productName: true,
              quantity: true,
              unitPrice: true,
              totalPrice: true,
            },
          },
          user: {
            select: { id: true, name: true },
          },
        },
      }),
      prisma.sale.count({ where }),
    ]);

    return {
      sales,
      ...paginationMeta(total, page, limit),
    };
  }

  /**
   * Get sale by ID
   */
  static async getById(saleId: string, shopId: string) {
    const sale = await prisma.sale.findFirst({
      where: {
        id: saleId,
        shopId,
      },
      include: {
        items: {
          include: {
            product: {
              select: { id: true, name: true, barcode: true },
            },
          },
        },
        user: {
          select: { id: true, name: true },
        },
      },
    });

    if (!sale) {
      throw new Error('Sale not found');
    }

    return sale;
  }

  /**
   * Get sale by receipt number
   */
  static async getByReceiptNumber(receiptNumber: string, shopId: string) {
    // Support partial match (e.g., "0001" matches "RCP-260212-0001")
    const sale = await prisma.sale.findFirst({
      where: {
        shopId,
        receiptNumber: {
          contains: receiptNumber.toUpperCase(),
          mode: 'insensitive',
        },
      },
      include: {
        items: {
          include: {
            product: {
              select: { id: true, name: true, barcode: true },
            },
          },
        },
        user: {
          select: { id: true, name: true },
        },
      },
    });

    if (!sale) {
      throw new Error('Sale not found with receipt number: ' + receiptNumber);
    }

    return sale;
  }

  /**
   * Void a sale
   */
  static async voidSale(saleId: string, shopId: string, userId: string | undefined, reason: string) {
    const sale = await prisma.sale.findFirst({
      where: {
        id: saleId,
        shopId,
        status: 'COMPLETED',
      },
      include: { items: true },
    });

    if (!sale) {
      throw new Error('Sale not found or already voided');
    }

    // Void and restore stock in transaction
    const updatedSale = await prisma.$transaction(async (tx) => {
      // Update sale status
      const updated = await tx.sale.update({
        where: { id: saleId },
        data: {
          status: 'VOIDED',
          voidReason: reason,
        },
      });

      // Restore stock
      for (const item of sale.items) {
        const product = await tx.product.findUnique({
          where: { id: item.productId },
        });

        if (product?.trackStock) {
          const newQty = product.quantity + item.quantity;

          await tx.product.update({
            where: { id: item.productId },
            data: { quantity: newQty },
          });

          await tx.stockLog.create({
            data: {
              shopId,
              productId: item.productId,
              userId,
              type: 'RETURN',
              quantity: item.quantity,
              previousQty: product.quantity,
              newQty,
              reference: saleId,
              note: `Voided: ${reason}`,
            },
          });
        }
      }

      return updated;
    });

    return updatedSale;
  }

  /**
   * Get daily summary
   */
  static async getDailySummary(shopId: string, date?: Date) {
    const targetDate = date || new Date();
    const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
    const endOfDay = new Date(startOfDay);
    endOfDay.setDate(endOfDay.getDate() + 1);

    const [sales, salesByMethod, topProducts] = await Promise.all([
      // Total sales
      prisma.sale.aggregate({
        where: {
          shopId,
          status: 'COMPLETED',
          createdAt: { gte: startOfDay, lt: endOfDay },
        },
        _sum: { totalAmount: true, discount: true },
        _count: true,
        _avg: { totalAmount: true },
      }),

      // Sales by payment method
      prisma.sale.groupBy({
        by: ['paymentMethod'],
        where: {
          shopId,
          status: 'COMPLETED',
          createdAt: { gte: startOfDay, lt: endOfDay },
        },
        _sum: { totalAmount: true },
        _count: true,
      }),

      // Top products
      prisma.saleItem.groupBy({
        by: ['productId', 'productName'],
        where: {
          sale: {
            shopId,
            status: 'COMPLETED',
            createdAt: { gte: startOfDay, lt: endOfDay },
          },
        },
        _sum: { quantity: true, totalPrice: true },
        orderBy: { _sum: { quantity: 'desc' } },
        take: 10,
      }),
    ]);

    // Calculate profit
    const saleItems = await prisma.saleItem.findMany({
      where: {
        sale: {
          shopId,
          status: 'COMPLETED',
          createdAt: { gte: startOfDay, lt: endOfDay },
        },
      },
      select: { quantity: true, costPrice: true, totalPrice: true },
    });

    let totalCost = 0;
    let totalRevenue = 0;
    for (const item of saleItems) {
      totalCost += item.costPrice * item.quantity;
      totalRevenue += item.totalPrice;
    }

    return {
      date: startOfDay,
      totalSales: sales._sum.totalAmount || 0,
      totalTransactions: sales._count,
      averageBasket: sales._avg.totalAmount || 0,
      totalDiscount: sales._sum.discount || 0,
      totalCost,
      grossProfit: totalRevenue - totalCost,
      byPaymentMethod: salesByMethod.map(m => ({
        method: m.paymentMethod,
        total: m._sum.totalAmount || 0,
        count: m._count,
      })),
      topProducts: topProducts.map(p => ({
        id: p.productId,
        name: p.productName,
        quantity: p._sum.quantity || 0,
        revenue: p._sum.totalPrice || 0,
      })),
    };
  }
}
