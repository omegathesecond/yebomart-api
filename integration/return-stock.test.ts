import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { prisma } from '../src/config/prisma';
import { ReturnController } from '../src/controllers/return.controller';
import { SaleService } from '../src/services/sale.service';
import { StockService } from '../src/services/stock.service';
import { race } from './lockedRace';
import { expectStockHistory } from './stockHistory';

vi.mock('../src/services/shop.service', () => ({
  ShopService: { incrementUsage: vi.fn().mockResolvedValue(undefined) },
}));
let shopId: string, productId: string, userId: string;
const shops: string[] = [];
beforeEach(async () => {
  const shop = await prisma.shop.create({ data: {
    name: 'Return stock race', ownerName: 'Test', ownerPhone: randomUUID(), ownerYeboidSub: randomUUID(),
  } });
  shopId = shop.id;
  shops.push(shopId);
  userId = (await prisma.user.create({ data: { shopId, name: 'Test', phone: randomUUID(), role: 'OWNER' } })).id;
  productId = (await prisma.product.create({ data: { shopId, name: 'Stock', quantity: 10, costPrice: 5, sellPrice: 15 } })).id;
});
afterAll(async () => {
  for (const id of shops) {
    await prisma.saleItem.deleteMany({ where: { sale: { shopId: id } } });
    await prisma.stockLog.deleteMany({ where: { shopId: id } });
    await prisma.sale.deleteMany({ where: { shopId: id } });
    await prisma.shop.delete({ where: { id } });
  }
  await prisma.$disconnect();
});
async function makeReturn(quantity = 2, exchange: { productId: string; quantity: number }[] = []) {
  // Historical sale: current inventory already reflects its original movement.
  const sale = await prisma.sale.create({ data: {
    shopId, userId, receiptNumber: randomUUID(), subtotal: 150, totalAmount: 150,
    paymentMethod: 'CASH', amountPaid: 150, status: 'COMPLETED',
    items: { create: { productId, productName: 'Stock', quantity: 10, unitPrice: 15, costPrice: 5, totalPrice: 150 } },
  } });
  return prisma.return.create({ data: {
    shopId, saleId: sale.id, reason: 'Test', status: 'APPROVED', type: exchange.length ? 'EXCHANGE' : 'REFUND', refundAmount: quantity * 15,
    items: { create: { productId, productName: 'Stock', quantity, unitPrice: 15 } },
    exchangeItems: { create: exchange.map(item => ({ ...item, productName: 'Exchange', unitPrice: 15 })) },
  } });
}
async function complete(id: string, activeShop = shopId) {
  const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; },
    json(body: any) { this.body = body; return this; } };
  const record = await prisma.return.findUniqueOrThrow({ where: { id } });
  await ReturnController.process({ user: { id: userId, shopId: activeShop, type: 'user', role: 'OWNER' },
    params: { id }, body: { action: 'complete', ...(record.type === 'REFUND' ? { settlement: { method: 'CARD', confirmed: true, reference: 'external-refund-success' } } : {}) } } as any, res);
  return res.statusCode as number;
}
const overlap = (operations: (() => Promise<unknown>)[]) =>
  race(Prisma.sql`SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE`, operations);
const consistent = (expected: number, count: number, id = productId) =>
  expectStockHistory(id, expected, count);
async function completed(id: string) {
  expect(await prisma.return.findUniqueOrThrow({ where: { id }, include: { items: true } }))
    .toMatchObject({ status: 'COMPLETED', items: [{ restocked: true }] });
}
it('return versus sale preserves both signed movements and the log chain', async () => {
  const record = await makeReturn();
  const results = await overlap([
    () => complete(record.id),
    () => SaleService.create({ shopId, userId, paymentMethod: 'CASH', amountPaid: 45, items: [{ productId, quantity: 3 }] }),
  ]);
  expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
  expect((results[0] as PromiseFulfilledResult<unknown>).value).toBe(200);
  await consistent(9, 2);
  await completed(record.id);
});
it('return versus restock preserves both deliveries and the log chain', async () => {
  const record = await makeReturn();
  const results = await overlap([
    () => complete(record.id),
    () => StockService.receive({ shopId, userId, items: [{ productId, quantity: 5 }] }),
  ]);
  expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
  expect((results[0] as PromiseFulfilledResult<unknown>).value).toBe(200);
  await consistent(17, 2);
  await completed(record.id);
});
it('returns from different sales serialize on their shared product', async () => {
  const a = await makeReturn(2), b = await makeReturn(3);
  expect(await overlap([() => complete(a.id), () => complete(b.id)]))
    .toEqual([{ status: 'fulfilled', value: 200 }, { status: 'fulfilled', value: 200 }]);
  await consistent(15, 2);
  await completed(a.id);
  await completed(b.id);
});
it('exchange deductions racing a restock use the locked current quantity', async () => {
  const record = await makeReturn(2, [{ productId, quantity: 4 }]);
  const results = await overlap([() => complete(record.id),
    () => StockService.receive({ shopId, userId, items: [{ productId, quantity: 5 }] })]);
  expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
  expect((results[0] as PromiseFulfilledResult<unknown>).value).toBe(200);
  await consistent(13, 3);
});
it('opposite exchange product orders finish without deadlocks', async () => {
  const other = await prisma.product.create({ data: { shopId, name: 'Other', quantity: 10, costPrice: 5, sellPrice: 15 } });
  const a = await makeReturn(2, [{ productId: other.id, quantity: 1 }, { productId, quantity: 1 }]);
  const b = await makeReturn(3, [{ productId, quantity: 1 }, { productId: other.id, quantity: 1 }]);
  expect(await overlap([() => complete(a.id), () => complete(b.id)]))
    .toEqual([{ status: 'fulfilled', value: 200 }, { status: 'fulfilled', value: 200 }]);
  await consistent(13, 4);
  await consistent(8, 2, other.id);
});
it('a database failure after inventory writes rolls back status, flags, stock and logs', async () => {
  const record = await makeReturn(2, [{ productId, quantity: 1 }]);
  // A real database trigger fails the final status write, after all inventory work.
  const suffix = randomUUID().replace(/-/g, '');
  const fn = `fail_return_${suffix}`;
  await prisma.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id = '${record.id}' AND NEW.status = 'COMPLETED' THEN RAISE EXCEPTION 'forced return failure'; END IF;
    RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE UPDATE ON "Return" FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  try {
    expect(await complete(record.id)).toBe(500);
    await consistent(10, 0);
    expect(await prisma.return.findUniqueOrThrow({ where: { id: record.id }, include: { items: true } }))
      .toMatchObject({ status: 'APPROVED', processedAt: null, items: [{ restocked: false }] });
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER ${fn} ON "Return"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION ${fn}()`);
  }
});
it('untracked and non-restockable lines do not move inventory', async () => {
  await prisma.product.update({ where: { id: productId }, data: { trackStock: false } });
  const record = await makeReturn(2, [{ productId, quantity: 1 }]);
  expect(await complete(record.id)).toBe(200);
  await consistent(10, 0);
  expect(await prisma.returnItem.findFirst({ where: { returnId: record.id } })).toMatchObject({ restocked: false });
  await prisma.product.update({ where: { id: productId }, data: { trackStock: true } });
  const second = await makeReturn();
  await prisma.returnItem.updateMany({ where: { returnId: second.id }, data: { restockable: false } });
  expect(await complete(second.id)).toBe(200);
  await consistent(10, 0);
});
