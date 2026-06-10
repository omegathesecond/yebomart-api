/**
 * ReportService.generateDailyReport — daily roll-up persisted to DailyReport,
 * against a REAL Postgres so the groupBy/aggregate SQL and the upsert run for
 * real. Totals must reconcile exactly with the sales that were rung up.
 *
 * Profit accounting note (mirrors report.service.ts): for a VAT-registered shop
 * the VAT collected is owed to the revenue authority, so revenue/profit are
 * reckoned NET of tax. With taxRate 0 (the default) netRevenue === totalSales.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ReportService } from './report.service';
import { SaleService } from './sale.service';
import { prisma, resetDb } from '../test/db';
import { seedShop, seedProduct, seedUser } from '../test/factories';

let shopId: string;
let userId: string;

beforeEach(async () => {
  await resetDb();
  const shop = await seedShop();
  shopId = shop.id;
  const user = await seedUser(shopId);
  userId = user.id;
});

async function ringUp(productId: string, quantity: number, over: Record<string, any> = {}) {
  return SaleService.create({
    shopId,
    paymentMethod: 'CASH',
    items: [{ productId, quantity }],
    amountPaid: 1_000_000,
    ...over,
  } as any);
}

describe('ReportService.generateDailyReport', () => {
  it('reconciles totals, cost, gross profit and payment breakdown with seeded sales', async () => {
    // sellPrice 10, costPrice 4 -> profit 6/unit.
    const product = await seedProduct(shopId, { sellPrice: 10, costPrice: 4, quantity: 100 });

    await ringUp(product.id, 3); // 30 CASH, cost 12
    await ringUp(product.id, 2, { paymentMethod: 'CARD' }); // 20 CARD, cost 8

    const today = new Date();
    const report = await ReportService.generateDailyReport(shopId, today);

    expect(report.totalSales).toBe(50);
    expect(report.totalTransactions).toBe(2);
    expect(report.averageBasket).toBe(25);
    expect(report.totalCost).toBe(20); // 12 + 8
    expect(report.grossProfit).toBe(30); // 50 net - 20 cost
    expect(report.cashSales).toBe(30);
    expect(report.cardSales).toBe(20);
  });

  it('persists the row and upserts in place on the same day (no duplicate)', async () => {
    const product = await seedProduct(shopId, { sellPrice: 10, costPrice: 4, quantity: 100 });
    const today = new Date();

    await ringUp(product.id, 1); // 10
    const first = await ReportService.generateDailyReport(shopId, today);
    expect(first.totalSales).toBe(10);

    // Another sale, regenerate -> same DailyReport row, updated totals.
    await ringUp(product.id, 4); // +40 -> 50 total
    const second = await ReportService.generateDailyReport(shopId, today);

    expect(second.id).toBe(first.id); // upserted, not duplicated
    expect(second.totalSales).toBe(50);

    const rows = await prisma.dailyReport.findMany({ where: { shopId } });
    expect(rows).toHaveLength(1); // @@unique([shopId, date]) holds
  });

  it('excludes VOIDED sales from the report totals', async () => {
    const product = await seedProduct(shopId, { sellPrice: 10, costPrice: 4, quantity: 100 });
    const today = new Date();

    await ringUp(product.id, 3); // 30 stays
    const voided = await ringUp(product.id, 2); // 20 then voided
    await SaleService.voidSale(voided.id, shopId, userId, 'mistake');

    const report = await ReportService.generateDailyReport(shopId, today);

    expect(report.totalSales).toBe(30); // voided 20 excluded
    expect(report.totalTransactions).toBe(1);
  });

  it('nets VAT out of revenue/profit for a VAT-registered shop', async () => {
    await prisma.shop.update({
      where: { id: shopId },
      data: { taxRate: 15, taxInclusive: false },
    });
    // 1 unit @100, cost 40. Exclusive 15% VAT: tax 15, total 115.
    const product = await seedProduct(shopId, { sellPrice: 100, costPrice: 40, quantity: 10 });
    await ringUp(product.id, 1);

    const report = await ReportService.generateDailyReport(shopId, new Date());

    expect(report.totalSales).toBe(115); // gross incl VAT
    // grossProfit = (totalSales - tax) - cost = (115 - 15) - 40 = 60
    expect(report.grossProfit).toBe(60);
  });
});
