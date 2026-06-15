import { prisma } from '@config/prisma';
import { Prisma, PaymentMethod, SaleStatus } from '@prisma/client';
import { paginate, paginationMeta } from '@utils/pagination';
import { computeTax } from '@utils/tax';
import { ShopService } from './shop.service';
import { CashSessionService } from './cashSession.service';

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
      
      // Check stock
      if (product.trackStock && product.quantity < item.quantity) {
        throw new Error(`Insufficient stock for ${product.name}. Available: ${product.quantity}`);
      }

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

    // CREDIT ("on the book" / pay-later) sales: nothing is tendered now, so the
    // amountPaid>=total guard below is intentionally skipped and amountPaid/
    // change are forced to 0 regardless of what the client sent. The full total
    // is instead added to the customer's running balance (the CustomerCredit
    // PURCHASE entry + balance increment inside the transaction). A credit sale
    // MUST be attached to a customer, and must not push them past their limit.
    const isCredit = input.paymentMethod === 'CREDIT';
    let amountPaid: number;
    let change: number;
    let creditCustomer: { id: string; balance: number; creditLimit: number } | null = null;

    if (isCredit) {
      if (!input.customerId) {
        throw new Error('A customer is required for credit (pay-later) sales');
      }

      creditCustomer = await prisma.customer.findFirst({
        where: { id: input.customerId, shopId: input.shopId },
        select: { id: true, balance: true, creditLimit: true },
      });
      if (!creditCustomer) {
        throw new Error('Customer not found for credit sale');
      }

      const newBalance = creditCustomer.balance + totalAmount;
      // creditLimit 0 = no limit configured (matches the Customers UI, which
      // only shows a limit badge when creditLimit > 0). Enforce only when set.
      if (creditCustomer.creditLimit > 0 && newBalance > creditCustomer.creditLimit) {
        throw new Error(
          `Credit limit exceeded. Limit: ${creditCustomer.creditLimit}, current balance: ${creditCustomer.balance}, this sale: ${totalAmount}. New balance would be ${newBalance}.`,
        );
      }

      amountPaid = 0;
      change = 0;
    } else {
      amountPaid = input.amountPaid;
      change = amountPaid - totalAmount;

      if (change < 0) {
        throw new Error(`Insufficient payment. Required: ${totalAmount}, Received: ${input.amountPaid}`);
      }
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

    // Create sale and update stock in a transaction
    let sale;
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

      // Create sale
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
          amountPaid,
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

      // Update stock and create stock logs
      for (const item of input.items) {
        const product = productMap.get(item.productId)!;

        if (product.trackStock) {
          const newQty = product.quantity - item.quantity;

          await tx.product.update({
            where: { id: item.productId },
            data: { quantity: newQty },
          });

          await tx.stockLog.create({
            data: {
              shopId: input.shopId,
              productId: item.productId,
              userId: input.userId,
              type: 'SALE',
              quantity: -item.quantity,
              previousQty: product.quantity,
              newQty,
              reference: sale.id,
            },
          });
        }
      }

      // Credit ("on the book") sale: record the PURCHASE in the customer ledger
      // and increase their outstanding balance — same effect as
      // CustomerController.addCredit, but committed atomically with the sale so
      // stock + ledger + balance can never drift apart. amountPaid/change are
      // already 0 (set above). Stock is still decremented in the loop above, so
      // credit sales draw down inventory like any other sale.
      let customerBalance: number | undefined;
      if (isCredit) {
        await tx.customerCredit.create({
          data: {
            shopId: input.shopId,
            customerId: input.customerId!,
            type: 'PURCHASE',
            amount: totalAmount,
            saleId: sale.id,
            userId: input.userId,
            note: `Credit sale ${sale.receiptNumber ?? sale.id}`,
          },
        });
        const updatedCustomer = await tx.customer.update({
          where: { id: input.customerId! },
          data: { balance: { increment: totalAmount } },
        });
        customerBalance = updatedCustomer.balance;
      }

      // Expose the customer's new outstanding balance on the sale so the POS
      // receipt can print it for credit sales (undefined for non-credit).
      return { ...sale, customerBalance };
      });
    } catch (err) {
      // Race-proof idempotency backstop: two in-flight replays of the same
      // localId — the loser hits the @@unique([shopId, localId]) constraint.
      // Return the winner's committed sale instead of surfacing a 500.
      if (
        input.localId &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await prisma.sale.findFirst({
          where: { shopId: input.shopId, localId: input.localId },
          include: { items: true },
        });
        if (existing) return existing;
      }
      throw err;
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
  static async voidSale(saleId: string, shopId: string, userId: string, reason: string) {
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
