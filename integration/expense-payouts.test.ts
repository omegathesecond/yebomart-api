import { randomUUID } from 'crypto';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { recordExpense } from '../src/services/expense.service';
import { ReturnController } from '../src/controllers/return.controller';
import { ExpenseController } from '../src/controllers/expense.controller';
import { ReportService } from '../src/services/report.service';
import { CashSessionService as tills } from '../src/services/cashSession.service';
import { ordered } from './orderedLock';

let shopId: string;
const shops: string[] = [];
let hook: ((params: any) => Promise<void>) | undefined;
let failInsert = false;
prisma.$use(async (p, next) => {
  if (failInsert && p.model === 'Expense' && p.action === 'create') throw new Error('forced expense failure');
  const result = await next(p); await hook?.(p); return result;
});
beforeEach(async () => {
  shopId = (await prisma.shop.create({ data: { name: 'Expense test', ownerName: 'Test', ownerPhone: randomUUID(), ownerYeboidSub: randomUUID() } })).id;
  shops.push(shopId);
});
afterAll(async () => {
  for (const id of shops) {
    await prisma.expense.deleteMany({ where: { shopId: id } });
    await prisma.return.deleteMany({ where: { shopId: id } });
    await prisma.customerCredit.deleteMany({ where: { shopId: id } });
    await prisma.sale.deleteMany({ where: { shopId: id } });
    await prisma.shop.delete({ where: { id } });
  }
  await prisma.$disconnect();
});
const input = (cashSessionId?: string) => ({ category: 'TRANSPORT' as const, amount: 50, date: new Date(),
  fundingSource: cashSessionId ? 'TILL_CASH' as const : 'OUTSIDE_TILL' as const, cashSessionId, submissionKey: randomUUID() });
function res() { const r: any = {}; r.status = (n: number) => { r.code = n; return r; }; r.json = (body: any) => { r.body = body; return r; }; return r; }

it('200 minus 50 is 150 exactly once, outside-till leaves drawer alone, profit counts one row per expense', async () => {
  const till = await tills.open({ shopId, openingFloat: 200 });
  const cash = input(till.id);
  const [a, b] = await Promise.all([recordExpense(shopId, cash), recordExpense(shopId, cash)]);
  expect(a.id).toBe(b.id);
  await recordExpense(shopId, input());
  expect(await tills.getCurrent(shopId)).toMatchObject({ expensePayoutsTotal: 50, expensePayoutsCount: 1, expectedCash: 150 });
  const closed = await tills.close({ shopId, sessionId: till.id, countedCash: 150 });
  expect(closed).toMatchObject({ expectedCash: 150, expensePayoutsTotal: 50, variance: 0 });
  await tills.open({ shopId, openingFloat: 500 });
  expect((await recordExpense(shopId, cash)).id).toBe(a.id);
  expect(await tills.getCurrent(shopId)).toMatchObject({ expectedCash: 500, expensePayoutsTotal: 0 });
  for (const op of ['update', 'delete'] as const) {
    const response = res();
    await ExpenseController[op]({ user: { shopId }, params: { id: a.id }, body: { amount: 90 } } as any, response);
    expect(response.code).toBe(400);
  }
  expect(await tills.zReport(till.id, shopId)).toMatchObject({ expensePayoutsTotal: 50, expensePayoutsCount: 1, session: { expectedCash: 150, variance: 0 } });
  const report = await ReportService.getDailyReport(shopId, cash.date);
  expect(report.summary).toMatchObject({ totalExpenses: 100, netProfit: -100 });
  await expect(recordExpense(shopId, { ...cash, amount: 51 })).rejects.toThrow('different expense');
  expect(await prisma.expense.count({ where: { shopId } })).toBe(2);
});

