import { randomUUID } from 'crypto';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { applyCustomerCredit } from '../src/services/customerCredit.service';
import { CashSessionService as tills } from '../src/services/cashSession.service';
import { ordered } from './orderedLock';

let shopId: string, customerId: string;
const shops: string[] = [];
let hook: ((params: any) => Promise<void>) | undefined;
let failBalance = false;
prisma.$use(async (p, next) => {
  if (failBalance && p.model === 'Customer' && p.action === 'update') throw new Error('forced balance failure');
  const result = await next(p);
  await hook?.(p);
  return result;
});
beforeEach(async () => {
  shopId = (await prisma.shop.create({ data: { name: 'Collection test', ownerName: 'Test', ownerPhone: randomUUID(), ownerYeboidSub: randomUUID() } })).id;
  shops.push(shopId);
  customerId = (await prisma.customer.create({ data: { shopId, name: 'Customer', balance: 500 } })).id;
});
afterAll(async () => {
  for (const shopId of shops) {
    await prisma.customerCredit.deleteMany({ where: { shopId } });
    await prisma.sale.deleteMany({ where: { shopId } });
    await prisma.shop.delete({ where: { id: shopId } });
  }
  await prisma.$disconnect();
});
const collect = (method: 'CASH' | 'EXTERNAL_NONCASH' = 'CASH', key = randomUUID(), customer = customerId, amount = 100) =>
  prisma.$transaction(tx => applyCustomerCredit(tx, { shopId, customerId: customer, type: 'PAYMENT', amount,
    collectionMethod: method, collectionKey: key }, { currencySymbol: 'E' }));
const balance = () => prisma.customer.findUniqueOrThrow({ where: { id: customerId } });

for (const method of ['CASH', 'EXTERNAL_NONCASH'] as const) it(`${method} reconciles once without adding sales revenue, persists a separate close/Z subtotal`, async () => {
  const session = await tills.open({ shopId, openingFloat: 50 });
  await prisma.sale.create({ data: { shopId, cashSessionId: session.id, subtotal: 200, totalAmount: 200, amountPaid: 200, paymentMethod: 'CASH' } });
  const key = randomUUID();
  const results = await Promise.all([collect(method, key), collect(method, key)]);
  expect(results[0].credit.id).toBe(results[1].credit.id);
  expect(results[0].credit.cashSessionId).toBe(method === 'CASH' ? session.id : null);
  expect(await balance()).toMatchObject({ balance: 400 });
  const subtotal = method === 'CASH' ? 100 : 0;
  expect(await tills.getCurrent(shopId)).toMatchObject({ cashCollectionsTotal: subtotal, expectedCash: 250 + subtotal });
  expect(await tills.close({ shopId, sessionId: session.id, countedCash: 250 + subtotal })).toMatchObject({ expectedCash: 250 + subtotal, cashCollectionsTotal: subtotal, variance: 0 });
  await tills.open({ shopId, openingFloat: 0 });
  await collect('CASH');
  expect((await collect(method, key)).credit.id).toBe(results[0].credit.id);
  const z = await tills.zReport(session.id, shopId);
  expect(z).toMatchObject({ cashCollectionsTotal: subtotal, totalAmount: 200, net: 200, transactionCount: 1, session: { expectedCash: 250 + subtotal } });
  expect(z.byPaymentMethod).toEqual([{ method: 'CASH', total: 200, discount: 0, count: 1 }]);
});

for (const collectionFirst of [true, false]) it(`serializes cash collection/close with ${collectionFirst ? 'collection' : 'close'} owning the till lock first`, async () => {
  const till = await tills.open({ shopId, openingFloat: 50 });
  const close = () => tills.close({ shopId, sessionId: till.id, countedCash: collectionFirst ? 150 : 50 });
  // Convert the expected refusal to a value so neither operation has an unhandled rejection while paused.
  const payment = () => collect().then(value => ({ value, error: null }), error => ({ value: null, error }));
  const setHook = (h: typeof hook) => { hook = h; };
  const outcomes = collectionFirst
    ? await ordered(setHook, 'CustomerCredit', 'create', payment, close)
    : await ordered(setHook, 'CashSession', 'updateMany', close, payment);
  const result = outcomes[collectionFirst ? 0 : 1] as Awaited<ReturnType<typeof payment>>;
  if (collectionFirst) expect(result.value?.credit.cashSessionId).toBe(till.id);
  else expect(result.error?.message).toContain('Open a till');
  expect(await balance()).toMatchObject({ balance: collectionFirst ? 400 : 500 });
  expect(await prisma.customerCredit.count({ where: { shopId } })).toBe(collectionFirst ? 1 : 0);
  expect(await tills.zReport(till.id, shopId)).toMatchObject({ cashCollectionsTotal: collectionFirst ? 100 : 0, session: { expectedCash: collectionFirst ? 150 : 50 } });
});

