/**
 * Tests for the money-critical createSale path.
 *
 * Covered invariants (a POS regression here costs real money):
 *   (a) stock is decremented by the sold qty + a SALE StockLog with correct
 *       previousQty/newQty is written
 *   (b) SaleItem snapshots unitPrice + costPrice (profit calc depends on this)
 *   (c) tax/total math is correct
 *   (d) OFFLINE IDEMPOTENCY: replaying the same localId creates exactly one
 *       Sale and decrements stock once (findFirst fast-path + the
 *       @@unique([shopId, localId]) P2002 catch backstop)
 *   (e) insufficient payment throws and writes nothing
 *   (f) selling more than available stock is rejected
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The `@config/prisma` import is redirected to the in-memory fake via the
// resolve.alias in vitest.config.ts. The fake enforces
// @@unique([shopId, localId]) with a real P2002 so the idempotency backstop
// runs against the genuine error type.

// incrementUsage is an out-of-band counter bump (its own prisma write) — not
// part of the sale invariants under test, so stub it.
vi.mock('./shop.service', () => ({
  ShopService: { incrementUsage: vi.fn().mockResolvedValue(undefined) },
}));

import { SaleService } from './sale.service';
import {
  prismaFake,
  resetDb,
  seedShop,
  seedProduct,
  seedCustomer,
  table,
} from '../test/prismaFake';

let shopId: string;

beforeEach(() => {
  resetDb();
  const shop = seedShop();
  shopId = shop.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Build a createSale input with sensible defaults. */
function saleInput(over: Record<string, any> = {}): any {
  return {
    shopId,
    paymentMethod: 'CASH',
    items: [],
    amountPaid: 0,
    ...over,
  };
}

describe('SaleService.create — stock + stock log', () => {
  it('decrements stock by the sold quantity and writes a SALE stock log', async () => {
    const product = seedProduct({ shopId, quantity: 100, sellPrice: 10, costPrice: 5 });

    const sale = await SaleService.create(
      saleInput({ items: [{ productId: product.id, quantity: 3 }], amountPaid: 30 })
    );

    const stored = table('product').find((p) => p.id === product.id);
    expect(stored!.quantity).toBe(97);

    const logs = table('stockLog');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      type: 'SALE',
      quantity: -3,
      previousQty: 100,
      newQty: 97,
      productId: product.id,
      reference: sale.id,
    });
  });

  it('does not touch stock or write a log for a non-tracked product', async () => {
    const product = seedProduct({ shopId, trackStock: false, quantity: 0, sellPrice: 10 });

    await SaleService.create(
      saleInput({ items: [{ productId: product.id, quantity: 4 }], amountPaid: 40 })
    );

    expect(table('product').find((p) => p.id === product.id)!.quantity).toBe(0);
    expect(table('stockLog')).toHaveLength(0);
  });
});

describe('SaleService.create — SaleItem snapshot', () => {
  it('snapshots unitPrice + costPrice at time of sale', async () => {
    const product = seedProduct({ shopId, name: 'Cola', sellPrice: 12, costPrice: 7, quantity: 50 });

    const sale = await SaleService.create(
      saleInput({ items: [{ productId: product.id, quantity: 2 }], amountPaid: 24 })
    );

    expect(sale.items).toHaveLength(1);
    expect(sale.items[0]).toMatchObject({
      productName: 'Cola',
      quantity: 2,
      unitPrice: 12, // snapshot of sellPrice
      costPrice: 7, // snapshot for profit calc
      totalPrice: 24,
    });
  });
});

describe('SaleService.create — tax/total math', () => {
  it('computes subtotal, applies order + line discounts, total and change', async () => {
    const product = seedProduct({ shopId, sellPrice: 10, costPrice: 5, quantity: 50 });

    // 2 units @10 = 20, less E4 line discount = 16 subtotal
    // less E1 order discount = 15 total; paid E20 -> change E5
    const sale = await SaleService.create(
      saleInput({
        items: [{ productId: product.id, quantity: 2, discount: 4 }],
        discount: 1,
        amountPaid: 20,
      })
    );

    expect(sale.subtotal).toBe(16);
    expect(sale.discount).toBe(1);
    expect(sale.tax).toBe(0); // VAT not configurable yet (see todos below)
    expect(sale.totalAmount).toBe(15);
    expect(sale.change).toBe(5);
    expect(sale.items[0].totalPrice).toBe(16);
  });

  // Coordinate with the VAT task: once Shop.tax(Rate/Inclusive) lands and
  // sale.service stops hardcoding `tax = 0`, fill these in.
  it.todo('charges exclusive VAT on top of the subtotal when tax is configured');
  it.todo('back-computes inclusive VAT out of the subtotal when prices are tax-inclusive');
});

