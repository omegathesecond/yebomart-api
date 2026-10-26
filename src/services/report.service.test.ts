import { beforeEach, expect, it } from 'vitest';
import { ReportService } from './report.service';
import { prismaFake, resetDb, seedProduct, seedSale, seedShop } from '../test/prismaFake';

beforeEach(resetDb);

it('keeps weighted snapshot COGS stable after current-cost edits and agrees with summaries', async () => {
  const shop = seedShop();
  const other = seedShop({ ownerPhone: 'other', ownerYeboidSub: 'other' });
  const product = seedProduct({ shopId: shop.id, costPrice: 15, category: 'Food' });
  const date = new Date(2026, 9, 20, 12);
  const range = { startDate: new Date(2026, 9, 20), endDate: new Date(2026, 9, 20, 23, 59, 59, 999) };
  let receipt = 0;
  const sell = (costPrice: number, quantity: number, unitPrice: number, overrides = {}) => seedSale({
    shopId: shop.id, createdAt: date, receiptNumber: `R-${++receipt}`,
    totalAmount: quantity * unitPrice,
    items: [{ productId: product.id, productName: 'Rice', quantity, costPrice, unitPrice, totalPrice: quantity * unitPrice }],
    ...overrides,
  });
  sell(10, 2, 30);
  sell(15, 3, 40);
  sell(900, 10, 1000, { status: 'VOIDED' });
  sell(800, 10, 1000, { shopId: other.id });
  sell(700, 10, 1000, { createdAt: new Date(2026, 9, 19, 23, 59) });
  sell(600, 10, 1000, { createdAt: new Date(2026, 9, 21) });

  const before = await ReportService.getProductReport(shop.id, range);
  expect(before.products).toHaveLength(1);
  expect(before.products[0]).toEqual({
    id: product.id, name: 'Rice', category: 'Food', quantitySold: 5,
    revenue: 180, cost: 65, profit: 115, margin: 115 / 180 * 100, averagePrice: 35,
  });
  await prismaFake.product.update({ where: { id: product.id }, data: { costPrice: 99 } });
  expect(await ReportService.getProductReport(shop.id, range)).toEqual(before);
  const daily = await ReportService.getDailyReport(shop.id, date);
  const summary = await ReportService.getSalesReport(shop.id, range);
  expect(daily.summary.totalCost).toBe(65);
  expect(summary.summary.totalCost).toBe(65);
  expect(summary.summary.grossProfit).toBe(before.products[0].profit);
  expect(before.categories).toEqual([{ name: 'Food', revenue: 180, quantity: 5 }]);
});

it('preserves sale-time name groups, revenue ordering and zero-revenue margins', async () => {
  const shop = seedShop();
  const product = seedProduct({ shopId: shop.id });
  const date = new Date(2026, 9, 20, 12);
  seedSale({ shopId: shop.id, createdAt: date, items: [
    { productId: product.id, productName: 'Old name', quantity: 2, costPrice: 4, unitPrice: 0, totalPrice: 0 },
    { productId: product.id, productName: 'New name', quantity: 1, costPrice: 7, unitPrice: 20, totalPrice: 18 },
  ] });
  const report = await ReportService.getProductReport(shop.id, { startDate: date, endDate: date });
  expect(report.products.map(p => p.name)).toEqual(['New name', 'Old name']);
  expect(report.products[0]).toMatchObject({ revenue: 18, cost: 7, profit: 11, averagePrice: 20 });
  expect(report.products[1]).toMatchObject({ revenue: 0, cost: 8, profit: -8, margin: 0 });
});
