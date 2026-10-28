import { ordered as orderedLock } from './orderedLock';
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
const ordered = <T, U>(model: string, action: string, first: () => Promise<T>, second: () => Promise<U>) => orderedLock(h => { hook = h; }, model, action, first, second);
const checkout = (localId = randomUUID()) => SaleService.create({ shopId, paymentMethod: 'CASH', amountPaid: 20, localId, items: [{ productId, quantity: 1 }] });

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

const voidSale = (id: string) => SaleService.voidSale(id, shopId, undefined, 'Checkout mistake');
async function expectCashUp(sessionId: string, expected: number) {
  expect(await prisma.cashSession.findUniqueOrThrow({ where: { id: sessionId } }))
    .toMatchObject({ status: 'CLOSED', countedCash: expected, expectedCash: expected, variance: 0 });
  const report = await tills.zReport(sessionId, shopId);
  expect(report.session).toMatchObject({ expectedCash: expected, variance: 0 });
  expect(report.byPaymentMethod.find(m => m.method === 'CASH')?.total ?? 0).toBe(expected);
}
for (const voidFirst of [true, false]) it(`serializes cash void and close with ${voidFirst ? 'void' : 'close'} first`, async () => {
  const session = await tills.open({ shopId, openingFloat: 0 });
  const sale = await checkout();
  const close = () => tills.close({ shopId, sessionId: session.id, countedCash: voidFirst ? 0 : 20 });
  // Attach rejection handling immediately, while the transaction is blocked.
  const attemptVoid = () => voidSale(sale.id).then(() => 'voided', (error: Error) => error.message);
  const results = voidFirst
    ? await ordered('CashSession', 'updateMany', attemptVoid, close)
    : await ordered('CashSession', 'updateMany', close, attemptVoid);
  expect(results[voidFirst ? 0 : 1]).toBe(voidFirst ? 'voided' :
    'Cannot void a cash sale from a closed till. Use the return/refund settlement flow to record the refund.');
  expect(await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } }))
    .toMatchObject({ status: voidFirst ? 'VOIDED' : 'COMPLETED' });
  expect(await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
    .toMatchObject({ quantity: voidFirst ? 10 : 9 });
  expect(await prisma.stockLog.count({ where: { shopId, type: 'RETURN' } })).toBe(voidFirst ? 1 : 0);
  await expectCashUp(session.id, voidFirst ? 0 : 20);
});
it('rejects a closed-till void without changing stock, sale, saved cash-up or reopened Z-report', async () => {
  const session = await tills.open({ shopId, openingFloat: 0 });
  const sale = await checkout();
  await tills.close({ shopId, sessionId: session.id, countedCash: 20 });
  const before = await tills.zReport(session.id, shopId);
  // Opening another drawer must not allow voiding the previous drawer's sale.
  await tills.open({ shopId, openingFloat: 0 });
  await expect(voidSale(sale.id)).rejects.toThrow(/closed till.*return\/refund settlement/);
  expect(await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } }))
    .toMatchObject({ status: 'COMPLETED', voidReason: null });
  expect(await prisma.product.findUniqueOrThrow({ where: { id: productId } })).toMatchObject({ quantity: 9 });
  expect(await prisma.stockLog.count({ where: { shopId, type: 'RETURN' } })).toBe(0);
  await expectCashUp(session.id, 20);
  expect(await tills.zReport(session.id, shopId)).toEqual(before);
});
it.each(['CASH', 'CARD', 'MOMO', 'EMALI', 'MIXED'] as const)('preserves %s voids without a cash drawer', async paymentMethod => {
  const sale = await SaleService.create({ shopId, paymentMethod, amountPaid: 20, items: [{ productId, quantity: 1 }] });
  expect(await voidSale(sale.id)).toMatchObject({ status: 'VOIDED' });
  expect(await prisma.product.findUniqueOrThrow({ where: { id: productId } })).toMatchObject({ quantity: 10 });
});
it('allows a noncash void even when its attached drawer is closed', async () => {
  const session = await tills.open({ shopId, openingFloat: 0 });
  const sale = await SaleService.create({ shopId, paymentMethod: 'CARD', amountPaid: 20, items: [{ productId, quantity: 1 }] });
  await prisma.sale.update({ where: { id: sale.id }, data: { cashSessionId: session.id } });
  await tills.close({ shopId, sessionId: session.id, countedCash: 0 });
  expect(await voidSale(sale.id)).toMatchObject({ status: 'VOIDED' });
  expect(await prisma.product.findUniqueOrThrow({ where: { id: productId } })).toMatchObject({ quantity: 10 });
});