describe('SaleService.create — offline idempotency', () => {
  it('replaying the same localId returns the original sale and decrements stock once', async () => {
    const product = seedProduct({ shopId, sellPrice: 10, quantity: 100 });
    const input = saleInput({
      items: [{ productId: product.id, quantity: 3 }],
      amountPaid: 30,
      localId: 'offline-abc',
    });

    const first = await SaleService.create({ ...input });
    const replay = await SaleService.create({ ...input });

    expect(replay.id).toBe(first.id); // same committed sale, not a new one
    expect(table('sale')).toHaveLength(1); // exactly one Sale
    expect(table('product').find((p) => p.id === product.id)!.quantity).toBe(97); // decremented once
    expect(table('stockLog')).toHaveLength(1); // logged once
  });

  it('falls back to the existing sale when the unique constraint fires (race backstop)', async () => {
    const product = seedProduct({ shopId, sellPrice: 10, quantity: 100 });
    const input = saleInput({
      items: [{ productId: product.id, quantity: 3 }],
      amountPaid: 30,
      localId: 'offline-race',
    });

    const first = await SaleService.create({ ...input });

    // Simulate the race window: the dedup findFirst MISSES (returns null), so
    // create() proceeds and hits the @@unique([shopId, localId]) P2002. The
    // catch backstop must recover by returning the already-committed sale.
    vi.spyOn(prismaFake.sale, 'findFirst').mockResolvedValueOnce(null);

    const replay = await SaleService.create({ ...input });

    expect(replay.id).toBe(first.id);
    expect(table('sale')).toHaveLength(1);
    expect(table('product').find((p) => p.id === product.id)!.quantity).toBe(97);
    expect(table('stockLog')).toHaveLength(1);
  });
});

describe('SaleService.create — credit ("on the book") sales', () => {
  it('books the full total to the customer ledger, sets amountPaid/change 0, and still decrements stock', async () => {
    const product = seedProduct({ shopId, sellPrice: 10, quantity: 100 });
    const customer = seedCustomer({ shopId, balance: 20, creditLimit: 0 });

    const sale = await SaleService.create(
      saleInput({
        items: [{ productId: product.id, quantity: 3 }], // total 30
        paymentMethod: 'CREDIT',
        amountPaid: 0,
        customerId: customer.id,
      })
    );

    // Pay-later: nothing tendered, no change.
    expect(sale.amountPaid).toBe(0);
    expect(sale.change).toBe(0);
    expect(sale.totalAmount).toBe(30);

    // A PURCHASE ledger entry linked to the sale.
    const credits = table('customerCredit');
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({
      type: 'PURCHASE',
      amount: 30,
      saleId: sale.id,
      customerId: customer.id,
      shopId,
    });

    // Balance increased by the total; new balance exposed on the sale for the receipt.
    expect(table('customer').find((c) => c.id === customer.id)!.balance).toBe(50); // 20 + 30
    expect((sale as any).customerBalance).toBe(50);

    // Stock still drawn down.
    expect(table('product').find((p) => p.id === product.id)!.quantity).toBe(97);
  });

  it('rejects a credit sale with no customer and writes nothing', async () => {
    const product = seedProduct({ shopId, sellPrice: 10, quantity: 100 });

    await expect(
      SaleService.create(
        saleInput({
          items: [{ productId: product.id, quantity: 1 }],
          paymentMethod: 'CREDIT',
          amountPaid: 0,
        })
      )
    ).rejects.toThrow(/customer is required for credit/i);

    expect(table('sale')).toHaveLength(0);
    expect(table('customerCredit')).toHaveLength(0);
    expect(table('product').find((p) => p.id === product.id)!.quantity).toBe(100);
  });

  it('rejects when the new balance would exceed the credit limit (and rolls back everything)', async () => {
    const product = seedProduct({ shopId, sellPrice: 10, quantity: 100 });
    const customer = seedCustomer({ shopId, balance: 80, creditLimit: 100 });

    // 3 × 10 = 30 → new balance 110 > limit 100.
    await expect(
      SaleService.create(
        saleInput({
          items: [{ productId: product.id, quantity: 3 }],
          paymentMethod: 'CREDIT',
          amountPaid: 0,
          customerId: customer.id,
        })
      )
    ).rejects.toThrow(/Credit limit exceeded/);

    expect(table('sale')).toHaveLength(0);
    expect(table('customerCredit')).toHaveLength(0);
    expect(table('customer').find((c) => c.id === customer.id)!.balance).toBe(80); // untouched
    expect(table('product').find((p) => p.id === product.id)!.quantity).toBe(100); // untouched
  });

  it('treats creditLimit 0 as "no limit" — allows the credit sale', async () => {
    const product = seedProduct({ shopId, sellPrice: 10, quantity: 100 });
    const customer = seedCustomer({ shopId, balance: 500, creditLimit: 0 });

    const sale = await SaleService.create(
      saleInput({
        items: [{ productId: product.id, quantity: 5 }], // total 50
        paymentMethod: 'CREDIT',
        amountPaid: 0,
        customerId: customer.id,
      })
    );

    expect(sale.totalAmount).toBe(50);
    expect(table('customer').find((c) => c.id === customer.id)!.balance).toBe(550);
  });
});

