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
