import { prisma } from '@config/prisma';

interface DateRange {
  startDate: Date;
  endDate: Date;
}

export class ReportService {
  /**
   * Get daily report
   */
  static async getDailyReport(shopId: string, date?: Date) {
    const targetDate = date || new Date();
    const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
    const endOfDay = new Date(startOfDay);
    endOfDay.setDate(endOfDay.getDate() + 1);

    // Get sales data
    const sales = await prisma.sale.findMany({
      where: {
        shopId,
        status: 'COMPLETED',
        createdAt: { gte: startOfDay, lt: endOfDay },
      },
      include: {
        items: true,
        user: { select: { id: true, name: true } },
      },
    });

    // Calculate totals
    let totalSales = 0;
    let totalCost = 0;
    let cashSales = 0;
    let momoSales = 0;
    let emaliSales = 0;
    let cardSales = 0;

    const productSales: Map<string, { name: string; quantity: number; revenue: number }> = new Map();
    const staffSales: Map<string, { name: string; transactions: number; total: number }> = new Map();

    for (const sale of sales) {
      totalSales += sale.totalAmount;

      switch (sale.paymentMethod) {
        case 'CASH':
          cashSales += sale.totalAmount;
          break;
        case 'MOMO':
          momoSales += sale.totalAmount;
          break;
        case 'EMALI':
          emaliSales += sale.totalAmount;
          break;
        case 'CARD':
          cardSales += sale.totalAmount;
          break;
      }

      // Staff stats
      if (sale.user) {
        const existing = staffSales.get(sale.userId!) || { name: sale.user.name, transactions: 0, total: 0 };
        existing.transactions++;
        existing.total += sale.totalAmount;
        staffSales.set(sale.userId!, existing);
      }

      // Product stats
      for (const item of sale.items) {
        totalCost += item.costPrice * item.quantity;
        
        const existing = productSales.get(item.productId) || { name: item.productName, quantity: 0, revenue: 0 };
        existing.quantity += item.quantity;
        existing.revenue += item.totalPrice;
        productSales.set(item.productId, existing);
      }
    }

    // Get expenses
    const expenses = await prisma.expense.aggregate({
      where: {
        shopId,
        date: { gte: startOfDay, lt: endOfDay },
      },
      _sum: { amount: true },
    });

    const totalExpenses = expenses._sum.amount || 0;
    const grossProfit = totalSales - totalCost;
    const netProfit = grossProfit - totalExpenses;

    // Top products
    const topProducts = Array.from(productSales.entries())
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 10);

    // Low stock alerts
    const lowStockProducts = await prisma.product.findMany({
      where: {
        shopId,
        isActive: true,
        trackStock: true,
      },
      select: { id: true, name: true, quantity: true, reorderAt: true },
    });

    const lowStock = lowStockProducts
      .filter(p => p.quantity <= p.reorderAt)
      .map(p => ({ id: p.id, name: p.name, quantity: p.quantity, reorderAt: p.reorderAt }));

