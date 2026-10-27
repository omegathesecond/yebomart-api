import { prisma } from '@config/prisma';
import { account, totals, Movement } from './report-accounting';
import { round2 } from '@utils/tax';

interface DateRange {
  startDate: Date;
  endDate: Date;
}

export class ReportService {
  private static bounds(range: DateRange) {
    const start = new Date(range.startDate.getFullYear(), range.startDate.getMonth(), range.startDate.getDate());
    const end = new Date(range.endDate.getFullYear(), range.endDate.getMonth(), range.endDate.getDate() + 1);
    return { start, end };
  }

  private static async journal(shopId: string, range: DateRange) {
    const { start, end } = this.bounds(range);
    const [sales, returns] = await Promise.all([
      prisma.sale.findMany({
        where: {
          shopId,
          status: 'COMPLETED',
          createdAt: { gte: start, lt: end },
        },
        include: { items: true },
      }),
      // Recognition is scoped to completion time, independently of sale time.
      prisma.return.findMany({
        where: {
          shopId,
          status: 'COMPLETED',
          processedAt: { gte: start, lt: end },
        },
        include: { items: true, exchangeItems: true },
      }),
    ]);
    const ids = [...new Set(returns.flatMap((r) => (r.saleId ? [r.saleId] : [])))];
    const [originals, earlierReturns] = ids.length
      ? await Promise.all([
          prisma.sale.findMany({
            where: { shopId, id: { in: ids } },
            include: { items: true },
          }),
          // Earlier completions on these receipts allocate residual VAT/COGS cents,
          // without scanning every historical return in the shop.
          prisma.return.findMany({
            where: {
              shopId,
              saleId: { in: ids },
              status: 'COMPLETED',
              processedAt: { lt: start, not: null },
            },
            include: { items: true, exchangeItems: true },
          }),
        ])
      : [[], []];
    const journal = account(sales, [...earlierReturns, ...returns], originals, start);
    return { ...journal, sales, start, end };
  }

  private static products(rows: Movement[]) {
    const groups = new Map<string, Movement[]>();
    for (const row of rows) {
      const key = JSON.stringify([row.productId, row.name]);
      const group = groups.get(key) || [];
      group.push(row);
      groups.set(key, group);
    }
    return [...groups.values()]
      .map((items) => {
        const s = totals(items);
        const sales = items.filter((i) => i.quantity > 0 && i.exchangeSales === 0);
        return {
          id: items[0].productId,
          name: items[0].name,
          quantitySold: items.reduce((n, i) => n + i.quantity, 0),
          ...s,
          revenue: s.netRevenue,
          cost: s.totalCost,
          profit: s.grossProfit,
          margin: s.netRevenue > 0 ? (s.grossProfit / s.netRevenue) * 100 : 0,
          averagePrice: sales.length ? sales.reduce((n, i) => n + i.unitPrice, 0) / sales.length : 0,
        };
      })
      .sort((a, b) => b.revenue - a.revenue);
  }

  static async getSalesReport(shopId: string, range: DateRange) {
    const journal = await this.journal(shopId, range);
    const [expenses, stockProducts] = await Promise.all([
      prisma.expense.aggregate({
        where: { shopId, date: { gte: journal.start, lt: journal.end } },
        _sum: { amount: true },
      }),
      prisma.product.findMany({
        where: { shopId, isActive: true },
        select: {
          id: true,
          name: true,
          costPrice: true,
          quantity: true,
          reorderAt: true,
          trackStock: true,
        },
      }),
    ]);
    const s = totals(journal.movements);
    const totalExpenses = expenses._sum.amount || 0;
    const paymentBreakdown = { cash: 0, momo: 0, emali: 0, card: 0 };
    for (const sale of journal.sales) {
      const key = sale.paymentMethod.toLowerCase() as keyof typeof paymentBreakdown;
      if (key in paymentBreakdown) paymentBreakdown[key] += sale.totalAmount;
    }
    // These are original sale tenders, not net cash flows. Refund settlements
    // belong to the cash-up report; store credit/debt do not become cash payouts.
    const summary = {
      ...s,
      ...journal.evidence,
      profitComplete: journal.evidence.receiptlessCount === 0 && journal.evidence.unvaluedExchangeCount === 0,
      totalTransactions: journal.sales.length,
      averageBasket: journal.sales.length ? s.grossSales / journal.sales.length : 0,
      totalExpenses,
      netProfit: round2(s.grossProfit - totalExpenses),
    };
    return {
      range: { startDate: journal.start, endDate: range.endDate },
      summary,
      paymentBreakdown,
      topProducts: this.products(journal.movements)
        .slice(0, 10)
        .map((p) => ({ ...p, quantity: p.quantitySold })),
      stock: {
        totalProducts: stockProducts.length,
        stockValue: stockProducts.reduce((n, p) => n + p.costPrice * p.quantity, 0),
        lowStockCount: stockProducts.filter((p) => p.trackStock && p.quantity <= p.reorderAt).length,
      },
      lowStock: stockProducts.filter((p) => p.trackStock && p.quantity <= p.reorderAt),
    };
  }

