import { expect } from 'vitest';
import { prisma } from '../src/config/prisma';

// Follow movements rather than timestamps: concurrent transactions can start
// in a different order than they acquire the product lock.
export async function expectStockHistory(id: string, expected: number, count: number, initial = 10) {
  expect((await prisma.product.findUniqueOrThrow({ where: { id } })).quantity).toBe(expected);
  const logs = await prisma.stockLog.findMany({ where: { productId: id } });
  expect(logs).toHaveLength(count);
  expect(initial + logs.reduce((sum, log) => sum + log.quantity, 0)).toBe(expected);
  let current = initial;
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
