import { beforeEach, expect, it } from 'vitest';
import { ReportService } from './report.service';
import { prismaFake as db, resetDb, seedShop, seedProduct, seedSale, seedUser } from '../test/prismaFake';
import { entitlement, refundCents } from './return-entitlement';

beforeEach(resetDb);
const day = (d: number) => new Date(2026, 9, d, 12);
const range = (d: number) => ({ startDate: day(d), endDate: day(d) });
function fixture(extra = {}) {
  const shop = seedShop();
  const product = seedProduct({ shopId: shop.id, costPrice: 999 });
  const staff = seedUser({ shopId: shop.id });
  const sale = seedSale({
    shopId: shop.id,
    userId: staff.id,
    createdAt: day(20),
    subtotal: 200,
    discount: 20,
    totalAmount: 207,
    tax: 27,
    items: [
      {
        productId: product.id,
        productName: 'Rice',
        quantity: 2,
        costPrice: 40,
        unitPrice: 100,
        totalPrice: 200,
      },
    ],
    ...extra,
  });
  return { shop, product, staff, sale };
}
async function complete(f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) {
  return db.return.create({
    data: {
      shopId: f.shop.id,
      saleId: f.sale.id,
      status: 'COMPLETED',
      type: 'REFUND',
      processedAt: day(21),
      createdAt: day(20),
      refundAmount: 207,
      items: {
        create: [
          {
            productId: f.product.id,
            productName: 'Rice',
            quantity: 2,
            unitPrice: 103.5,
            restockable: true,
            restocked: true,
          },
        ],
      },
      ...extra,
    },
  });
}
it('reverses a full discounted receipt on completion day, reconciles products/staff and repeat reads', async () => {
  const f = fixture();
  await complete(f);
  expect((await ReportService.getSalesReport(f.shop.id, range(20))).summary).toMatchObject({
    grossSales: 207,
    returns: 0,
    totalTax: 27,
    totalCost: 80,
    netRevenue: 180,
    grossProfit: 100,
  });
  const report = await ReportService.getSalesReport(f.shop.id, range(21));
  expect(report.summary).toMatchObject({
    grossSales: 0,
    returns: 207,
    totalSales: -207,
    returnedTax: 27,
    totalTax: -27,
    totalCost: -80,
    netRevenue: -180,
    grossProfit: -100,
    profitComplete: true,
  });
  expect(await ReportService.getSalesReport(f.shop.id, range(21))).toEqual(report);
  expect((await ReportService.getDailyReport(f.shop.id, day(21))).summary).toEqual(report.summary);
  expect((await ReportService.getProductReport(f.shop.id, range(21))).products[0]).toMatchObject({
    returns: 207,
    revenue: -180,
    cost: -80,
    profit: -100,
    quantitySold: -2,
  });
  expect((await ReportService.getStaffReport(f.shop.id, range(21))).staff[0]).toMatchObject({
    returns: 207,
    totalSales: -207,
  });
});
it.each(['CASH', 'CREDIT'])(
  'recognizes STORE_CREDIT merchandise exactly once for %s receipts without a payout',
  async (paymentMethod) => {
    const f = fixture({ paymentMethod });
    await complete(f, {
      type: 'STORE_CREDIT',
      refundAmount: paymentMethod === 'CREDIT' ? 0 : 207,
    });
    const r = await ReportService.getSalesReport(f.shop.id, {
      startDate: day(20),
      endDate: day(21),
    });
    expect(r.summary).toMatchObject({
      grossSales: 207,
      returns: 207,
      totalSales: 0,
      totalTax: 0,
      totalCost: 0,
      netProfit: 0,
    });
    expect(r.paymentBreakdown.cash).toBe(paymentMethod === 'CREDIT' ? 0 : 207);
  },
);
it.each(['inclusive', 'exclusive'])(
  'uses original %s VAT snapshots on partial non-restockable returns',
  async (mode) => {
    const f = fixture(mode === 'inclusive' ? { subtotal: 230, discount: 23 } : {});
  await db.shop.update({ where: { id: f.shop.id }, data: { taxRate: 99, taxInclusive: mode !== 'inclusive' } });
    await complete(f, {
      items: {
        create: [
          {
            productId: f.product.id,
            quantity: 1,
            unitPrice: 103.5,
            restockable: false,
            restocked: false,
          },
        ],
      },
    });
    const s = (await ReportService.getSalesReport(f.shop.id, range(21))).summary;
    expect(s).toMatchObject({
      returns: 103.5,
      returnedTax: 13.5,
      totalCost: 0,
      grossProfit: -90,
    });
    const all = (
      await ReportService.getSalesReport(f.shop.id, {
        startDate: day(20),
        endDate: day(21),
      })
    ).summary;
    expect(all).toMatchObject({
      netRevenue: 90,
      totalCost: 80,
      grossProfit: 10,
    });
  },
);
it('excludes pending/approved/rejected, missing completion dates, other shops and future completions', async () => {
  const f = fixture();
  for (const status of ['PENDING', 'APPROVED', 'REJECTED']) await complete(f, { status });
  await complete(f, { processedAt: null });
  await complete(f, { shopId: seedShop().id });
  await complete(f, { processedAt: day(22) });
  expect((await ReportService.getSalesReport(f.shop.id, range(21))).summary.returns).toBe(0);
});
it('exhausts rounded tax/entitlement over multiple partial completions including an earlier period', async () => {
  const f = fixture({
    totalAmount: 1,
    tax: 0.13,
    items: [
      {
        productId: 'p',
        productName: 'Cents',
        quantity: 3,
        costPrice: 0.01,
        unitPrice: 0.4,
        totalPrice: 1.2,
      },
    ],
  });
  let prior: any[] = [];
  for (let i = 0; i < 3; i++) {
    const sale = await db.sale.findFirst({
      where: { id: f.sale.id },
      include: { items: true },
    });
    const p = entitlement(sale, prior)[0];
    const cents = refundCents(p, 1);
    prior.push(
      await complete(f, {
        processedAt: day(21 + i),
        items: {
          create: [
            {
              productId: 'p',
              quantity: 1,
              unitPrice: cents / 100,
              restockable: true,
              restocked: true,
            },
          ],
        },
      }),
    );
    prior = await db.return.findMany({
      where: { saleId: f.sale.id },
      include: { items: true, exchangeItems: true },
    });
  }
  const all = await ReportService.getSalesReport(f.shop.id, {
    startDate: day(20),
    endDate: day(23),
  });
  expect(all.summary).toMatchObject({
    returns: 1,
    returnedTax: 0.13,
    totalSales: 0,
    totalTax: 0,
    totalCost: 0,
    netProfit: 0,
  });
  const daily = await Promise.all([21, 22, 23].map((d) => ReportService.getSalesReport(f.shop.id, range(d))));
  expect(daily.reduce((n, r) => n + r.summary.returnedTax, 0)).toBeCloseTo(0.13);
});
it('separates receiptless adjustments and historical exchange values instead of inventing VAT/COGS', async () => {
  const f = fixture();
  await complete(f, {
    saleId: null,
    exchangeItems: {
      create: [
        {
          productId: f.product.id,
          productName: 'Unknown',
          quantity: 1,
          unitPrice: 50,
        },
      ],
    },
  });
  const s = (await ReportService.getSalesReport(f.shop.id, range(21))).summary;
  expect(s).toMatchObject({
    returns: 0,
    totalTax: 0,
    totalCost: 0,
    receiptlessReturns: 207,
    receiptlessCount: 1,
    unvaluedExchange: 50,
    unvaluedExchangeCount: 1,
    profitComplete: false,
  });
});
it('accounts for valued exchange-out merchandise separately from cash sales', async () => {
  const f = fixture();
  await complete(f, {
    type: 'EXCHANGE',
    refundAmount: 0,
    exchangeItems: {
      create: [
        {
          productId: f.product.id,
          productName: 'Replacement',
          quantity: 1,
          unitPrice: 100,
          costPrice: 30,
          tax: 15,
          totalAmount: 115,
        },
      ],
    },
  });
  const r = await ReportService.getSalesReport(f.shop.id, range(21));
  expect(r.summary).toMatchObject({
    grossSales: 0,
    returns: 207,
    exchangeSales: 115,
    exchangeTax: 15,
    totalSales: -92,
    netRevenue: -80,
    totalCost: -50,
    grossProfit: -30,
  });
  expect(r.paymentBreakdown.cash).toBe(0);
});