for (const payoutFirst of [true, false]) it(`serializes payout/close with ${payoutFirst ? 'payout' : 'close'} first`, async () => {
  const till = await tills.open({ shopId, openingFloat: 200 });
  const pay = () => recordExpense(shopId, input(till.id)).then(value => ({ value, error: null }), error => ({ value: null, error }));
  const close = () => tills.close({ shopId, sessionId: till.id, countedCash: payoutFirst ? 150 : 200 });
  const setHook = (h: typeof hook) => { hook = h; };
  const outcomes = payoutFirst ? await ordered(setHook, 'Expense', 'create', pay, close)
    : await ordered(setHook, 'CashSession', 'updateMany', close, pay);
  const outcome = outcomes[payoutFirst ? 0 : 1] as Awaited<ReturnType<typeof pay>>;
  if (payoutFirst) expect(outcome.value?.cashSessionId).toBe(till.id);
  else {
    expect(outcome.error.message).toContain('closed');
    expect(outcome.error.code).toBe('EXPENSE_PAYOUT_NOT_RECORDED');
  }
  expect(await prisma.expense.count({ where: { shopId } })).toBe(payoutFirst ? 1 : 0);
  expect(await tills.zReport(till.id, shopId)).toMatchObject({ expensePayoutsTotal: payoutFirst ? 50 : 0, session: { expectedCash: payoutFirst ? 150 : 200 } });
});

it('requires exact open shop-owned till; outside-till needs none; rejects cross-shop edits/deletes', async () => {
  const outside = await recordExpense(shopId, input());
  await expect(recordExpense(shopId, input('missing'))).rejects.toThrow('Open a till');
  const other = (await prisma.shop.create({ data: { name: 'Other', ownerName: 'Test', ownerPhone: randomUUID(), ownerYeboidSub: randomUUID() } })).id;
  shops.push(other);
  const foreign = await tills.open({ shopId: other, openingFloat: 200 });
  await expect(recordExpense(shopId, input(foreign.id))).rejects.toThrow('Open a till');
  for (const op of ['update', 'delete'] as const) {
    const response = res();
    await ExpenseController[op]({ user: { shopId: other }, params: { id: outside.id }, body: { amount: 90 } } as any, response);
    expect(response.code).toBe(404);
  }
  expect(await tills.getCurrent(other)).toMatchObject({ expectedCash: 200 });
});

it('rolls failed payout back and retries once; retains historical unknown funding and saved totals', async () => {
  const till = await tills.open({ shopId, openingFloat: 200 });
  const payload = input(till.id);
  failInsert = true;
  try { await expect(recordExpense(shopId, payload)).rejects.toThrow('forced expense failure'); } finally { failInsert = false; }
  expect(await tills.getCurrent(shopId)).toMatchObject({ expectedCash: 200, expensePayoutsTotal: 0 });
  await recordExpense(shopId, payload); await recordExpense(shopId, payload);
  await prisma.expense.create({ data: { shopId, amount: 80, category: 'OTHER', date: new Date() } });
  expect(await tills.getCurrent(shopId)).toMatchObject({ expectedCash: 150, expensePayoutsTotal: 50 });
  await prisma.cashSession.update({ where: { id: till.id }, data: { status: 'CLOSED', closedAt: new Date(), expectedCash: 77, countedCash: 80, variance: 3 } });
  expect(await tills.zReport(till.id, shopId)).toMatchObject({ expensePayoutsTotal: null, expensePayoutsCount: null, session: { expectedCash: 77, variance: 3 } });
});

it('preserves cash sales, refunds and collection accounting alongside expense payouts', async () => {
  const till = await tills.open({ shopId, openingFloat: 100 });
  await prisma.sale.create({ data: { shopId, cashSessionId: till.id, paymentMethod: 'CASH', subtotal: 100, totalAmount: 100, amountPaid: 100 } });
  const customer = await prisma.customer.create({ data: { shopId, name: 'Buyer' } });
  await prisma.customerCredit.create({ data: { shopId, customerId: customer.id, type: 'PAYMENT', amount: 30, cashSessionId: till.id, collectionMethod: 'CASH', collectionKey: randomUUID() } });
  await recordExpense(shopId, input(till.id));
  const refund = await prisma.return.create({ data: { shopId, type: 'REFUND', status: 'APPROVED', reason: 'Returned', refundAmount: 20 } });
  const response = res();
  await ReturnController.process({ user: { id: shopId, shopId, type: 'shop' }, params: { id: refund.id },
    body: { action: 'complete', settlement: { method: 'CASH', confirmed: true } } } as any, response);
  expect(response.code).toBe(200);
  expect(await tills.getCurrent(shopId)).toMatchObject({ expectedCash: 160, cashRefundsTotal: 20, cashSalesTotal: 100, cashCollectionsTotal: 30, expensePayoutsTotal: 50 });
  expect(await tills.close({ shopId, sessionId: till.id, countedCash: 160 })).toMatchObject({ expectedCash: 160, variance: 0 });
});
