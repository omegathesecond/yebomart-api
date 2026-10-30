import { randomUUID } from 'crypto';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { PurchaseOrderController } from '../src/controllers/purchaseOrder.controller';
import { CashSessionService as tills } from '../src/services/cashSession.service';
import { ReportService } from '../src/services/report.service';
import { recordExpense } from '../src/services/expense.service';
import { ordered } from './orderedLock';
let shopId: string, supplierId: string, poId: string;
const shops: string[] = [];
let hook: ((p: any) => Promise<void>) | undefined;
let failUpdate = false;
prisma.$use(async (p, next) => {
  if (failUpdate && p.model === 'PurchaseOrder' && p.action === 'update') throw new Error('forced final update failure');
  const result = await next(p); await hook?.(p); return result;
});
beforeEach(async () => {
  shopId = (await prisma.shop.create({ data: { name: 'Supplier payout test', ownerName: 'Test', ownerPhone: randomUUID(), ownerYeboidSub: randomUUID() } })).id;
  shops.push(shopId);
  supplierId = (await prisma.supplier.create({ data: { shopId, name: 'Supplier', balance: 115 } })).id;
  poId = (await prisma.purchaseOrder.create({ data: { shopId, supplierId, status: 'RECEIVED', subtotal: 100, tax: 15, totalAmount: 115, amountReceived: 115 } })).id;
});
afterAll(async () => {
  for (const id of shops) {
    await prisma.supplierLedger.deleteMany({ where: { shopId: id } });
    await prisma.expense.deleteMany({ where: { shopId: id } });
    await prisma.customerCredit.deleteMany({ where: { shopId: id } });
    await prisma.return.deleteMany({ where: { shopId: id } });
    await prisma.sale.deleteMany({ where: { shopId: id } });
    await prisma.shop.delete({ where: { id } });
  }
  await prisma.$disconnect();
});
const input = (cashSessionId?: string) => ({ amount: 50, note: 'Already paid', fundingSource: cashSessionId ? 'TILL_CASH' : 'OUTSIDE_TILL', ...(cashSessionId ? { cashSessionId } : {}), submissionKey: randomUUID() });
async function pay(body: any, activeShop = shopId, orderId = poId) {
  const r: any = { code: 200 }; r.status = (n: number) => { r.code = n; return r; }; r.json = (b: any) => { r.body = b; return r; };
  await PurchaseOrderController.recordPayment({ user: { id: activeShop, shopId: activeShop, type: 'shop' }, params: { id: orderId }, body } as any, r);
  return r;
}
async function state(paid: number, balance: number, count: number) {
  expect(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).toMatchObject({ amountPaid: paid, amountReceived: 115 });
  expect(await prisma.supplier.findUniqueOrThrow({ where: { id: supplierId } })).toMatchObject({ balance });
  expect(await prisma.supplierLedger.count({ where: { shopId, type: 'PAYMENT' } })).toBe(count);
}
it('200 minus 50 exactly once, external neutral, retry after close and reopen; saved Z is immutable; no sales/expense/profit posting', async () => {
  const till = await tills.open({ shopId, openingFloat: 200 });
  const cash = input(till.id);
  expect((await Promise.all([pay(cash), pay(cash)])).map(r => r.code)).toEqual([200, 200]);
  expect((await pay(input())).code).toBe(200);
  await state(100, 15, 2);
  expect(await tills.getCurrent(shopId)).toMatchObject({ supplierPayoutsTotal: 50, supplierPayoutsCount: 1, expectedCash: 150 });
  expect(await tills.close({ shopId, sessionId: till.id, countedCash: 150 })).toMatchObject({ expectedCash: 150, supplierPayoutsTotal: 50, variance: 0 });
  await tills.open({ shopId, openingFloat: 300 });
  expect((await pay(cash)).code).toBe(200);
  await state(100, 15, 2);
  expect((await pay({ ...cash, amount: 51 })).code).toBe(409);
  expect((await pay({ ...cash, note: 'changed' })).code).toBe(409);
  expect(await tills.getCurrent(shopId)).toMatchObject({ expectedCash: 300, supplierPayoutsTotal: 0 });
  expect(await tills.zReport(till.id, shopId)).toMatchObject({ supplierPayoutsTotal: 50, supplierPayoutsCount: 1, session: { expectedCash: 150, variance: 0 } });
  expect((await ReportService.getDailyReport(shopId, new Date())).summary).toMatchObject({ totalExpenses: 0, netProfit: 0, totalSales: 0 });
  // Closed Z must use saved supplier totals, not recompute from ledger.
  await prisma.cashSession.update({ where: { id: till.id }, data: { supplierPayoutsTotal: 42, supplierPayoutsCount: 7 } });
  expect(await tills.zReport(till.id, shopId)).toMatchObject({ supplierPayoutsTotal: 42, supplierPayoutsCount: 7, session: { expectedCash: 150 } });
});
for (const payoutFirst of [true, false]) it(`serializes supplier payment/close with ${payoutFirst ? 'payment' : 'close'} first`, async () => {
  const till = await tills.open({ shopId, openingFloat: 200 });
  const payment = () => pay(input(till.id));
  const close = () => tills.close({ shopId, sessionId: till.id, countedCash: payoutFirst ? 150 : 200 });
  const setHook = (h: typeof hook) => { hook = h; };
  const outcomes = payoutFirst ? await ordered(setHook, 'SupplierLedger', 'create', payment, close)
    : await ordered(setHook, 'CashSession', 'updateMany', close, payment);
  expect((outcomes[payoutFirst ? 0 : 1] as any).code).toBe(payoutFirst ? 200 : 400);
  await state(payoutFirst ? 50 : 0, payoutFirst ? 65 : 115, payoutFirst ? 1 : 0);
  expect(await tills.zReport(till.id, shopId)).toMatchObject({ supplierPayoutsTotal: payoutFirst ? 50 : 0, session: { expectedCash: payoutFirst ? 150 : 200 } });
});
it('rejects foreign till/PO, missing/closed till, invalid funding and caps without changing balances or drawer; failed final update rolls back', async () => {
  const till = await tills.open({ shopId, openingFloat: 200 });
  const other = (await prisma.shop.create({ data: { name: 'Other', ownerName: 'Test', ownerPhone: randomUUID(), ownerYeboidSub: randomUUID() } })).id; shops.push(other);
  const foreignTill = await tills.open({ shopId: other, openingFloat: 500 });
  for (const payload of [input(foreignTill.id), input('missing'), { ...input(till.id), amount: 115.01 }, { amount: 50 }, { ...input(), cashSessionId: till.id }]) expect((await pay(payload)).code).toBe(400);
  expect((await pay(input(foreignTill.id), other)).code).toBe(404);
  const payload = input(till.id);
  failUpdate = true;
  try { expect((await pay(payload)).code).toBe(500); } finally { failUpdate = false; }
  await state(0, 115, 0);
  expect(await tills.getCurrent(shopId)).toMatchObject({ expectedCash: 200, supplierPayoutsTotal: 0 });
  expect((await pay(payload)).code).toBe(200);
  expect((await pay({ ...input(), amount: 65 })).code).toBe(200);
  await state(115, 0, 2);
  expect((await pay(input())).code).toBe(400);
});
it('preserves legacy unknown attribution and all other cash movements', async () => {
  const till = await tills.open({ shopId, openingFloat: 100 });
  await prisma.supplierLedger.create({ data: { shopId, supplierId, poId, type: 'PAYMENT', amount: 80 } });
  await prisma.sale.create({ data: { shopId, cashSessionId: till.id, paymentMethod: 'CASH', subtotal: 100, totalAmount: 100, amountPaid: 100 } });
  const customer = await prisma.customer.create({ data: { shopId, name: 'Buyer' } });
  await prisma.customerCredit.create({ data: { shopId, customerId: customer.id, type: 'PAYMENT', amount: 30, cashSessionId: till.id, collectionMethod: 'CASH', collectionKey: randomUUID() } });
  await prisma.return.create({ data: { shopId, type: 'REFUND', status: 'COMPLETED', reason: 'Return', refundAmount: 20, cashSessionId: till.id, settlementMethod: 'CASH', settledAt: new Date() } });
  await recordExpense(shopId, { category: 'OTHER', amount: 10, date: new Date(), fundingSource: 'TILL_CASH', cashSessionId: till.id, submissionKey: randomUUID() });
  expect((await pay(input(till.id))).code).toBe(200);
  expect(await tills.getCurrent(shopId)).toMatchObject({ expectedCash: 150, supplierPayoutsTotal: 50, expensePayoutsTotal: 10, cashRefundsTotal: 20, cashCollectionsTotal: 30, cashSalesTotal: 100 });
  expect(await tills.close({ shopId, sessionId: till.id, countedCash: 150 })).toMatchObject({ expectedCash: 150, supplierPayoutsTotal: 50 });
  await prisma.cashSession.update({ where: { id: till.id }, data: { supplierPayoutsTotal: null, supplierPayoutsCount: null } });
  expect(await tills.zReport(till.id, shopId)).toMatchObject({ supplierPayoutsTotal: null, supplierPayoutsCount: null, session: { expectedCash: 150 } });
});
