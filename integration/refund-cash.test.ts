import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { ReturnController } from '../src/controllers/return.controller';
import { CashSessionService as tills } from '../src/services/cashSession.service';
import { race } from './lockedRace';
let shopId: string, productId: string, saleId: string;
const shops: string[] = [];
async function process(id: string, body: object, shop = shopId) {
  const res: any = { statusCode: 200, status(n: number) { this.statusCode = n; return this; }, json(body: any) { this.body = body; return this; } };
  await ReturnController.process({ user: { shopId: shop, id: shop, type: 'shop' }, params: { id }, body } as any, res);
  return res;
}
const cash = { action: 'complete', settlementMethod: 'CASH', paymentConfirmed: true };
async function refund(extra: any = {}) {
  return prisma.return.create({ data: { shopId, saleId, type: 'REFUND', status: 'APPROVED', reason: 'Returned item', refundAmount: 20,
    items: { create: { productId, productName: 'Item', quantity: 1, unitPrice: 20, restockable: false } }, ...extra } });
}
beforeEach(async () => {
  const shop = await prisma.shop.create({ data: { name: 'Refund cash', ownerName: 'Test', ownerYeboidSub: randomUUID(), ownerPhone: randomUUID() } });
  shopId = shop.id; shops.push(shopId);
  productId = (await prisma.product.create({ data: { shopId, name: 'Item', sellPrice: 20, costPrice: 10, quantity: 10 } })).id;
  saleId = (await prisma.sale.create({ data: { shopId, subtotal: 100, totalAmount: 100, amountPaid: 100, paymentMethod: 'CASH', createdAt: new Date('2020-01-01'), items: { create: { productId, productName: 'Item', quantity: 5, unitPrice: 20, costPrice: 10, totalPrice: 100 } } } })).id;
});
afterAll(async () => {
  for (const id of shops) {
    await prisma.return.deleteMany({ where: { shopId: id } });
    await prisma.saleItem.deleteMany({ where: { sale: { shopId: id } } });
    await prisma.sale.deleteMany({ where: { shopId: id } });
    await prisma.shop.delete({ where: { id } });
  }
  await prisma.$disconnect();
});
describe('Recorded refund cash outflows', () => {
  it('attributes a prior-day sale refund to today and reconciles 100 + 50 - 20 = 130 once', async () => {
    const till = await tills.open({ shopId, openingFloat: 100 });
    await prisma.sale.create({ data: { shopId, subtotal: 50, totalAmount: 50, amountPaid: 50, paymentMethod: 'CASH' } });
    const r = await refund();
    expect((await process(r.id, cash)).statusCode).toBe(200);
    expect((await process(r.id, cash)).statusCode).toBe(400);
    expect(await tills.getCurrent(shopId)).toMatchObject({ cashRefundsTotal: 20, expectedCash: 130 });
    expect(await tills.close({ shopId, sessionId: till.id, countedCash: 130 })).toMatchObject({ expectedCash: 130, variance: 0 });
    expect(await tills.zReport(till.id, shopId)).toMatchObject({ cashRefundsTotal: 20, gross: 50, totalAmount: 50, session: { expectedCash: 130, variance: 0 } });
    const next = await tills.open({ shopId, openingFloat: 0 });
    expect(await tills.getCurrent(shopId)).toMatchObject({ id: next.id, cashRefundsTotal: 0, expectedCash: 0 });
    expect((await tills.zReport(till.id, shopId)).session.expectedCash).toBe(130);
  });
  it('excludes noncash, store credit, pending and rejected returns', async () => {
    await tills.open({ shopId, openingFloat: 100 });
    const noncash = await refund();
    expect((await process(noncash.id, { ...cash, settlementMethod: 'CARD', settlementReference: 'provider-confirmed-123' })).statusCode).toBe(200);
    const credit = await refund({ type: 'STORE_CREDIT', refundAmount: 0 });
    expect((await process(credit.id, { action: 'complete' })).statusCode).toBe(200);
    await refund({ status: 'PENDING' });
    await refund({ status: 'REJECTED' });
    expect(await tills.getCurrent(shopId)).toMatchObject({ cashRefundsTotal: 0, expectedCash: 100 });
  });
  it('rejects absent till, unapproved/unconfirmed money, missing references and foreign shops', async () => {
    const r = await refund();
    const otherShop = await prisma.shop.create({ data: { name: 'Other drawer', ownerName: 'Test', ownerYeboidSub: randomUUID(), ownerPhone: randomUUID() } });
    shops.push(otherShop.id);
    await tills.open({ shopId: otherShop.id, openingFloat: 500 });
    expect((await process(r.id, cash)).statusCode).toBe(400);
    expect((await process(r.id, cash, otherShop.id)).statusCode).toBe(400);
    expect(await tills.getCurrent(otherShop.id)).toMatchObject({ expectedCash: 500, cashRefundsTotal: 0 });
    await tills.open({ shopId, openingFloat: 100 });
    for (const body of [{ action: 'complete' }, { ...cash, paymentConfirmed: false }, { ...cash, settlementMethod: 'CARD' }])
      expect((await process(r.id, body)).statusCode).toBe(400);
    const pending = await refund({ status: 'PENDING' });
    expect((await process(pending.id, cash)).statusCode).toBe(400);
    expect((await process(r.id, cash, randomUUID())).statusCode).toBe(400);
    expect(await tills.getCurrent(shopId)).toMatchObject({ cashRefundsTotal: 0 });
  });
  it('serializes concurrent close and payout; closed figures never change', async () => {
    const till = await tills.open({ shopId, openingFloat: 100 });
    const r = await refund();
    const results = await race<any>(Prisma.sql`SELECT id FROM "CashSession" WHERE id = ${till.id} FOR UPDATE`, [
      () => process(r.id, cash), () => tills.close({ shopId, sessionId: till.id, countedCash: 80 }),
    ]);
    expect(results.every(r => r.status === 'fulfilled')).toBe(true);
    const returned = await prisma.return.findUniqueOrThrow({ where: { id: r.id } });
    const closed = await prisma.cashSession.findUniqueOrThrow({ where: { id: till.id } });
    expect(closed.expectedCash).toBe(returned.status === 'COMPLETED' ? 80 : 100);
    expect((await process(r.id, cash)).statusCode).toBe(400);
    expect((await tills.zReport(till.id, shopId)).session.expectedCash).toBe(closed.expectedCash);
  });
  it('records exactly one payout for concurrent completion retries', async () => {
    await tills.open({ shopId, openingFloat: 100 });
    const r = await refund();
    const results = await race<any>(Prisma.sql`SELECT id FROM "Sale" WHERE id = ${saleId} FOR NO KEY UPDATE`, [
      () => process(r.id, cash), () => process(r.id, cash),
    ]);
    expect(results.map(r => r.status === 'fulfilled' ? r.value.statusCode : 500).sort()).toEqual([200, 400]);
    expect(await tills.getCurrent(shopId)).toMatchObject({ cashRefundsTotal: 20, expectedCash: 80 });
  });
  it('rolls back settlement when the final return write fails', async () => {
    await tills.open({ shopId, openingFloat: 100 });
    const r = await refund({ items: { create: { productId, productName: 'Item', quantity: 1, unitPrice: 20, restockable: true } } });
    await prisma.$executeRawUnsafe(`CREATE FUNCTION fail_cash_return() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${r.id}' THEN RAISE EXCEPTION 'forced rollback'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER fail_cash_return BEFORE UPDATE ON "Return" FOR EACH ROW EXECUTE FUNCTION fail_cash_return()');
    try {
      expect((await process(r.id, cash)).statusCode).toBe(500);
      expect(await prisma.return.findUnique({ where: { id: r.id } })).toMatchObject({ status: 'APPROVED', settlementMethod: null, cashSessionId: null });
      expect(await tills.getCurrent(shopId)).toMatchObject({ cashRefundsTotal: 0, expectedCash: 100 });
      expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).quantity).toBe(10);
      expect(await prisma.stockLog.count({ where: { shopId } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER fail_cash_return ON "Return"');
      await prisma.$executeRawUnsafe('DROP FUNCTION fail_cash_return()');
    }
  });
});
