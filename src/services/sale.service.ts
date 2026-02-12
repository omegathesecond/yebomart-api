import { prisma } from '@config/prisma';
import { Prisma, PaymentMethod, SaleStatus } from '@prisma/client';
import { paginate, paginationMeta } from '@utils/pagination';
import { ShopService } from './shop.service';

interface SaleItemInput {
  productId: string;
  quantity: number;
  discount?: number;
}

interface CreateSaleInput {
  shopId: string;
  userId?: string;
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
    const tax = 0; // Could add VAT calculation here
    const totalAmount = subtotal - discount + tax;
    const change = input.amountPaid - totalAmount;

    if (change < 0) {
      throw new Error(`Insufficient payment. Required: ${totalAmount}, Received: ${input.amountPaid}`);
    }

    // Create sale and update stock in a transaction
    const sale = await prisma.$transaction(async (tx) => {
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

      return sale;
    });

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
