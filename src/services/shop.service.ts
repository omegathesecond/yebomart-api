import { prisma } from '@config/prisma';
import { Prisma } from '@prisma/client';

interface UpdateShopInput {
  name?: string;
  ownerName?: string;
  businessType?: string;
  assistantName?: string;
  currency?: string;
  timezone?: string;
  address?: string;
  logoUrl?: string;
}

export class ShopService {
  /**
   * Get shop by ID
   */
  static async getById(shopId: string) {
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: {
        id: true,
        name: true,
        ownerName: true,
        ownerPhone: true,
        ownerEmail: true,
        businessType: true,
        assistantName: true,
        currency: true,
        timezone: true,
        address: true,
        logoUrl: true,
        tier: true,
        licenseKey: true,
        licenseExpiry: true,
        monthlyTransactions: true,
        monthlyStockMoves: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            products: true,
            users: true,
          },
        },
      },
    });

    if (!shop) {
      throw new Error('Shop not found');
    }

    return shop;
  }

  /**
   * Update shop
   */
  static async update(shopId: string, data: UpdateShopInput) {
    const shop = await prisma.shop.update({
      where: { id: shopId },
      data,
      select: {
        id: true,
        name: true,
        ownerName: true,
        ownerPhone: true,
        ownerEmail: true,
        assistantName: true,
        currency: true,
        timezone: true,
        address: true,
        logoUrl: true,
        tier: true,
        updatedAt: true,
      },
    });

    return shop;
  }

  /**
   * Get shop stats
   */
  static async getStats(shopId: string) {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfDay);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Get sales stats
    const [todaySales, weekSales, monthSales] = await Promise.all([
      prisma.sale.aggregate({
        where: {
          shopId,
          status: 'COMPLETED',
          createdAt: { gte: startOfDay },
        },
        _sum: { totalAmount: true },
        _count: true,
      }),
      prisma.sale.aggregate({
        where: {
          shopId,
          status: 'COMPLETED',
          createdAt: { gte: startOfWeek },
        },
        _sum: { totalAmount: true },
        _count: true,
      }),
      prisma.sale.aggregate({
        where: {
          shopId,
          status: 'COMPLETED',
          createdAt: { gte: startOfMonth },
        },
        _sum: { totalAmount: true },
        _count: true,
      }),
    ]);

    // Get product stats
    const [totalProducts, lowStockProducts] = await Promise.all([
      prisma.product.count({
        where: { shopId, isActive: true },
      }),
      prisma.product.count({
        where: {
          shopId,
          isActive: true,
          trackStock: true,
          quantity: { lte: prisma.product.fields.reorderAt },
        },
      }),
    ]);

    // Get low stock items
    const lowStockItems = await prisma.product.findMany({
      where: {
        shopId,
        isActive: true,
        trackStock: true,
      },
      select: {
        id: true,
        name: true,
        quantity: true,
        reorderAt: true,
      },
      orderBy: { quantity: 'asc' },
      take: 10,
    });

    // Filter to actual low stock (where quantity <= reorderAt)
    const actualLowStock = lowStockItems.filter(p => p.quantity <= p.reorderAt);

    // Get top selling products today
    const topProducts = await prisma.saleItem.groupBy({
      by: ['productId'],
      where: {
        sale: {
          shopId,
          status: 'COMPLETED',
          createdAt: { gte: startOfDay },
        },
      },
      _sum: { quantity: true, totalPrice: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: 5,
    });

    // Get product names for top products
    const productIds = topProducts.map(p => p.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true },
    });

    const productMap = new Map(products.map(p => [p.id, p.name]));

    return {
      today: {
        sales: todaySales._sum.totalAmount || 0,
        transactions: todaySales._count,
      },
      week: {
        sales: weekSales._sum.totalAmount || 0,
        transactions: weekSales._count,
      },
      month: {
        sales: monthSales._sum.totalAmount || 0,
        transactions: monthSales._count,
      },
      inventory: {
        totalProducts,
        lowStockCount: actualLowStock.length,
        lowStockItems: actualLowStock,
      },
      topProducts: topProducts.map(p => ({
        id: p.productId,
        name: productMap.get(p.productId) || 'Unknown',
        quantity: p._sum.quantity || 0,
        revenue: p._sum.totalPrice || 0,
      })),
    };
  }

  /**
   * Increment usage counters (for billing)
   */
  static async incrementUsage(shopId: string, type: 'transaction' | 'stockMove') {
    if (type === 'transaction') {
      await prisma.shop.update({
        where: { id: shopId },
        data: { monthlyTransactions: { increment: 1 } },
      });
    } else {
      await prisma.shop.update({
        where: { id: shopId },
        data: { monthlyStockMoves: { increment: 1 } },
      });
    }
  }

  /**
   * Reset monthly usage (called by billing cron)
   */
  static async resetMonthlyUsage(shopId: string) {
    await prisma.shop.update({
      where: { id: shopId },
      data: {
        monthlyTransactions: 0,
        monthlyStockMoves: 0,
        lastBillingReset: new Date(),
      },
    });
  }
}
