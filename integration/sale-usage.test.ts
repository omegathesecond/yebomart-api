import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { race } from './lockedRace';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { SaleService } from '../src/services/sale.service';

let shopId: string, userId: string, productId: string;
const shops: string[] = [];
let failCounterFor: string | undefined;
// Inject precisely the counter-write failure, leaving all sale/stock writes real.
prisma.$use(async (params, next) => {
  if (params.model === 'Shop' && params.action === 'update' &&
      params.args.where.id === failCounterFor && params.args.data.monthlyTransactions) {
    throw new Error('injected counter-write failure');
  }
  return next(params);
});
beforeEach(async () => {
  failCounterFor = undefined;
  shopId = (await prisma.shop.create({ data: {
    name: 'Usage test', ownerName: 'Test', ownerPhone: randomUUID(), ownerYeboidSub: randomUUID(),
  } })).id;
  shops.push(shopId);
  userId = (await prisma.user.create({ data: { shopId, name: 'Test', phone: randomUUID(), role: 'OWNER' } })).id;
  productId = (await prisma.product.create({ data: { shopId, name: 'Stock', quantity: 10, costPrice: 5, sellPrice: 10 } })).id;
});
afterAll(async () => {
  failCounterFor = undefined;
  for (const id of shops) {
    await prisma.saleItem.deleteMany({ where: { sale: { shopId: id } } });
    await prisma.stockLog.deleteMany({ where: { shopId: id } });
    await prisma.sale.deleteMany({ where: { shopId: id } });
    await prisma.shop.delete({ where: { id } });
  }
  await prisma.$disconnect();
});
const input = () => ({ shopId, userId, localId: randomUUID(), paymentMethod: 'CASH' as const,
  amountPaid: 10, items: [{ productId, quantity: 1 }] });
async function state(count: number, stock: number, usage = count) {
  expect((await prisma.shop.findUniqueOrThrow({ where: { id: shopId } })).monthlyTransactions).toBe(usage);
  expect(await prisma.sale.count({ where: { shopId } })).toBe(count);
  expect(await prisma.saleItem.count({ where: { sale: { shopId } } })).toBe(count);
  expect(await prisma.stockLog.count({ where: { shopId } })).toBe(count);
  expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).quantity).toBe(stock);
}
it('counts a newly committed sale once and leaves rejected sales uncounted', async () => {
  await expect(SaleService.create({ ...input(), amountPaid: 0 })).rejects.toThrow();
  await state(0, 10);
  await SaleService.create(input());
  await state(1, 9);
});
it('concurrent and repeated localId requests return one sale and one usage increment', async () => {
  const request = input();
  const settled = await race(Prisma.sql`SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE`,
    [() => SaleService.create(request), () => SaleService.create(request)]);
  expect(settled.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
  const results = settled.map(result => (result as PromiseFulfilledResult<Awaited<ReturnType<typeof SaleService.create>>>).value);
  expect(results[0].id).toBe(results[1].id);
  expect((await SaleService.create(request)).id).toBe(results[0].id);
  await state(1, 9);
});
it('counter failure returns the committed sale and replay never duplicates it', async () => {
  const request = input();
  failCounterFor = shopId;
  const sale = await SaleService.create(request);
  await state(1, 9, 0);
  failCounterFor = undefined;
  expect((await SaleService.create(request)).id).toBe(sale.id);
  await state(1, 9, 0);
});

it('does not count a transaction rolled back after its stock update', async () => {
  // Invalid staff FK fails the sale insert after the real stock update.
  await expect(SaleService.create({ ...input(), userId: randomUUID() })).rejects.toThrow();
  await state(0, 10);
});
