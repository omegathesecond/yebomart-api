/**
 * Tests for ReportService.getSalesReport — the authoritative server-side sales
 * report the POS Reports page is supposed to render verbatim (instead of
 * recomputing understated revenue/profit from a partially-synced local cache).
 *
 * Covered behaviour:
 *   (a) revenue/profit are reckoned NET of VAT — a VAT sale and a non-VAT sale
 *       roll up to the correct netRevenue / grossProfit
 *   (b) the range is INCLUSIVE of the whole end day: a same-day [today, today]
 *       range returns the full day (00:00 → 23:59), excluding adjacent days
 *   (c) topProducts is revenue-sorted and capped at 10
 *   (d) the stock snapshot sums costPrice*quantity over ACTIVE products and
 *       counts low stock only for trackStock products (inactive excluded)
 *   (e) logged expenses are subtracted into netProfit
 *
 * Runs against the in-memory Prisma fake (vitest.config alias redirects
 * `@config/prisma`). The fake's expense.aggregate({_sum}) is exercised here for
 * the first time — with zero expenses it returns `_sum.amount === null`, so the
 * service's `|| 0` fallback is genuinely under test, not bypassed.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { ReportService } from './report.service';
import {
  prismaFake,
  resetDb,
  seedShop,
  seedProduct,
  seedExpense,
} from '../test/prismaFake';

let shopId: string;

beforeEach(() => {
  resetDb();
  shopId = seedShop().id;
});

/** Local-time date at noon (avoids TZ edge cases at day boundaries). */
function dayAt(y: number, m: number, d: number, h = 12): Date {
  return new Date(y, m, d, h, 0, 0);
}

/** Create a COMPLETED sale with snapshotted line items. */
async function seedSale(over: Record<string, any> = {}) {
  const { items = [], ...rest } = over;
  return prismaFake.sale.create({
    data: {
      shopId,
      status: 'COMPLETED',
      paymentMethod: 'CASH',
      totalAmount: 0,
      tax: 0,
      createdAt: dayAt(2025, 0, 10),
      items: { create: items },
      ...rest,
    },
  });
}

describe('ReportService.getSalesReport — net-of-VAT revenue & profit', () => {
  it('reckons revenue/profit net of VAT across a VAT and a non-VAT sale', async () => {
    // VAT sale: 100 net + 15 VAT = 115 paid; one line, cost 10 x2 = 20 COGS.
    await seedSale({
      totalAmount: 115,
      tax: 15,
      items: [
        { productId: 'p1', productName: 'Widget', quantity: 2, costPrice: 10, unitPrice: 50, totalPrice: 100 },
      ],
    });
    // Non-VAT sale: 50 paid, no tax; cost 30 x1 = 30 COGS.
    await seedSale({
      totalAmount: 50,
      tax: 0,
      items: [
        { productId: 'p2', productName: 'Gadget', quantity: 1, costPrice: 30, unitPrice: 50, totalPrice: 50 },
      ],
    });

    const report = await ReportService.getSalesReport(shopId, {
      startDate: dayAt(2025, 0, 10),
      endDate: dayAt(2025, 0, 10),
    });

    const s = report.summary;
    expect(s.totalSales).toBe(165); // 115 + 50
    expect(s.totalTax).toBe(15);
    expect(s.netRevenue).toBe(150); // 165 - 15 VAT
    expect(s.totalCost).toBe(50); // 20 + 30 COGS
    expect(s.grossProfit).toBe(100); // 150 - 50
    expect(s.totalExpenses).toBe(0);
    expect(s.netProfit).toBe(100); // no expenses → equals grossProfit
    expect(s.totalTransactions).toBe(2);
    expect(s.averageBasket).toBe(82.5); // 165 / 2
  });

  it('returns zeroed summary (no NaN) for a range with no sales', async () => {
    const report = await ReportService.getSalesReport(shopId, {
      startDate: dayAt(2025, 0, 10),
      endDate: dayAt(2025, 0, 10),
    });
    expect(report.summary.totalSales).toBe(0);
    expect(report.summary.netProfit).toBe(0);
    expect(report.summary.averageBasket).toBe(0); // guarded divide-by-zero
    expect(report.topProducts).toEqual([]);
  });
});