describe('SaleService.create — rejection paths write nothing', () => {
  it('rejects when amountPaid is less than the total and writes nothing', async () => {
    const product = seedProduct({ shopId, sellPrice: 10, quantity: 100 });

    await expect(
      SaleService.create(
        saleInput({ items: [{ productId: product.id, quantity: 3 }], amountPaid: 5 })
      )
    ).rejects.toThrow(/Insufficient payment/);

    expect(table('sale')).toHaveLength(0);
    expect(table('stockLog')).toHaveLength(0);
    expect(table('product').find((p) => p.id === product.id)!.quantity).toBe(100); // untouched
  });

  it('rejects selling more than available stock and writes nothing', async () => {
    const product = seedProduct({ shopId, sellPrice: 10, quantity: 2 });

    await expect(
      SaleService.create(
        saleInput({ items: [{ productId: product.id, quantity: 5 }], amountPaid: 1000 })
      )
    ).rejects.toThrow(/Insufficient stock/);

    expect(table('sale')).toHaveLength(0);
    expect(table('stockLog')).toHaveLength(0);
    expect(table('product').find((p) => p.id === product.id)!.quantity).toBe(2);
  });

  it('rejects when a product is missing/inactive', async () => {
    const product = seedProduct({ shopId, isActive: false, quantity: 100 });

    await expect(
      SaleService.create(
        saleInput({ items: [{ productId: product.id, quantity: 1 }], amountPaid: 100 })
      )
    ).rejects.toThrow(/not found/);

    expect(table('sale')).toHaveLength(0);
  });
});

describe('SaleService.create — concurrency hardening', () => {
  // Regression for the lost-update / oversell race: two cashiers (or online +
  // offline-sync) ring up the last unit at the same time. The atomic guarded
  // decrement (updateMany WHERE quantity >= qty) must let EXACTLY ONE through.
  // (The fake serializes $transaction callbacks, so this asserts the
  // serializable OUTCOME — never two sales, never negative stock.)
  it('two concurrent sales of a stock-1 product: exactly one succeeds, no oversell', async () => {
    const product = seedProduct({ shopId, sellPrice: 10, quantity: 1 });
    const ring = () =>
      SaleService.create(
        saleInput({ items: [{ productId: product.id, quantity: 1 }], amountPaid: 10 })
      );

    const results = await Promise.allSettled([ring(), ring()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1); // exactly one sale goes through
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/Insufficient stock/);

    // No oversell: stock floored at 0 (never negative), one Sale, one stock log.
    expect(table('product').find((p) => p.id === product.id)!.quantity).toBe(0);
    expect(table('sale')).toHaveLength(1);
    expect(table('stockLog')).toHaveLength(1);
  });

  // Regression for duplicate receipt numbers: receiptNumber is minted from a
  // per-shop daily count, so two concurrent sales can compute the same value.
  // We force that collision (both transactions' first count() returns 0 -> both
  // try RCP-...-0001); the @@unique([shopId, receiptNumber]) constraint turns
  // the loser's insert into a P2002, and the retry recomputes the count and
  // advances to 0002. Result: two sales, two DISTINCT receipt numbers.
  it('concurrent sales never mint duplicate receipt numbers (unique + retry)', async () => {
    const product = seedProduct({ shopId, sellPrice: 10, quantity: 10 });

    const countSpy = vi.spyOn(prismaFake.sale, 'count');
    countSpy.mockResolvedValueOnce(0).mockResolvedValueOnce(0); // both base off 0

    const ring = () =>
      SaleService.create(
        saleInput({ items: [{ productId: product.id, quantity: 1 }], amountPaid: 10 })
      );

    const [a, b] = await Promise.all([ring(), ring()]);

    expect(table('sale')).toHaveLength(2); // both committed
    const receipts = table('sale').map((s) => s.receiptNumber);
    expect(new Set(receipts).size).toBe(2); // no duplicates
    expect(a.receiptNumber).not.toBe(b.receiptNumber);
    // Both units sold from stock of 10, no double-decrement from the retry.
    expect(table('product').find((p) => p.id === product.id)!.quantity).toBe(8);
  });
});