it('requires cash till, allows external noncash without till, rejects changed retry and foreign customer without effects', async () => {
  await expect(collect()).rejects.toThrow('Open a till');
  const key = randomUUID();
  await collect('EXTERNAL_NONCASH', key);
  await expect(collect('EXTERNAL_NONCASH', key, customerId, 99)).rejects.toThrow('different entry');
  const otherShop = (await prisma.shop.create({ data: { name: 'Other', ownerName: 'Test', ownerPhone: randomUUID(), ownerYeboidSub: randomUUID() } })).id;
  shops.push(otherShop);
  const foreign = await prisma.customer.create({ data: { shopId: otherShop, name: 'Foreign', balance: 300 } });
  await tills.open({ shopId, openingFloat: 0 });
  await expect(collect('CASH', randomUUID(), foreign.id)).rejects.toThrow('Customer not found');
  expect(await prisma.customer.findUniqueOrThrow({ where: { id: foreign.id } })).toMatchObject({ balance: 300 });
  expect(await prisma.customerCredit.count({ where: { shopId } })).toBe(1);
  expect(await tills.getCurrent(shopId)).toMatchObject({ cashCollectionsTotal: 0 });
  await expect(tills.zReport((await tills.getCurrent(shopId))!.id, otherShop)).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

it('rolls ledger and till attribution back on balance failure, then retries exactly once', async () => {
  await tills.open({ shopId, openingFloat: 50 });
  const key = randomUUID();
  failBalance = true;
  try { await expect(collect('CASH', key)).rejects.toThrow('forced balance failure'); }
  finally { failBalance = false; }
  expect(await balance()).toMatchObject({ balance: 500 });
  expect(await prisma.customerCredit.count({ where: { shopId } })).toBe(0);
  expect(await tills.getCurrent(shopId)).toMatchObject({ expectedCash: 50, cashCollectionsTotal: 0 });
  await collect('CASH', key);
  await collect('CASH', key);
  expect(await balance()).toMatchObject({ balance: 400 });
  expect(await prisma.customerCredit.count({ where: { shopId } })).toBe(1);
});

it('excludes ledger adjustments and unclassified historical payments, and preserves historical closed totals as unknown', async () => {
  const till = await tills.open({ shopId, openingFloat: 50 });
  await prisma.customerCredit.create({ data: { shopId, customerId, type: 'PAYMENT', amount: 100 } });
  await prisma.$transaction(tx => applyCustomerCredit(tx, { shopId, customerId, type: 'ADJUSTMENT', amount: -20 }, { currencySymbol: 'E' }));
  expect(await tills.getCurrent(shopId)).toMatchObject({ expectedCash: 50, cashCollectionsTotal: 0 });
  await prisma.cashSession.update({ where: { id: till.id }, data: { status: 'CLOSED', closedAt: new Date(), expectedCash: 77, countedCash: 80, variance: 3 } });
  expect(await tills.zReport(till.id, shopId)).toMatchObject({ cashCollectionsTotal: null, cashCollectionsCount: null, session: { expectedCash: 77, variance: 3 } });
});

it('never uses another shop drawer or a foreign sale to attribute a payment', async () => {
  const otherShop = (await prisma.shop.create({ data: { name: 'Other drawer', ownerName: 'Test', ownerPhone: randomUUID(), ownerYeboidSub: randomUUID() } })).id;
  shops.push(otherShop);
  await tills.open({ shopId: otherShop, openingFloat: 50 });
  await expect(collect()).rejects.toThrow('Open a till');
  const sale = await prisma.sale.create({ data: { shopId: otherShop, subtotal: 100, totalAmount: 100, amountPaid: 100, paymentMethod: 'CASH' } });
  await expect(prisma.$transaction(tx => applyCustomerCredit(tx, { shopId, customerId, type: 'PAYMENT', amount: 100, saleId: sale.id,
    collectionMethod: 'EXTERNAL_NONCASH', collectionKey: randomUUID() }, { currencySymbol: 'E' }))).rejects.toThrow('Sale not found');
  expect(await balance()).toMatchObject({ balance: 500 });
  expect(await prisma.customerCredit.count({ where: { shopId } })).toBe(0);
  expect(await tills.getCurrent(otherShop)).toMatchObject({ expectedCash: 50, cashCollectionsTotal: 0 });
});
