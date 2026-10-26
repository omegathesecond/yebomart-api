import { randomUUID } from 'crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/config/prisma';
import { CashSessionService as tills } from '../src/services/cashSession.service';
import { ReturnController } from '../src/controllers/return.controller';
import { race } from './lockedRace';

const shops: string[] = [];
let shopId: string, productId: string;
beforeEach(async () => {
  const shop = await prisma.shop.create({ data: { name: 'Refund test', ownerName: 'Test', ownerPhone: randomUUID(), ownerYeboidSub: randomUUID() } });
  shopId = shop.id; shops.push(shopId);
  const product = await prisma.product.create({ data: { shopId, name: 'Item', costPrice: 5, sellPrice: 20, quantity: 5 } });
  productId = product.id;
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
async function refund(overrides: any = {}) {
  return prisma.return.create({ data: { shopId, reason: 'Returned', type: 'REFUND', status: 'APPROVED', refundAmount: 20,
    items: { create: { productId, productName: 'Item', quantity: 1, unitPrice: 20, restockable: true } }, ...overrides } });
}
async function process(id: string, action = 'complete', settlement: any = { method: 'CASH', confirmed: true }, requestShop = shopId) {
  const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; }, json(body: any) { this.body = body; return this; } };
  await ReturnController.process({ user: { id: requestShop, shopId: requestShop, type: 'shop' }, params: { id }, body: { action, settlement } } as any, res);
  return res;
}
async function cashSale(session: { id: string }) {
  return prisma.sale.create({ data: { shopId, cashSessionId: session.id, subtotal: 50, totalAmount: 50, amountPaid: 50, paymentMethod: 'CASH' } });
}
describe('recorded refund cash outflows', () => {
  it('reconciles 100 + 50 - 20 = 130, records once, and keeps closed figures unchanged', async () => {
    const session = await tills.open({ shopId, openingFloat: 100 });
    await cashSale(session);
    const ret = await refund();
    expect((await process(ret.id)).statusCode).toBe(200);
    expect(await tills.getCurrent(shopId)).toMatchObject({ cashRefundsTotal: 20, cashRefundsCount: 1, expectedCash: 130 });
    expect((await process(ret.id)).statusCode).toBe(400);
    expect(await prisma.product.findUnique({ where: { id: productId } })).toMatchObject({ quantity: 6 });
    const closed = await tills.close({ shopId, sessionId: session.id, countedCash: 130 });
    expect(closed).toMatchObject({ expectedCash: 130, variance: 0 });
    const report = await tills.zReport(session.id, shopId);
    expect(report).toMatchObject({ cashRefundsTotal: 20, cashRefundsCount: 1, gross: 50, totalDiscount: 0, totalAmount: 50, tax: 0, net: 50, session: { expectedCash: 130, variance: 0 } });
    await tills.open({ shopId, openingFloat: 10 });
    expect((await process((await refund()).id)).statusCode).toBe(200);
    expect(await tills.zReport(session.id, shopId)).toEqual(report);
  });
  it('attributes a prior-day sale refund to today, never the original closed till', async () => {
    const yesterday = new Date(Date.now() - 86400000);
    const old = await prisma.cashSession.create({ data: { shopId, openingFloat: 0, openedAt: yesterday, closedAt: new Date(yesterday.getTime() + 1000), status: 'CLOSED', expectedCash: 20, countedCash: 20, variance: 0 } });
    const sale = await prisma.sale.create({ data: { shopId, cashSessionId: old.id, createdAt: yesterday, subtotal: 20, totalAmount: 20, amountPaid: 20, paymentMethod: 'CASH', items: { create: { productId, productName: 'Item', quantity: 1, unitPrice: 20, costPrice: 5, totalPrice: 20 } } } });
    const session = await tills.open({ shopId, openingFloat: 100 });
    const ret = await refund({ saleId: sale.id });
    expect((await process(ret.id)).statusCode).toBe(200);
    expect(await prisma.return.findUnique({ where: { id: ret.id } })).toMatchObject({ cashSessionId: session.id, settlementMethod: 'CASH', settledAt: expect.any(Date) });
    expect(await tills.getCurrent(shopId)).toMatchObject({ expectedCash: 80 });
    expect(await prisma.sale.findUnique({ where: { id: sale.id } })).toMatchObject({ status: 'COMPLETED' });
    expect(await tills.zReport(old.id, shopId)).toMatchObject({ cashRefundsTotal: 0, session: { expectedCash: 20 } });
  });
  it('excludes noncash, store credit, pending, approved, rejected and unrecorded legacy refunds', async () => {
    await tills.open({ shopId, openingFloat: 100 });
    const card = await refund();
    expect((await process(card.id, 'complete', { method: 'CARD', confirmed: true, reference: 'provider-success-123' })).statusCode).toBe(200);
    for (const method of ['MOMO', 'EMALI'])
      expect((await process((await refund()).id, 'complete', { method, confirmed: true, reference: 'confirmed' })).statusCode).toBe(200);
    expect((await process((await refund({ type: 'STORE_CREDIT', refundAmount: 0 })).id)).statusCode).toBe(400); // Reject a money payout on store credit.
    const customer = await prisma.customer.create({ data: { shopId, name: 'Credit recipient' } });
    const sale = await prisma.sale.create({ data: {
      shopId, subtotal: 20, totalAmount: 20, amountPaid: 20, paymentMethod: 'CARD',
      items: { create: { productId, productName: 'Item', quantity: 1, unitPrice: 20, costPrice: 5, totalPrice: 20 } },
    } });
    const credit = await refund({ type: 'STORE_CREDIT', refundAmount: 20, customerId: customer.id, saleId: sale.id });
    expect((await process(credit.id, 'complete', null)).statusCode).toBe(200);
    expect(await prisma.customerCredit.findUnique({ where: { returnId: credit.id } }))
      .toMatchObject({ customerId: customer.id, type: 'REFUND', amount: 20 });
    expect(await prisma.customer.findUnique({ where: { id: customer.id } })).toMatchObject({ balance: -20 });
    for (const status of ['PENDING', 'APPROVED', 'REJECTED', 'COMPLETED']) await refund({ status });
    expect(await tills.getCurrent(shopId)).toMatchObject({ cashRefundsTotal: 0, expectedCash: 100 });
  });
  it('requires approval, explicit confirmation, external success reference and a shop-local open till', async () => {
    const ret = await refund();
    expect((await process(ret.id)).statusCode).toBe(400);
    await tills.open({ shopId, openingFloat: 100 });
    for (const settlement of [null, { method: 'CASH', confirmed: false }, { method: 'CARD', confirmed: true }, { method: 'CREDIT', confirmed: true }])
      expect((await process(ret.id, 'complete', settlement)).statusCode).toBe(400);
    expect((await process((await refund({ status: 'PENDING' })).id)).statusCode).toBe(400);
    expect((await process(ret.id, 'complete', { method: 'CASH', confirmed: true }, 'foreign-shop')).statusCode).toBe(400);
    expect(await prisma.return.findUnique({ where: { id: ret.id } })).toMatchObject({ status: 'APPROVED', cashSessionId: null, settledAt: null });
    expect(await prisma.product.findUnique({ where: { id: productId } })).toMatchObject({ quantity: 5 });
  });
  it('never uses another shop drawer and allows recorded noncash refunds without a till', async () => {
    const other = await prisma.shop.create({ data: { name: 'Other drawer', ownerName: 'Test', ownerPhone: randomUUID(), ownerYeboidSub: randomUUID() } });
    shops.push(other.id);
    await tills.open({ shopId: other.id, openingFloat: 300 });
    const ret = await refund();
    expect((await process(ret.id)).statusCode).toBe(400);
    expect(await tills.getCurrent(other.id)).toMatchObject({ expectedCash: 300, cashRefundsTotal: 0 });
    expect((await process(ret.id, 'complete', { method: 'CARD', confirmed: true, reference: 'paid-success' })).statusCode).toBe(200);
    expect(await prisma.return.findUnique({ where: { id: ret.id } })).toMatchObject({ settlementMethod: 'CARD', cashSessionId: null });
    const rejected = await refund({ status: 'REJECTED' });
    expect((await process(rejected.id)).statusCode).toBe(400);
  });
  it('refuses CREDIT-sale payouts without inventing cash or reducing debt', async () => {
    await tills.open({ shopId, openingFloat: 100 });
    const customer = await prisma.customer.create({ data: { shopId, name: 'Unpaid customer', balance: 20 } });
    const debt = await prisma.customerCredit.create({ data: { shopId, customerId: customer.id, type: 'PURCHASE', amount: 20 } });
    const sale = await prisma.sale.create({ data: { shopId, customerId: customer.id, subtotal: 20, totalAmount: 20, amountPaid: 0, paymentMethod: 'CREDIT', items: { create: { productId, productName: 'Item', quantity: 1, unitPrice: 20, costPrice: 5, totalPrice: 20 } } } });
    expect((await process((await refund({ saleId: sale.id })).id)).statusCode).toBe(400);
    expect(await tills.getCurrent(shopId)).toMatchObject({ expectedCash: 100 });
    expect(await prisma.customer.findUnique({ where: { id: customer.id } })).toMatchObject({ balance: 20 });
    expect(await prisma.customerCredit.findMany({ where: { shopId } })).toEqual([debt]);
  });
  it('serializes concurrent retry and close/refund on the actual till row', async () => {
    const session = await tills.open({ shopId, openingFloat: 100 });
    const ret = await refund();
    const retries = await race(Prisma.sql`SELECT id FROM "Return" WHERE id = ${ret.id} FOR UPDATE`, [() => process(ret.id), () => process(ret.id)]);
    expect(retries.map(r => r.status === 'fulfilled' && r.value.statusCode).sort()).toEqual([200, 400]);
    const next = await refund();
    const overlap = await race<any>(Prisma.sql`SELECT id FROM "CashSession" WHERE id = ${session.id} FOR UPDATE`, [
      () => process(next.id), () => tills.close({ shopId, sessionId: session.id, countedCash: 80 }),
    ]);
    expect(overlap.every(r => r.status === 'fulfilled')).toBe(true);
    const payout = (overlap[0] as PromiseFulfilledResult<any>).value;
    const closed = (overlap[1] as PromiseFulfilledResult<any>).value;
    expect([200, 400]).toContain(payout.statusCode);
    expect(closed.expectedCash).toBe(payout.statusCode === 200 ? 60 : 80);
    expect(await tills.zReport(session.id, shopId)).toMatchObject({ cashRefundsTotal: payout.statusCode === 200 ? 40 : 20, session: { expectedCash: closed.expectedCash } });
  });
  it('rolls back payout attribution and stock when final completion fails', async () => {
    await tills.open({ shopId, openingFloat: 100 });
    const ret = await refund();
    await prisma.$executeRawUnsafe(`CREATE FUNCTION refund_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${ret.id}' THEN RAISE EXCEPTION 'forced completion failure'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER refund_test_failure BEFORE UPDATE ON "Return" FOR EACH ROW EXECUTE FUNCTION refund_test_fail()');
    try {
      expect((await process(ret.id)).statusCode).toBe(500);
      expect(await prisma.return.findUnique({ where: { id: ret.id } })).toMatchObject({ status: 'APPROVED', cashSessionId: null, settlementMethod: null });
      expect(await prisma.product.findUnique({ where: { id: productId } })).toMatchObject({ quantity: 5 });
      expect(await prisma.stockLog.count({ where: { shopId } })).toBe(0);
      expect(await tills.getCurrent(shopId)).toMatchObject({ expectedCash: 100 });
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER refund_test_failure ON "Return"');
      await prisma.$executeRawUnsafe('DROP FUNCTION refund_test_fail()');
    }
  });
});