describe('ReportService.getSalesReport — inclusive same-day range', () => {
  it('includes the whole end day and excludes adjacent days', async () => {
    const today = new Date();
    const y = today.getFullYear();
    const m = today.getMonth();
    const d = today.getDate();

    // Start-of-day, midday, and late-evening sales — all on "today".
    await seedSale({ totalAmount: 10, createdAt: new Date(y, m, d, 0, 0, 0) });
    await seedSale({ totalAmount: 20, createdAt: new Date(y, m, d, 12, 0, 0) });
    await seedSale({ totalAmount: 30, createdAt: new Date(y, m, d, 23, 59, 0) });
    // Yesterday and tomorrow — must be excluded by the [start, nextDay) bound.
    await seedSale({ totalAmount: 999, createdAt: new Date(y, m, d - 1, 12, 0, 0) });
    await seedSale({ totalAmount: 999, createdAt: new Date(y, m, d + 1, 0, 0, 0) });

    const report = await ReportService.getSalesReport(shopId, {
      startDate: today,
      endDate: today,
    });

    expect(report.summary.totalTransactions).toBe(3);
    expect(report.summary.totalSales).toBe(60); // 10 + 20 + 30 only
  });
});

describe('ReportService.getSalesReport — topProducts ordering & cap', () => {
  it('sorts products by revenue desc and caps at 10', async () => {
    // 12 distinct products in one sale, revenue ascending with index so the
    // highest-revenue product is last-created (proves it actually sorts).
    const items = Array.from({ length: 12 }, (_, i) => ({
      productId: `prod-${i}`,
      productName: `Product ${i}`,
      quantity: 1,
      costPrice: 1,
      unitPrice: (i + 1) * 100,
      totalPrice: (i + 1) * 100, // prod-11 = 1200 (highest), prod-0 = 100 (lowest)
    }));
    await seedSale({ totalAmount: 7800, tax: 0, items });

    const report = await ReportService.getSalesReport(shopId, {
      startDate: dayAt(2025, 0, 10),
      endDate: dayAt(2025, 0, 10),
    });

    expect(report.topProducts).toHaveLength(10); // capped
    expect(report.topProducts[0].id).toBe('prod-11'); // highest revenue first
    expect(report.topProducts[0].revenue).toBe(1200);
    // descending order
    const revenues = report.topProducts.map((p: any) => p.revenue);
    expect(revenues).toEqual([...revenues].sort((a, b) => b - a));
    // the two lowest-revenue products fell off the cap
    const ids = report.topProducts.map((p: any) => p.id);
    expect(ids).not.toContain('prod-0');
    expect(ids).not.toContain('prod-1');
  });
});

describe('ReportService.getSalesReport — stock snapshot', () => {
  it('values active stock and counts low stock only for tracked products', async () => {
    seedProduct({ shopId, costPrice: 5, quantity: 10, reorderAt: 3, trackStock: true, isActive: true });   // value 50, not low
    seedProduct({ shopId, costPrice: 2, quantity: 1, reorderAt: 5, trackStock: true, isActive: true });    // value 2, LOW
    seedProduct({ shopId, costPrice: 100, quantity: 2, reorderAt: 5, trackStock: false, isActive: true });  // value 200, NOT low (untracked)
    seedProduct({ shopId, costPrice: 999, quantity: 9, reorderAt: 1, trackStock: true, isActive: false });  // inactive → excluded

    const report = await ReportService.getSalesReport(shopId, {
      startDate: dayAt(2025, 0, 10),
      endDate: dayAt(2025, 0, 10),
    });

    expect(report.stock.totalProducts).toBe(3); // inactive excluded
    expect(report.stock.stockValue).toBe(252); // 50 + 2 + 200
    expect(report.stock.lowStockCount).toBe(1); // only the tracked low one
  });
});

describe('ReportService.getSalesReport — expenses', () => {
  it('subtracts logged expenses from netProfit', async () => {
    await seedSale({
      totalAmount: 100,
      tax: 0,
      items: [
        { productId: 'p1', productName: 'Widget', quantity: 1, costPrice: 40, unitPrice: 100, totalPrice: 100 },
      ],
    });
    // grossProfit = 100 - 40 = 60. Two expenses in range total 25.
    seedExpense({ shopId, amount: 15, category: 'RENT', date: dayAt(2025, 0, 10) });
    seedExpense({ shopId, amount: 10, category: 'UTILITIES', date: dayAt(2025, 0, 10) });
    // An out-of-range expense must NOT be subtracted.
    seedExpense({ shopId, amount: 500, category: 'OTHER', date: dayAt(2025, 1, 1) });

    const report = await ReportService.getSalesReport(shopId, {
      startDate: dayAt(2025, 0, 10),
      endDate: dayAt(2025, 0, 10),
    });

    expect(report.summary.grossProfit).toBe(60);
    expect(report.summary.totalExpenses).toBe(25); // 15 + 10, in-range only
    expect(report.summary.netProfit).toBe(35); // 60 - 25
  });
});
