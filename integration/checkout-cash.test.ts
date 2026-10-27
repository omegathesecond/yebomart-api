import { randomUUID } from 'crypto';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { prisma } from '../src/config/prisma';
import { SaleService } from '../src/services/sale.service';
import { CashSessionService as tills } from '../src/services/cashSession.service';
import { ReturnController } from '../src/controllers/return.controller';

vi.mock('../src/services/shop.service', () => ({ ShopService: { incrementUsage: vi.fn() } }));
let shopId: string, productId: string;
const shops: string[] = [];
let hook: ((params: any) => Promise<void>) | undefined;
let failLookup = false;
prisma.$use(async (params, next) => {
  if (failLookup && params.model === 'CashSession' && params.action === 'findFirst')
    throw new Error('forced till lookup failure');
  const result = await next(params);
  await hook?.(params);
  return result;
});
beforeEach(async () => {
  shopId = (await prisma.shop.create({ data: { name: 'Checkout race', ownerName: 'Test', ownerPhone: randomUUID(), ownerYeboidSub: randomUUID() } })).id;
  shops.push(shopId);
  productId = (await prisma.product.create({ data: { shopId, name: 'Item', quantity: 10, sellPrice: 20, costPrice: 5 } })).id;
});
afterAll(async () => {
  for (const id of shops) {
    await prisma.return.deleteMany({ where: { shopId: id } });
    await prisma.stockLog.deleteMany({ where: { shopId: id } });
    await prisma.sale.deleteMany({ where: { shopId: id } });
    await prisma.shop.delete({ where: { id } });
  }
  await prisma.$disconnect();
});
const checkout = (localId = randomUUID()) => SaleService.create({ shopId, paymentMethod: 'CASH', amountPaid: 20, localId, items: [{ productId, quantity: 1 }] });

// Pause a real transaction after it owns its lock; verify the other backend
// actually blocks before releasing it. No timing-based assumption of overlap.
async function ordered<T, U>(model: string, action: string, first: () => Promise<T>, second: () => Promise<U>) {
  let ready!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { ready = r; });
  const gate = new Promise<void>(r => { release = r; });
  hook = async p => { if (p.model === model && p.action === action) { hook = undefined; ready(); await gate; } };
  const a = first();
  await entered;
  const b = second();
  try {
    let waiting = false;
    for (const deadline = Date.now() + 3000; Date.now() < deadline;) {
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (Number(rows[0].n) > 0) { waiting = true; break; }
      await new Promise(r => setTimeout(r, 20));
    }
    expect(waiting).toBe(true);
  } finally { release(); hook = undefined; }
  return Promise.all([a, b]);
}
for (const saleFirst of [true, false]) it(`serializes checkout and close with ${saleFirst ? 'checkout' : 'close'} first`, async () => {
  const session = await tills.open({ shopId, openingFloat: 100 });
  const localId = randomUUID();
  const close = () => tills.close({ shopId, sessionId: session.id, countedCash: saleFirst ? 120 : 100 });
  const sale = () => checkout(localId);
  const result = saleFirst
    ? await ordered('Sale', 'create', sale, close)
    : await ordered('CashSession', 'updateMany', close, sale);
  const saved = await prisma.sale.findFirstOrThrow({ where: { shopId } });
  expect(saved.cashSessionId).toBe(saleFirst ? session.id : null);
  expect(await checkout(localId)).toMatchObject({ id: saved.id });
  expect(await prisma.sale.count({ where: { shopId } })).toBe(1);
  expect(await prisma.product.findUniqueOrThrow({ where: { id: productId } })).toMatchObject({ quantity: 9 });
  const report = await tills.zReport(session.id, shopId);
  expect(report.session).toMatchObject({ expectedCash: saleFirst ? 120 : 100, variance: 0 });
  expect(report.byPaymentMethod.find(m => m.method === 'CASH')?.total ?? 0).toBe(saleFirst ? 20 : 0);
  expect(result).toHaveLength(2);
});
it('allows no-till checkout but propagates lookup failures without sale or stock effects', async () => {
  failLookup = true;
  try { await expect(checkout()).rejects.toThrow('forced till lookup failure'); }
  finally { failLookup = false; }
  expect(await prisma.sale.count({ where: { shopId } })).toBe(0);
  expect(await prisma.product.findUniqueOrThrow({ where: { id: productId } })).toMatchObject({ quantity: 10 });
  expect(await checkout()).toMatchObject({ cashSessionId: null });
});
it('checkout and refund share till-before-product ordering while close waits', async () => {
  const session = await tills.open({ shopId, openingFloat: 100 });
  const ret = await prisma.return.create({ data: { shopId, type: 'REFUND', status: 'APPROVED', reason: 'Returned', refundAmount: 20,
    items: { create: { productId, productName: 'Item', quantity: 1, unitPrice: 20, restockable: true } } } });
  const res: any = { statusCode: 200, status(n: number) { this.statusCode = n; return this; }, json() { return this; } };
  const [, outcomes] = await ordered('Sale', 'create', () => checkout(), () => Promise.all([
    ReturnController.process({ user: { id: shopId, shopId, type: 'shop' }, params: { id: ret.id }, body: { action: 'complete', settlement: { method: 'CASH', confirmed: true } } } as any, res),
    tills.close({ shopId, sessionId: session.id, countedCash: 100 }),
  ]));
  const closed = outcomes[1];
  expect([200, 400]).toContain(res.statusCode);
  expect(closed.expectedCash).toBe(res.statusCode === 200 ? 100 : 120);
  const report = await tills.zReport(session.id, shopId);
  expect(report.session.expectedCash).toBe(closed.expectedCash);
  expect(100 + report.byPaymentMethod[0].total - report.cashRefundsTotal).toBe(closed.expectedCash);
});

it('uses drawer membership despite overlapping or skewed sale timestamps', async () => {
  const session = await tills.open({ shopId, openingFloat: 100 });
  await checkout();
  await prisma.sale.updateMany({ where: { shopId }, data: { createdAt: new Date(session.openedAt.getTime() - 86400000) } });
  await prisma.sale.create({ data: { shopId, subtotal: 999, totalAmount: 999, amountPaid: 999, paymentMethod: 'CASH', createdAt: session.openedAt } });
  expect(await tills.close({ shopId, sessionId: session.id, countedCash: 120 })).toMatchObject({ expectedCash: 120, variance: 0 });
  const report = await tills.zReport(session.id, shopId);
  expect(report.transactionCount).toBe(1);
  expect(report.byPaymentMethod).toEqual([{ method: 'CASH', total: 20, discount: 0, count: 1 }]);
  expect(report.session.expectedCash).toBe(120);
});