  static async getDailyReport(shopId: string, date = new Date()) {
    const report = await this.getSalesReport(shopId, {
      startDate: date,
      endDate: date,
    });
    const staff = await this.getStaffReport(shopId, {
      startDate: date,
      endDate: date,
    });
    return {
      ...report,
      date: report.range.startDate,
      staffPerformance: staff.staff.map((s) => ({
        ...s,
        transactions: s.transactionCount,
        total: s.totalSales,
      })),
    };
  }

  static async getWeeklyReport(shopId: string, weekStart?: Date) {
    const now = new Date();
    const start = weekStart || new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
    const last = new Date(start);
    last.setDate(last.getDate() + 6);
    const report = await this.getSalesReport(shopId, {
      startDate: start,
      endDate: last,
    });
    const dailyBreakdown = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(start);
      date.setDate(date.getDate() + i);
      const daily = await this.getSalesReport(shopId, {
        startDate: date,
        endDate: date,
      });
      dailyBreakdown.push({
        date,
        sales: daily.summary.totalSales,
        transactions: daily.summary.totalTransactions,
        profit: daily.summary.netProfit,
      });
    }
    const weekEnd = new Date(last);
    weekEnd.setDate(weekEnd.getDate() + 1);
    return {
      weekStart: start,
      weekEnd,
      summary: {
        ...report.summary,
        averageDaily: report.summary.totalSales / 7,
      },
      dailyBreakdown,
    };
  }

  static async getProductReport(shopId: string, range: DateRange) {
    const journal = await this.journal(shopId, range);
    const rows = this.products(journal.movements);
    const products = await prisma.product.findMany({
      where: { shopId, id: { in: rows.map((r) => r.id) } },
      select: { id: true, category: true },
    });
    const categoriesById = new Map(products.map((p) => [p.id, p.category]));
    const performance = rows.map((p) => ({
      ...p,
      category: categoriesById.get(p.id) || 'Uncategorized',
    }));
    const categories = new Map<string, { revenue: number; quantity: number }>();
    for (const p of performance) {
      const c = categories.get(p.category) || { revenue: 0, quantity: 0 };
      c.revenue = round2(c.revenue + p.revenue);
      c.quantity += p.quantitySold;
      categories.set(p.category, c);
    }
    return {
      range,
      products: performance,
      adjustments: journal.evidence,
      categories: [...categories.entries()].map(([name, c]) => ({ name, ...c })).sort((a, b) => b.revenue - a.revenue),
    };
  }

  static async getStaffReport(shopId: string, range: DateRange) {
    const journal = await this.journal(shopId, range);
    const users = await prisma.user.findMany({
      where: { shopId },
      select: { id: true, name: true, role: true },
    });
    // Keep unattributed owner/deleted-staff activity visible so rows reconcile.
    const ids = new Set([...journal.movements.map((r) => r.staffId), ...journal.sales.map((s) => s.userId)]);
    const staffUsers = [...users];
    for (const id of ids)
      if (!users.some((u) => u.id === id)) staffUsers.push({ id: id || '', name: 'Unattributed', role: 'OWNER' });
    const staff = await Promise.all(
      staffUsers.map(async (user) => {
        const id = user.id || null;
        const s = totals(journal.movements.filter((r) => r.staffId === id));
        const transactions = journal.sales.filter((s) => s.userId === id);
        const voidCount = await prisma.sale.count({
          where: {
            shopId,
            userId: id,
            status: 'VOIDED',
            createdAt: { gte: journal.start, lt: journal.end },
          },
        });
        return {
          ...user,
          ...s,
          transactionCount: transactions.length,
          averageTransaction: transactions.length ? s.grossSales / transactions.length : 0,
          voidCount,
        };
      }),
    );
    return {
      range,
      staff: staff.sort((a, b) => b.totalSales - a.totalSales),
      adjustments: journal.evidence,
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