    return {
      date: startOfDay,
      summary: {
        totalSales,
        totalTransactions: sales.length,
        averageBasket: sales.length > 0 ? totalSales / sales.length : 0,
        totalCost,
        grossProfit,
        totalExpenses,
        netProfit,
      },
      paymentBreakdown: {
        cash: cashSales,
        momo: momoSales,
        emali: emaliSales,
        card: cardSales,
      },
      topProducts,
      lowStock,
      staffPerformance: Array.from(staffSales.entries()).map(([id, data]) => ({ id, ...data })),
    };
  }

  /**
   * Get weekly report
   */
  static async getWeeklyReport(shopId: string, weekStart?: Date) {
    const now = new Date();
    const startOfWeek = weekStart || new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(endOfWeek.getDate() + 7);

    const dailyReports = [];
    const currentDay = new Date(startOfWeek);

    while (currentDay < endOfWeek) {
      const report = await this.getDailyReport(shopId, new Date(currentDay));
      dailyReports.push(report);
      currentDay.setDate(currentDay.getDate() + 1);
    }

    // Aggregate
    let totalSales = 0;
    let totalTransactions = 0;
    let totalCost = 0;
    let totalExpenses = 0;

    for (const report of dailyReports) {
      totalSales += report.summary.totalSales;
      totalTransactions += report.summary.totalTransactions;
      totalCost += report.summary.totalCost;
      totalExpenses += report.summary.totalExpenses;
    }

    return {
      weekStart: startOfWeek,
      weekEnd: endOfWeek,
      summary: {
        totalSales,
        totalTransactions,
        averageDaily: totalSales / 7,
        totalCost,
        grossProfit: totalSales - totalCost,
        totalExpenses,
        netProfit: totalSales - totalCost - totalExpenses,
      },
      dailyBreakdown: dailyReports.map(r => ({
        date: r.date,
        sales: r.summary.totalSales,
        transactions: r.summary.totalTransactions,
        profit: r.summary.netProfit,
      })),
    };
  }

  /**
   * Get product performance report
   */
  static async getProductReport(shopId: string, range: DateRange) {
    const saleItems = await prisma.saleItem.groupBy({
      by: ['productId', 'productName'],
      where: {
        sale: {
          shopId,
          status: 'COMPLETED',
          createdAt: { gte: range.startDate, lte: range.endDate },
        },
      },
      _sum: { quantity: true, totalPrice: true },
      _avg: { unitPrice: true },
    });

    // Get product details including cost
    const productIds = saleItems.map(item => item.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, costPrice: true, category: true },
    });

    const productMap = new Map(products.map(p => [p.id, p]));

    const productPerformance = saleItems.map(item => {
      const product = productMap.get(item.productId);
      const revenue = item._sum.totalPrice || 0;
      const quantity = item._sum.quantity || 0;
      const cost = (product?.costPrice || 0) * quantity;
      
      return {
        id: item.productId,
        name: item.productName,
        category: product?.category || 'Uncategorized',
        quantitySold: quantity,
        revenue,
        cost,
        profit: revenue - cost,
        margin: revenue > 0 ? ((revenue - cost) / revenue) * 100 : 0,
        averagePrice: item._avg.unitPrice || 0,
      };
    });

    // Sort by revenue
    productPerformance.sort((a, b) => b.revenue - a.revenue);

    // Category breakdown
    const categoryMap = new Map<string, { revenue: number; quantity: number }>();
    for (const product of productPerformance) {
      const existing = categoryMap.get(product.category) || { revenue: 0, quantity: 0 };
      existing.revenue += product.revenue;
      existing.quantity += product.quantitySold;
      categoryMap.set(product.category, existing);
    }

    return {
      range,
      products: productPerformance,
      categories: Array.from(categoryMap.entries())
        .map(([name, data]) => ({ name, ...data }))
        .sort((a, b) => b.revenue - a.revenue),
    };
  }

  /**
   * Get staff performance report
   */
  static async getStaffReport(shopId: string, range: DateRange) {
    const users = await prisma.user.findMany({
      where: { shopId },
      select: { id: true, name: true, role: true },
    });

    const staffPerformance = await Promise.all(
      users.map(async (user) => {
        const [sales, voids] = await Promise.all([
          prisma.sale.aggregate({
            where: {
              shopId,
              userId: user.id,
              status: 'COMPLETED',
              createdAt: { gte: range.startDate, lte: range.endDate },
            },
            _sum: { totalAmount: true },
            _count: true,
            _avg: { totalAmount: true },
          }),
          prisma.sale.count({
            where: {
              shopId,
              userId: user.id,
              status: 'VOIDED',
              createdAt: { gte: range.startDate, lte: range.endDate },
            },
          }),
        ]);

        return {
          id: user.id,
          name: user.name,
          role: user.role,
          totalSales: sales._sum.totalAmount || 0,
          transactionCount: sales._count,
          averageTransaction: sales._avg.totalAmount || 0,
          voidCount: voids,
        };
      })
    );

    // Sort by total sales
    staffPerformance.sort((a, b) => b.totalSales - a.totalSales);

    return {
      range,
      staff: staffPerformance,
    };
  }

  /**
   * Generate and store daily report
   */
  static async generateDailyReport(shopId: string, date: Date) {
    const report = await this.getDailyReport(shopId, date);
    const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    // Upsert the daily report
    const dailyReport = await prisma.dailyReport.upsert({
      where: {
        shopId_date: {
          shopId,
          date: dateOnly,
        },
      },
      update: {
        totalSales: report.summary.totalSales,
        totalTransactions: report.summary.totalTransactions,
        averageBasket: report.summary.averageBasket,
        totalCost: report.summary.totalCost,
        grossProfit: report.summary.grossProfit,
        totalExpenses: report.summary.totalExpenses,
        netProfit: report.summary.netProfit,
        cashSales: report.paymentBreakdown.cash,
        momoSales: report.paymentBreakdown.momo,
        emaliSales: report.paymentBreakdown.emali,
        cardSales: report.paymentBreakdown.card,
        topProducts: report.topProducts,
        lowStock: report.lowStock,
      },
      create: {
        shopId,
        date: dateOnly,
        totalSales: report.summary.totalSales,
        totalTransactions: report.summary.totalTransactions,
        averageBasket: report.summary.averageBasket,
        totalCost: report.summary.totalCost,
        grossProfit: report.summary.grossProfit,
        totalExpenses: report.summary.totalExpenses,
        netProfit: report.summary.netProfit,
        cashSales: report.paymentBreakdown.cash,
        momoSales: report.paymentBreakdown.momo,
        emaliSales: report.paymentBreakdown.emali,
        cardSales: report.paymentBreakdown.card,
        topProducts: report.topProducts,
        lowStock: report.lowStock,
      },
    });

    return dailyReport;
  }
}
