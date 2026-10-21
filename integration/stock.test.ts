import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { prisma } from '../src/config/prisma';
import { StockService } from '../src/services/stock.service';
import { SaleService } from '../src/services/sale.service';
import { race } from './lockedRace';

vi.mock('../src/services/shop.service', () => ({
  ShopService: { incrementUsage: vi.fn().mockResolvedValue(undefined) },
}));
let shopId: string, userId: string, productId: string;
const shops: string[] = [];
beforeEach(async () => {
  const shop = await prisma.shop.create({ data: {
    name: 'Stock race', ownerName: 'Test', ownerPhone: randomUUID(), ownerYeboidSub: randomUUID(),
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
const adjust = (quantity: number) => StockService.adjust({ shopId, userId, productId, type: 'ADJUSTMENT', quantity });
const receive = (quantity: number) => StockService.receive({ shopId, userId, items: [{ productId, quantity, costPrice: 7 }] });
async function overlap(operations: (() => Promise<unknown>)[]) {
  return race(Prisma.sql`SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE`, operations);
}
async function consistent(expected: number, count: number) {
  expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).quantity).toBe(expected);
  const logs = await prisma.stockLog.findMany({ where: { productId } });
  expect(logs).toHaveLength(count);
  expect(10 + logs.reduce((sum, log) => sum + log.quantity, 0)).toBe(expected);
  // Reconstruct the serialized history without relying on transaction timestamps.
  let current = 10;
  const remaining = [...logs];
  while (remaining.length) {
    const index = remaining.findIndex(log => log.previousQty === current);
    expect(index).toBeGreaterThanOrEqual(0);
    const [log] = remaining.splice(index, 1);
    expect(log.newQty - log.previousQty).toBe(log.quantity);
    current = log.newQty;
  }
  expect(current).toBe(expected);
}
it('overlapping removals reject one request without negative stock', async () => {
  const results = await overlap([() => adjust(-7), () => adjust(-7)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const failure = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
  expect(failure.reason.message).toMatch(/Cannot reduce stock below 0/);
  await consistent(3, 1);
});
it('overlapping restocks preserve both deliveries and cost notes', async () => {
  expect((await overlap([() => receive(5), () => receive(3)])).every(r => r.status === 'fulfilled')).toBe(true);
  await consistent(18, 2);
  const logs = await prisma.stockLog.findMany({ where: { productId } });
  expect(logs.filter(log => log.note?.includes('Cost: 5 → 7'))).toHaveLength(1);
});
it('adjustment and restock preserve both deltas', async () => {
  expect((await overlap([() => adjust(-2), () => receive(5)])).every(r => r.status === 'fulfilled')).toBe(true);
  await consistent(13, 2);
});
it('completed sale and restock preserve units and authoritative logs', async () => {
  const results = await overlap([
    () => SaleService.create({ shopId, userId, paymentMethod: 'CASH', amountPaid: 30, items: [{ productId, quantity: 2 }] }),
    () => receive(5),
  ]);
  expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
  await consistent(13, 2);
});
it('a later failing item rolls back quantity, cost and logs for the batch', async () => {
  const other = await prisma.product.create({ data: { shopId, name: 'Other', quantity: 10, costPrice: 5, sellPrice: 15 } });
  await expect(StockService.receive({ shopId, userId, items: [
    { productId, quantity: 5, costPrice: 9 }, { productId: other.id, quantity: 0 },
  ] })).rejects.toThrow('Quantity must be positive');
  await consistent(10, 0);
  expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).costPrice).toBe(5);
});
it('rejects foreign products and duplicate batches without writes', async () => {
  await expect(StockService.adjust({ shopId: randomUUID(), productId, quantity: 2, type: 'ADJUSTMENT' })).rejects.toThrow('Product not found');
  await expect(StockService.receive({ shopId: randomUUID(), items: [{ productId, quantity: 2 }] })).rejects.toThrow('products not found');
  await expect(StockService.receive({ shopId, items: [{ productId, quantity: 2 }, { productId, quantity: 3 }] })).rejects.toThrow('Duplicate');
  await consistent(10, 0);
});
it('opposite batch orders serialize without deadlocking', async () => {
  const other = await prisma.product.create({ data: { shopId, name: 'Other', quantity: 10, costPrice: 5, sellPrice: 15 } });
  const batch = (ids: string[]) => StockService.receive({ shopId, userId, items: ids.map(id => ({ productId: id, quantity: 1 })) });
  const results = await overlap([() => batch([productId, other.id]), () => batch([other.id, productId])]);
  expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
  await consistent(12, 2);
  expect((await prisma.product.findUniqueOrThrow({ where: { id: other.id } })).quantity).toBe(12);
});
