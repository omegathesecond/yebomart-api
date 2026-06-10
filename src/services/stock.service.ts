import { prisma } from '@config/prisma';
import { Prisma, StockLogType } from '@prisma/client';
import { paginate, paginationMeta } from '@utils/pagination';
import { ShopService } from './shop.service';

interface AdjustStockInput {
  shopId: string;
  productId: string;
  userId?: string;
  type: StockLogType;
  quantity: number; // Positive for add, negative for remove
  note?: string;
  reference?: string;
}

interface ReceiveStockInput {
  shopId: string;
  userId?: string;
  items: {
    productId: string;
    quantity: number;
    note?: string;
  }[];
  reference?: string; // PO number, supplier name, etc.
}

interface ListMovementsParams {
  shopId: string;
  productId?: string;
  type?: StockLogType;
  page?: number;
  limit?: number;
  startDate?: Date;
  endDate?: Date;
}

export class StockService {
  /**
   * Adjust stock for a single product
   */
  static async adjust(input: AdjustStockInput) {
    const product = await prisma.product.findFirst({
      where: {
        id: input.productId,
        shopId: input.shopId,
      },
    });

    if (!product) {
      throw new Error('Product not found');
    }

    const newQty = product.quantity + input.quantity;

    if (newQty < 0) {
      throw new Error(`Cannot reduce stock below 0. Current: ${product.quantity}`);
    }

    const [updatedProduct, stockLog] = await prisma.$transaction([
      prisma.product.update({
        where: { id: input.productId },
        data: { quantity: newQty },
      }),
      prisma.stockLog.create({
        data: {
          shopId: input.shopId,
          productId: input.productId,
          userId: input.userId,
          type: input.type,
          quantity: input.quantity,
          previousQty: product.quantity,
          newQty,
          note: input.note,
          reference: input.reference,
          syncedAt: new Date(),
        },
      }),
    ]);

    // Increment usage
    await ShopService.incrementUsage(input.shopId, 'stockMove');

    return {
      product: updatedProduct,
      stockLog,
    };
  }

  /**
   * Receive stock for multiple products (bulk restock)
   */
  static async receive(input: ReceiveStockInput) {
    const productIds = input.items.map(item => item.productId);
    
    const products = await prisma.product.findMany({
      where: {
        id: { in: productIds },
        shopId: input.shopId,
      },
    });

    if (products.length !== productIds.length) {
      throw new Error('One or more products not found');
    }

    const productMap = new Map(products.map(p => [p.id, p]));

    const result = await prisma.$transaction(async (tx) => {
      const updates = [];

      for (const item of input.items) {
        if (item.quantity <= 0) {
          throw new Error('Quantity must be positive for stock receive');
        }

        const product = productMap.get(item.productId)!;
        const newQty = product.quantity + item.quantity;

        const [updatedProduct, stockLog] = await Promise.all([
          tx.product.update({
            where: { id: item.productId },
            data: { quantity: newQty },
          }),
          tx.stockLog.create({
            data: {
              shopId: input.shopId,
              productId: item.productId,
              userId: input.userId,
              type: 'RESTOCK',
              quantity: item.quantity,
              previousQty: product.quantity,
              newQty,
              note: item.note,
              reference: input.reference,
              syncedAt: new Date(),
            },
          }),
        ]);

        updates.push({ product: updatedProduct, stockLog });
      }

      return updates;
    });

    // Increment usage for each item
    for (let i = 0; i < input.items.length; i++) {
      await ShopService.incrementUsage(input.shopId, 'stockMove');
    }

    return result;
  }

  /**
   * Get low stock alerts
   */
  static async getLowStockAlerts(shopId: string) {
    const products = await prisma.product.findMany({
      where: {
        shopId,
        isActive: true,
        trackStock: true,
      },
      select: {
        id: true,
        name: true,
        barcode: true,
        quantity: true,
        reorderAt: true,
        unit: true,
        category: true,
      },
      orderBy: { quantity: 'asc' },
    });

    // Filter to only low stock items
    const lowStock = products.filter(p => p.quantity <= p.reorderAt);

    // Categorize
    const critical = lowStock.filter(p => p.quantity === 0);
    const low = lowStock.filter(p => p.quantity > 0 && p.quantity <= p.reorderAt / 2);
    const warning = lowStock.filter(p => p.quantity > p.reorderAt / 2);

    return {
      total: lowStock.length,
      critical: critical.length,
      low: low.length,
      warning: warning.length,
      items: {
        critical,
        low,
        warning,
      },
    };
  }