it('allocates order discounts and VAT across products and reverses weighted sale-time COGS', async () => {
  const f = fixture({
    totalAmount: 310.5,
    tax: 40.5,
    subtotal: 300,
    discount: 30,
    items: [
      { productId: 'a', productName: 'A', quantity: 1, unitPrice: 50, totalPrice: 50, costPrice: 10 },
      { productId: 'a', productName: 'A', quantity: 1, unitPrice: 50, totalPrice: 50, costPrice: 20 },
      { productId: 'b', productName: 'B', quantity: 1, unitPrice: 200, totalPrice: 200, costPrice: 50 },
    ],
  });
  await complete(f, {
    items: { create: [{ productId: 'a', quantity: 1, unitPrice: 51.75, restockable: true, restocked: true }] },
  });
  const s = (await ReportService.getSalesReport(f.shop.id, range(21))).summary;
  expect(s).toMatchObject({ returns: 51.75, returnedTax: 6.75, reversedCost: 15, netRevenue: -45, grossProfit: -30 });
});
it('rejects missing or cross-shop original evidence rather than fabricating a reversal', async () => {
  const f = fixture();
  await complete(f, { saleId: 'foreign-sale' });
  await expect(ReportService.getSalesReport(f.shop.id, range(21))).rejects.toThrow('Original sale evidence missing');
});
it('retains COGS when marked restockable but not actually restored to stock', async () => {
  const f = fixture();
  await complete(f, {
    items: {
      create: [{ productId: f.product.id, quantity: 2, unitPrice: 103.5, restockable: true, restocked: false }],
    },
  });
  expect((await ReportService.getSalesReport(f.shop.id, range(21))).summary).toMatchObject({
    returns: 207,
    reversedCost: 0,
    grossProfit: -180,
  });
});
