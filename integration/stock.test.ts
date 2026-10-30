import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { prisma } from '../src/config/prisma';
import { ProductService } from '../src/services/product.service';
import { bulkImportSchema, updateProductSchema, bulkUpdateSchema } from '../src/controllers/product.controller';
import { StockService } from '../src/services/stock.service';
import { SaleService } from '../src/services/sale.service';
import { race } from './lockedRace';
import { expectStockHistory } from './stockHistory';


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
const consistent = (expected: number, count: number, id = productId) =>
  expectStockHistory(id, expected, count);
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
  expect((await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).monthlyStockMoves).toBe(0);
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
  expect((await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).monthlyStockMoves).toBe(4);
  expect((await prisma.product.findUniqueOrThrow({ where: { id: other.id } })).quantity).toBe(12);
});

it('saving metadata after a sale preserves the live stock and sale log', async () => {
  const loaded = await ProductService.getById(productId, shopId);
  expect(loaded.quantity).toBe(10);
  await SaleService.create({ shopId, userId, paymentMethod: 'CASH', amountPaid: 30,
    items: [{ productId, quantity: 2 }] });
  await ProductService.update(productId, shopId, { name: 'Renamed', sellPrice: 16 });
  await consistent(8, 1);
});
it('price-only import does not default quantity or overwrite stock sold since loading', async () => {
  await prisma.product.update({ where: { id: productId }, data: { barcode: productId } });
  const { value, error } = bulkImportSchema.validate({ updateExisting: true, products: [
    { barcode: productId, name: 'Imported name', costPrice: 6, sellPrice: 16 },
  ] });
  expect(error).toBeUndefined();
  expect(value.products[0]).not.toHaveProperty('quantity');
  await SaleService.create({ shopId, userId, paymentMethod: 'CASH', amountPaid: 30,
    items: [{ productId, quantity: 2 }] });
  expect(await ProductService.bulkImport(shopId, value.products, true)).toMatchObject({ updated: 1, errors: [] });
  await consistent(8, 1);
});
it('metadata bulk updates racing a sale preserve live stock', async () => {
  const results = await overlap([
    () => SaleService.create({ shopId, userId, paymentMethod: 'CASH', amountPaid: 30, items: [{ productId, quantity: 2 }] }),
    () => ProductService.bulkUpdate(shopId, [{ id: productId, sellPrice: 15 }]),
  ]);
  expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
  await consistent(8, 1);
});
it('rejects absolute quantities on every existing-product service path without partial metadata changes', async () => {
  const data = { name: 'Must not save', quantity: 99 };
  expect(updateProductSchema.validate(data).error).toBeDefined();
  expect(bulkUpdateSchema.validate({ updates: [{ id: productId, quantity: 99 }] }).error).toBeDefined();
  await expect(ProductService.update(productId, shopId, data)).rejects.toThrow('Stock Adjustments');
  await prisma.product.update({ where: { id: productId }, data: { barcode: productId } });
  expect(await ProductService.bulkImport(shopId, [{ ...data, barcode: productId, costPrice: 1, sellPrice: 1 }], true))
    .toMatchObject({ updated: 0, skipped: 1, errors: [{ row: 1, error: expect.stringContaining('Stock Adjustments') }] });
  expect(await ProductService.bulkUpdate(shopId, [{ id: productId, sellPrice: 1, quantity: 99 } as any]))
    .toMatchObject({ updated: 0, failed: 1, errors: [{ identifier: productId, error: expect.stringContaining('Stock Adjustments') }] });
  expect((await ProductService.getById(productId, shopId)).name).toBe('Stock');
  await consistent(10, 0);
});
it('intentional corrections through Stock Adjustments racing a sale retain both audited deltas', async () => {
  const results = await overlap([
    () => SaleService.create({ shopId, userId, paymentMethod: 'CASH', amountPaid: 30, items: [{ productId, quantity: 2 }] }),
    () => adjust(-3),
  ]);
  expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
  await consistent(5, 2);
  expect(await prisma.stockLog.findFirst({ where: { productId, type: 'ADJUSTMENT' } }))
    .toMatchObject({ quantity: -3, userId });
});
it('new products and new import rows retain initial stock with INITIAL logs', async () => {
  const created = await ProductService.create({ shopId, name: 'New', costPrice: 5, sellPrice: 15, quantity: 7 });
  expect(await prisma.stockLog.findFirst({ where: { productId: created.id } }))
    .toMatchObject({ type: 'INITIAL', quantity: 7, previousQty: 0, newQty: 7 });
  expect(await ProductService.bulkImport(shopId, [
    { barcode: 'new', name: 'Imported', costPrice: 5, sellPrice: 15, quantity: 4 },
    { barcode: 'zero', name: 'No initial stock', costPrice: 5, sellPrice: 15 },
    { barcode: '', name: 'No barcode one', costPrice: 5, sellPrice: 15 },
    { barcode: '', name: 'No barcode two', costPrice: 5, sellPrice: 15 },
  ], true)).toMatchObject({ created: 4, errors: [] });
  const imported = await prisma.product.findFirstOrThrow({ where: { shopId, barcode: 'new' } });
  expect(imported.quantity).toBe(4);
  expect(await prisma.stockLog.findFirst({ where: { productId: imported.id } }))
    .toMatchObject({ type: 'INITIAL', quantity: 4, previousQty: 0, newQty: 4 });
  expect((await prisma.product.findFirstOrThrow({ where: { shopId, barcode: 'zero' } })).quantity).toBe(0);
});

it('an attempted stale absolute count racing a sale is rejected clearly and cannot resurrect units', async () => {
  const staleCount = { quantity: 10, name: 'Stale count' };
  const results = await Promise.allSettled([
    SaleService.create({ shopId, userId, paymentMethod: 'CASH', amountPaid: 30, items: [{ productId, quantity: 2 }] }),
    ProductService.update(productId, shopId, staleCount),
  ]);
  expect(results[0].status).toBe('fulfilled');
  expect(results[1].status).toBe('rejected');
  expect((results[1] as PromiseRejectedResult).reason.message).toContain('Stock Adjustments');
  await consistent(8, 1);
});

it('a real counter write failure rolls back the complete receipt and permits one clean retry', async () => {
  const other = await prisma.product.create({ data: { shopId, name: 'Other', quantity: 20, costPrice: 6, sellPrice: 15 } });
  const input = { shopId, userId, items: [
    { productId, quantity: 3, costPrice: 9 }, { productId: other.id, quantity: 4, costPrice: 10 },
  ] };
  // Real PostgreSQL failure at the final counter UPDATE, after both inventory writes.
  await prisma.$executeRawUnsafe(`ALTER TABLE "Shop" ADD CONSTRAINT "stock_usage_failure" CHECK (id <> '${shopId}' OR "monthlyStockMoves" = 0)`);
  try {
    await expect(StockService.receive(input)).rejects.toThrow();
    await expect(adjust(3)).rejects.toThrow();
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "Shop" DROP CONSTRAINT "stock_usage_failure"');
  }
  await consistent(10, 0);
  expect(await prisma.product.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({ quantity: 20, costPrice: 6 });
  expect(await prisma.product.findUniqueOrThrow({ where: { id: productId } })).toMatchObject({ costPrice: 5 });
  expect((await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).monthlyStockMoves).toBe(0);
  await StockService.receive(input);
  await consistent(13, 1);
  expect((await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).monthlyStockMoves).toBe(2);
});