  /**
   * Sales-velocity reorder suggestions.
   *
   * For every active, stock-tracked product we compute the average daily sales
   * velocity over a trailing window (from COMPLETED sales only), the predicted
   * days of cover at the current quantity, and a suggested reorder quantity that
   * tops the product up to `targetCoverDays` worth of demand.
   *
   * A product is flagged when it is predicted to run out within `within` days
   * OR it is already at/below its reorder threshold. Products with NO sales in
   * the window are only surfaced if they are below `reorderAt` — we never
   * fabricate a velocity-based suggestion for a never-sold item.
   */
  static async getReorderSuggestions(
    shopId: string,
    opts: { days?: number; within?: number; targetCoverDays?: number } = {},
  ) {
    const days = opts.days && opts.days > 0 ? opts.days : 30;
    const within = opts.within && opts.within > 0 ? opts.within : 7;
    const targetCoverDays =
      opts.targetCoverDays && opts.targetCoverDays > 0 ? opts.targetCoverDays : 14;

    const windowStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const products = await prisma.product.findMany({
      where: {
        shopId,
        isActive: true,
        trackStock: true,
      },
      select: {
        id: true,
        name: true,
        barcode: true,
        category: true,
        unit: true,
        quantity: true,
        reorderAt: true,
        costPrice: true,
      },
    });

    if (products.length === 0) {
      return { window: { days, within, targetCoverDays }, total: 0, items: [] };
    }

    // Sum units sold per product over the window from COMPLETED sales only.
    // SaleItem has no shopId of its own, so we scope through the parent Sale.
    const sold = await prisma.saleItem.groupBy({
      by: ['productId'],
      where: {
        productId: { in: products.map(p => p.id) },
        sale: {
          shopId,
          status: 'COMPLETED',
          createdAt: { gte: windowStart },
        },
      },
      _sum: { quantity: true },
    });

    const soldMap = new Map(sold.map(row => [row.productId, row._sum.quantity ?? 0]));

    const items = [];

    for (const product of products) {
      const unitsSold = soldMap.get(product.id) ?? 0;
      const velocityPerDay = unitsSold / days;
      const belowReorder = product.quantity <= product.reorderAt;

      if (velocityPerDay <= 0) {
        // Never sold in the window — only a threshold alert, no prediction.
        if (!belowReorder) continue;

        items.push({
          productId: product.id,
          name: product.name,
          barcode: product.barcode,
          category: product.category,
          unit: product.unit,
          quantity: product.quantity,
          reorderAt: product.reorderAt,
          costPrice: product.costPrice,
          velocityPerDay: 0,
          daysOfCover: null as number | null, // no sales → infinite cover; null is JSON-safe
          suggestedReorderQty: 0, // don't fabricate a qty for a never-sold item
          reason: 'below_reorder' as const,
        });
        continue;
      }

      const daysOfCover = product.quantity / velocityPerDay;
      const predictedStockout = daysOfCover <= within;

      if (!predictedStockout && !belowReorder) continue;

      const suggestedReorderQty = Math.max(
        0,
        Math.ceil(velocityPerDay * targetCoverDays) - product.quantity,
      );

      items.push({
        productId: product.id,
        name: product.name,
        barcode: product.barcode,
        category: product.category,
        unit: product.unit,
        quantity: product.quantity,
        reorderAt: product.reorderAt,
        costPrice: product.costPrice,
        velocityPerDay: Math.round(velocityPerDay * 100) / 100,
        daysOfCover: Math.round(daysOfCover * 10) / 10 as number | null,
        suggestedReorderQty,
        reason: predictedStockout
          ? ('predicted_stockout' as const)
          : ('below_reorder' as const),
      });
    }

    // Soonest stock-out first; never-sold (null cover) items sink to the bottom.
    items.sort((a, b) => {
      const ax = a.daysOfCover ?? Number.POSITIVE_INFINITY;
      const bx = b.daysOfCover ?? Number.POSITIVE_INFINITY;
      return ax - bx;
    });

    return {
      window: { days, within, targetCoverDays },
      total: items.length,
      items,
    };
  }

  /**
   * Get stock movements with filtering and pagination
   */
  static async getMovements(params: ListMovementsParams) {
    const { skip, take, page, limit } = paginate(params);

    const where: Prisma.StockLogWhereInput = {
      shopId: params.shopId,
    };

    if (params.productId) {
      where.productId = params.productId;
    }

    if (params.type) {
      where.type = params.type;
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

    const [movements, total] = await Promise.all([
      prisma.stockLog.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          product: {
            select: { id: true, name: true, barcode: true },
          },
          user: {
            select: { id: true, name: true },
          },
        },
      }),
      prisma.stockLog.count({ where }),
    ]);

    return {
      movements,
      ...paginationMeta(total, page, limit),
    };
  }

  /**
   * Get current stock levels for all products
   */
  static async getStockLevels(shopId: string) {
    const products = await prisma.product.findMany({
      where: {
        shopId,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        barcode: true,
        category: true,
        quantity: true,
        reorderAt: true,
        unit: true,
        costPrice: true,
        sellPrice: true,
        trackStock: true,
      },
      orderBy: [
        { category: 'asc' },
        { name: 'asc' },
      ],
    });

    // Calculate total stock value
    let totalCostValue = 0;
    let totalSellValue = 0;

    for (const product of products) {
      if (product.trackStock) {
        totalCostValue += product.costPrice * product.quantity;
        totalSellValue += product.sellPrice * product.quantity;
      }
    }

    return {
      products,
      summary: {
        totalProducts: products.length,
        totalCostValue,
        totalSellValue,
        potentialProfit: totalSellValue - totalCostValue,
      },
    };
  }
}
