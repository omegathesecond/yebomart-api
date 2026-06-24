/**
 * Tests for StockService.receive — the purpose-built restock path.
 *
 * Covered invariants (a regression here silently corrupts COGS/profit/margin):
 *   (a) receiving bumps quantity and writes a RESTOCK stock log with correct
 *       previousQty/newQty
 *   (b) when an item carries a new costPrice, Product.costPrice is UPDATED so
 *       every margin figure derived from cost stays accurate after a price change
 *   (c) when no costPrice is supplied, Product.costPrice is left untouched
 *   (d) a cost change is recorded in the stock-log note for audit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// incrementUsage is an out-of-band counter bump — not part of the receive
// invariants under test, so stub it.
vi.mock('./shop.service', () => ({
  ShopService: { incrementUsage: vi.fn().mockResolvedValue(undefined) },
}));

import { StockService } from './stock.service';
import { prismaFake, resetDb, seedShop, seedProduct, table } from '../test/prismaFake';

let shopId: string;

beforeEach(() => {
  resetDb();
  const shop = seedShop();
  shopId = shop.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StockService.receive — quantity + stock log', () => {
  it('increments quantity and writes a RESTOCK stock log', async () => {
    const product = seedProduct({ shopId, quantity: 10, costPrice: 5 });

    const result = await StockService.receive({
      shopId,
      items: [{ productId: product.id, quantity: 7 }],
    });

    expect(result[0].product.quantity).toBe(17);

    const logs = table('stockLog');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      type: 'RESTOCK',
      quantity: 7,
      previousQty: 10,
      newQty: 17,
    });
  });
});

describe('StockService.receive — cost price', () => {
  it('updates Product.costPrice when a new costPrice is supplied', async () => {
    const product = seedProduct({ shopId, quantity: 10, costPrice: 5, sellPrice: 10 });

    const result = await StockService.receive({
      shopId,
      items: [{ productId: product.id, quantity: 5, costPrice: 8 }],
    });

    // Returned + persisted product both carry the new cost.
    expect(result[0].product.costPrice).toBe(8);
    expect(table('product')[0].costPrice).toBe(8);
  });

  it('records the cost change in the stock-log note for audit', async () => {
    const product = seedProduct({ shopId, quantity: 10, costPrice: 5 });

    await StockService.receive({
      shopId,
      items: [{ productId: product.id, quantity: 5, costPrice: 8, note: 'Supplier delivery' }],
    });

    const note = table('stockLog')[0].note as string;
    expect(note).toContain('Supplier delivery');
    expect(note).toContain('5');
    expect(note).toContain('8');
  });

  it('leaves Product.costPrice untouched when no costPrice is supplied', async () => {
    const product = seedProduct({ shopId, quantity: 10, costPrice: 5 });

    await StockService.receive({
      shopId,
      items: [{ productId: product.id, quantity: 5 }],
    });

    expect(table('product')[0].costPrice).toBe(5);
    // No cost change → plain note, no audit annotation.
    expect(table('stockLog')[0].note).toBeUndefined();
  });

  it('does not annotate the note when costPrice equals the current cost', async () => {
    const product = seedProduct({ shopId, quantity: 10, costPrice: 5 });

    await StockService.receive({
      shopId,
      items: [{ productId: product.id, quantity: 5, costPrice: 5, note: 'Same cost' }],
    });

    expect(table('stockLog')[0].note).toBe('Same cost');
    expect(table('product')[0].costPrice).toBe(5);
  });
});
