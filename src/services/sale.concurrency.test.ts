/**
 * Concurrency regression tests for sale creation, against a REAL Postgres
 * (these races are meaningless against a serial in-memory fake — only a real DB
 * with real transactions + a real unique index can exercise them).
 *
 * WHAT IS GUARANTEED TODAY (and asserted here): the offline-sync replay race.
 * A flaky link makes the POS replay the same queued sale (same client localId)
 * possibly concurrently. The @@unique([shopId, localId]) index + the P2002
 * catch in SaleService.create must collapse N concurrent replays into exactly
 * ONE committed sale, decrementing stock exactly once — never double-charging
 * the customer or double-depleting stock.
 *
 * WHAT IS NOT YET GUARANTEED (tracked by the separate "Harden sale creation"
 * bug task): two DISTINCT concurrent sales of the same product read stock
 * before either writes, so they can oversell; and the count-based receipt
 * number can collide under concurrency. Those are captured as it.todo below so
 * the gap is explicit — once the hardening lands (row lock / atomic conditional
 * decrement / unique receipt index), turn them into real assertions HERE.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SaleService } from './sale.service';
import { prisma, resetDb } from '../test/db';
import { seedShop, seedProduct } from '../test/factories';

let shopId: string;

beforeEach(async () => {
  await resetDb();
  const shop = await seedShop();
  shopId = shop.id;
});

describe('SaleService.create — concurrent offline replays (idempotency race)', () => {
  it('collapses N concurrent same-localId replays into ONE sale, stock decremented once', async () => {
    const product = await seedProduct(shopId, { sellPrice: 10, quantity: 100 });
    const input = {
      shopId,
      paymentMethod: 'CASH' as const,
      items: [{ productId: product.id, quantity: 3 }],
      amountPaid: 30,
      localId: 'offline-race-1',
    };

    // Fire 10 replays simultaneously — exactly what a reconnecting device's
    // retry storm looks like. The DB unique index is the only thing standing
    // between this and a 10x overcharge.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => SaleService.create({ ...input })),
    );

    // Every caller gets the SAME committed sale id back (no duplicates).
    const ids = new Set(results.map((s) => s.id));
    expect(ids.size).toBe(1);

    // Exactly one Sale row, one stock log, decremented exactly once.
    const sales = await prisma.sale.findMany({ where: { shopId } });
    expect(sales).toHaveLength(1);
    expect(sales[0].receiptNumber).toBeTruthy();

    const stored = await prisma.product.findUnique({ where: { id: product.id } });
    expect(stored!.quantity).toBe(97); // 100 - 3, once

    const logs = await prisma.stockLog.findMany({ where: { shopId } });
    expect(logs).toHaveLength(1);
  });

  // --- Owned by the "Harden sale creation" bug task (do NOT weaken prod here) ---
  // The current read-then-write decrement is not safe against two DISTINCT
  // concurrent sales of the same product; receipt numbers are count-based and
  // can collide. Promote these to real assertions once the hardening lands.
  it.todo(
    'two distinct concurrent sales of the same product never oversell (needs row lock / atomic decrement)',
  );
  it.todo('concurrent distinct sales never share a receipt number (needs unique receipt index)');
});
