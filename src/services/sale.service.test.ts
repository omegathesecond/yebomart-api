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
import { ShopService } from './shop.service';
import { CustomerController } from '../controllers/customer.controller';
import {
  prismaFake,
  resetDb,
  seedShop,
  seedUser,
  seedProduct,
  seedCustomer,
  table,
} from '../test/prismaFake';

let shopId: string;

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
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

describe('SaleService.voidSale — atomic credit reversal', () => {
  async function booked(paymentMethod = 'CREDIT') {
    const product = seedProduct({ shopId, quantity: 10, sellPrice: 100 });
    const customer = seedCustomer({ shopId, balance: 20, creditLimit: 0 });
    const sale = await SaleService.create(saleInput({
      customerId: customer.id, paymentMethod,
      amountPaid: paymentMethod === 'CREDIT' ? 0 : 100,
      items: [{ productId: product.id, quantity: 1 }],
    }));
    return { product, customer, sale };
  }
  const voidSale = (id: string) => SaleService.voidSale(id, shopId, undefined, 'Mistake');

  it('appends a signed, sale-linked reversal without erasing existing repayments', async () => {
    const { sale, customer, product } = await booked();
    const purchase = table('customerCredit')[0];
    await prismaFake.customerCredit.create({ data: {
      shopId, customerId: customer.id, saleId: sale.id, type: 'PAYMENT', amount: 70,
    } });
    await prismaFake.customer.update({ where: { id: customer.id }, data: { balance: { increment: -70 } } });
    const result = await voidSale(sale.id);
    expect(result.status).toBe('VOIDED');
    expect(table('customer')[0].balance).toBe(-50); // 20 - 70: overpayment preserved
    expect(table('customerCredit')).toHaveLength(3);
    expect(table('customerCredit')[0]).toEqual(purchase);
    expect(table('customerCredit')[1]).toMatchObject({ type: 'PAYMENT', amount: 70 });
    expect(table('customerCredit')[2]).toMatchObject({
      type: 'ADJUSTMENT', amount: -100, saleId: sale.id, customerId: customer.id,
      note: expect.stringContaining(purchase.id),
    });
    expect(table('product').find(p => p.id === product.id)!.quantity).toBe(10);
    // Customers.tsx renders this endpoint's balance, signed amount and note.
    const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await CustomerController.getById({
      user: { shopId }, params: { id: customer.id },
    } as any, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data).toMatchObject({
      balance: -50,
      credits: expect.arrayContaining([expect.objectContaining({
        type: 'ADJUSTMENT', amount: -100, saleId: sale.id,
        note: expect.stringContaining('Mistake'),
      })]),
    });
  });

  it('allows only one concurrent/repeated void and one restoration/reversal', async () => {
    const { sale } = await booked();
    const results = await Promise.allSettled([voidSale(sale.id), voidSale(sale.id)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    await expect(voidSale(sale.id)).rejects.toThrow(/already voided/);
    expect(table('customer')[0].balance).toBe(20);
    expect(table('customerCredit')).toHaveLength(2);
    expect(table('stockLog').filter(l => l.type === 'RETURN')).toHaveLength(1);
    expect(table('product')[0].quantity).toBe(10);
  });

  it.each(['stockLog', 'customerCredit', 'customer'] as const)('rolls back all void writes if %s fails', async (model) => {
    const { sale } = await booked();
    vi.spyOn(prismaFake[model], model === 'customer' ? 'update' : 'create').mockRejectedValueOnce(new Error('Storage failed'));
    await expect(voidSale(sale.id)).rejects.toThrow('Storage failed');
    expect(table('sale')[0].status).toBe('COMPLETED');
    expect(table('customer')[0].balance).toBe(120);
    expect(table('customerCredit')).toHaveLength(1);
    expect(table('product')[0].quantity).toBe(9);
    expect(table('stockLog')).toHaveLength(1);
    await voidSale(sale.id);
    expect(table('customer')[0].balance).toBe(20);
  });

  it('restores a paid sale without touching customer credit', async () => {
    const { sale } = await booked('CASH');
    await voidSale(sale.id);
    expect(table('customer')[0].balance).toBe(20);
    expect(table('customerCredit')).toHaveLength(0);
    expect(table('product')[0].quantity).toBe(10);
  });

  it.each(['PENDING', 'APPROVED', 'COMPLETED'])('rejects a prior %s return', async (status) => {
    const { sale } = await booked();
    await prismaFake.return.create({ data: { shopId, saleId: sale.id, status } });
    await expect(voidSale(sale.id)).rejects.toThrow(/return/);
    expect(table('sale')[0].status).toBe('COMPLETED');
    expect(table('customer')[0].balance).toBe(120);
    expect(table('product')[0].quantity).toBe(9);
  });

  it.each(['REFUND', 'ADJUSTMENT'])('rejects a prior %s credit correction', async (type) => {
    const { sale, customer } = await booked();
    await prismaFake.customerCredit.create({ data: { shopId, saleId: sale.id, customerId: customer.id, type, amount: 10 } });
    await expect(voidSale(sale.id)).rejects.toThrow(/incompatible credit history/);
    expect(table('sale')[0].status).toBe('COMPLETED');
    expect(table('customerCredit')).toHaveLength(2);
  });

  it('increments current stock rather than overwriting an intervening sale', async () => {
    const { sale } = await booked();
    const update = prismaFake.product.update.bind(prismaFake.product);
    vi.spyOn(prismaFake.product, 'update').mockImplementationOnce(async (args: any) => {
      await update({ where: args.where, data: { quantity: { decrement: 2 } } });
      expect(args.data.quantity).toEqual({ increment: 1 });
      return update(args);
    });
    await voidSale(sale.id);
    expect(table('product')[0].quantity).toBe(8);
    expect(table('stockLog').find(l => l.type === 'RETURN')).toMatchObject({ previousQty: 7, newQty: 8 });
  });

  it('rejects missing purchase history and preserves the completed sale', async () => {
    const { sale } = await booked();
    vi.spyOn(prismaFake.customerCredit, 'findMany').mockResolvedValueOnce([]);
    await expect(voidSale(sale.id)).rejects.toThrow(/missing or incompatible/);
    expect(table('sale')[0].status).toBe('COMPLETED');
    expect(table('product')[0].quantity).toBe(9);
    expect(table('customer')[0].balance).toBe(120);
  });

  it('uses booked debt even when the sale total differs', async () => {
    const { sale } = await booked();
    await prismaFake.sale.update({ where: { id: sale.id }, data: { totalAmount: 999 } });
    await voidSale(sale.id);
    expect(table('customer')[0].balance).toBe(20);
    expect(table('customerCredit')[1].amount).toBe(-100);
  });
});


describe('SaleService.voidSale — rejected return processing history', () => {
  it.each([
    { processedAt: new Date(), restocked: false },
    { processedAt: null, restocked: true },
  ])('rejects previously processed/restocked REJECTED return: %j', async (history) => {
    const product = seedProduct({ shopId, quantity: 10, sellPrice: 100 });
    const customer = seedCustomer({ shopId });
    const sale = await SaleService.create(saleInput({ customerId: customer.id,
      paymentMethod: 'CREDIT', items: [{ productId: product.id, quantity: 1 }],
    }));
    await prismaFake.return.create({ data: { shopId, saleId: sale.id,
      status: 'REJECTED', processedAt: history.processedAt,
      items: { create: [{ productId: product.id, restocked: history.restocked }] },
    } });
    await expect(SaleService.voidSale(sale.id, shopId, undefined, 'Cancel')).rejects.toThrow(/return/);
    expect(table('sale')[0].status).toBe('COMPLETED');
    expect(table('product')[0].quantity).toBe(9);
    expect(table('customer')[0].balance).toBe(100);
    expect(table('customerCredit')).toHaveLength(1);
    expect(table('stockLog')).toHaveLength(1);
  });
});

describe('SaleService.create — authoritative discount bounds', () => {
  const snapshot = () => structuredClone(Object.fromEntries(
    ['sale', 'saleItem', 'product', 'stockLog', 'customer', 'customerCredit', 'shop'].map(name => [name, table(name as any)]),
  ));

  it.each(['CASH', 'CREDIT'])('rejects excess discounts before any writes (%s)', async paymentMethod => {
    const product = seedProduct({ shopId, quantity: 20, sellPrice: 10 });
    const other = seedProduct({ shopId, quantity: 20, sellPrice: 100 });
    const customer = seedCustomer({ shopId, balance: 30 });
    for (const [line, cart] of [[100, 0], [20.01, 0], [0, 120.01], [4, 116.01], [20, 100.01]]) {
      const before = snapshot();
      await expect(SaleService.create(saleInput({ paymentMethod, customerId: customer.id,
        amountPaid: 0, discount: cart,
        items: [{ productId: product.id, quantity: 2, discount: line }, { productId: other.id, quantity: 1 }],
      }))).rejects.toThrow(/discount.*cannot exceed/i);
      expect(snapshot()).toEqual(before);
    }
  });

  it.each([false, true])('persists reconciled zero, full and boundary discounts; inclusive=%s', async taxInclusive => {
    await prismaFake.shop.update({ where: { id: shopId }, data: { taxRate: 15, taxInclusive } });
    const product = seedProduct({ shopId, sellPrice: 10, quantity: 100 });
    for (const [line, cart, base] of [[0, 0, 20], [20, 0, 0], [0, 20, 0], [4, 16, 0], [4, 15.99, 0.01], [4, 6, 10]]) {
      const sale = await SaleService.create(saleInput({ amountPaid: 100, discount: cart,
        items: [{ productId: product.id, quantity: 2, discount: line }],
      }));
      const stored = table('sale').find(s => s.id === sale.id)!;
      const items = table('saleItem').filter(i => i.saleId === sale.id);
      expect(items[0]).toMatchObject({ unitPrice: 10, quantity: 2, discount: line, totalPrice: 20 - line });
      expect(stored.subtotal).toBe(items.reduce((sum, item) => sum + item.totalPrice, 0));
      expect(stored.discount).toBe(cart);
      const expectedTax = Math.round(base * 15 / (taxInclusive ? 115 : 100) * 100) / 100;
      expect(stored.tax).toBe(expectedTax);
      expect(stored.totalAmount).toBe(Math.round((base + (taxInclusive ? 0 : expectedTax)) * 100) / 100);
    }
  });

  it('accepts decimal full discounts without binary floating point underflow', async () => {
    const product = seedProduct({ shopId, sellPrice: 0.3, quantity: 10 });
    const sale = await SaleService.create(saleInput({
      items: [{ productId: product.id, quantity: 3, discount: 0.9 }],
    }));
    expect(sale.items[0].totalPrice).toBe(0);
    expect(sale.subtotal).toBe(0);
    expect(sale.totalAmount).toBe(0);
  });
});


describe('SaleService.create — current discount permission', () => {
  it.each([
    { discount: 1, itemsDiscount: 0 },
    { discount: 0, itemsDiscount: 1 },
  ])('denies unauthorized discounts without any writes: %j', async ({ discount, itemsDiscount }) => {
    const staff = seedUser({ shopId, canDiscount: false });
    const product = seedProduct({ shopId, sellPrice: 10, quantity: 10 });
    const customer = seedCustomer({ shopId });
    const before = JSON.stringify(['sale', 'saleItem', 'product', 'stockLog', 'customer', 'customerCredit', 'shop'].map(table));
    await expect(SaleService.create(saleInput({ userId: staff.id, customerId: customer.id,
      paymentMethod: 'CREDIT', discount,
      items: [{ productId: product.id, quantity: 1, discount: itemsDiscount }],
    }))).rejects.toThrow('You do not have permission to apply discounts');
    expect(JSON.stringify(['sale', 'saleItem', 'product', 'stockLog', 'customer', 'customerCredit', 'shop'].map(table))).toBe(before);
    expect(ShopService.incrementUsage).not.toHaveBeenCalled();
  });

  it.each(['OWNER', 'MANAGER', 'CASHIER'])('allows current %s permission and rejects revocation after login', async role => {
    const staff = seedUser({ shopId, role, canDiscount: role === 'CASHIER' });
    const product = seedProduct({ shopId, sellPrice: 10, quantity: 10 });
    const input = saleInput({ userId: staff.id, amountPaid: 10, localId: 'discount-sale', discount: 1,
      items: [{ productId: product.id, quantity: 1, discount: 1 }],
    });
    const sale = await SaleService.create(input);
    await prismaFake.user.update({ where: { id: staff.id }, data: { role: 'CASHIER', canDiscount: false } });
    expect((await SaleService.create(input)).id).toBe(sale.id);
    expect(table('stockLog')).toHaveLength(1);
    await expect(SaleService.create({ ...input, localId: 'new-sale' })).rejects.toThrow(/permission/);
    await SaleService.create({ ...input, localId: 'zero-sale', discount: 0,
      items: [{ productId: product.id, quantity: 1, discount: 0 }] });
    expect(table('sale')).toHaveLength(2);
  });

  it('rejects staff from another shop or inactive staff', async () => {
    const product = seedProduct({ shopId, sellPrice: 10 });
    for (const staff of [seedUser({ shopId: 'other', role: 'MANAGER' }), seedUser({ shopId, isActive: false, canDiscount: true })]) {
      await expect(SaleService.create(saleInput({ userId: staff.id, discount: 1, amountPaid: 10,
        items: [{ productId: product.id, quantity: 1 }],
      }))).rejects.toThrow(/permission/);
    }
  });
});
