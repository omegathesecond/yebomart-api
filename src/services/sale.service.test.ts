/**
 * SaleService.create — the money-critical checkout path, against a REAL Postgres.
 *
 * Covered invariants (a POS regression here costs real money):
 *   (a) subtotal/line+order discount/tax/total/change math is correct
 *   (b) stock is decremented by the sold qty and a SALE StockLog with correct
 *       previousQty/newQty is written — inside the same prisma.$transaction
 *   (c) SaleItem snapshots unitPrice + costPrice (profit calc depends on this)
 *   (d) VAT is recomputed server-side from the shop config (exclusive + inclusive)
 *   (e) OFFLINE IDEMPOTENCY: replaying the same localId creates exactly one Sale
 *       and decrements stock once (findFirst fast-path + the
 *       @@unique([shopId, localId]) P2002 backstop — a real DB constraint here)
 *   (f) insufficient payment / insufficient stock / missing product are rejected
 *       and the transaction rolls back so NOTHING is written
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

const productsInShop = () => prisma.product.findMany({ where: { shopId } });
const stockLogsInShop = () => prisma.stockLog.findMany({ where: { shopId } });
const salesInShop = () => prisma.sale.findMany({ where: { shopId } });

describe('SaleService.create — stock + stock log', () => {
  it('decrements stock by the sold quantity and writes a SALE stock log atomically', async () => {
    const product = await seedProduct(shopId, { quantity: 100, sellPrice: 10, costPrice: 5 });

    const sale = await SaleService.create(
      saleInput({ items: [{ productId: product.id, quantity: 3 }], amountPaid: 30 }),
    );

    const stored = await prisma.product.findUnique({ where: { id: product.id } });
    expect(stored!.quantity).toBe(97);

    const logs = await stockLogsInShop();
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
    const product = await seedProduct(shopId, { trackStock: false, quantity: 0, sellPrice: 10 });

    await SaleService.create(
      saleInput({ items: [{ productId: product.id, quantity: 4 }], amountPaid: 40 }),
    );

    const stored = await prisma.product.findUnique({ where: { id: product.id } });
    expect(stored!.quantity).toBe(0);
    expect(await stockLogsInShop()).toHaveLength(0);
  });
});

describe('SaleService.create — SaleItem snapshot', () => {
  it('snapshots unitPrice + costPrice at time of sale', async () => {
    const product = await seedProduct(shopId, {
      name: 'Cola',
      sellPrice: 12,
      costPrice: 7,
      quantity: 50,
    });

    const sale = await SaleService.create(
      saleInput({ items: [{ productId: product.id, quantity: 2 }], amountPaid: 24 }),
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

describe('SaleService.create — totals math', () => {
  it('computes subtotal, applies line + order discounts, total and change', async () => {
    const product = await seedProduct(shopId, { sellPrice: 10, costPrice: 5, quantity: 50 });

    // 2 units @10 = 20, less E4 line discount = 16 subtotal
    // less E1 order discount = 15 total; paid E20 -> change E5
    const sale = await SaleService.create(
      saleInput({
        items: [{ productId: product.id, quantity: 2, discount: 4 }],
        discount: 1,
        amountPaid: 20,
      }),
    );

    expect(sale.subtotal).toBe(16);
    expect(sale.discount).toBe(1);
    expect(sale.tax).toBe(0); // shop taxRate 0
    expect(sale.totalAmount).toBe(15);
    expect(sale.change).toBe(5);
    expect(sale.items[0].totalPrice).toBe(16);
  });

  it('charges EXCLUSIVE VAT on top of the (discounted) subtotal', async () => {
    // 15% VAT added on top. 1 unit @100, no discount: tax = 15, total = 115.
    await prisma.shop.update({
      where: { id: shopId },
      data: { taxRate: 15, taxInclusive: false },
    });
    const product = await seedProduct(shopId, { sellPrice: 100, costPrice: 50, quantity: 10 });

    const sale = await SaleService.create(
      saleInput({ items: [{ productId: product.id, quantity: 1 }], amountPaid: 115 }),
    );

    expect(sale.subtotal).toBe(100);
    expect(sale.tax).toBe(15);
    expect(sale.totalAmount).toBe(115);
    expect(sale.change).toBe(0);
  });

  it('back-computes INCLUSIVE VAT out of the subtotal (total unchanged)', async () => {
    // 15% inclusive: a E115 price already contains E15 VAT; total stays 115.
    await prisma.shop.update({
      where: { id: shopId },
      data: { taxRate: 15, taxInclusive: true },
    });
    const product = await seedProduct(shopId, { sellPrice: 115, costPrice: 50, quantity: 10 });

    const sale = await SaleService.create(
      saleInput({ items: [{ productId: product.id, quantity: 1 }], amountPaid: 115 }),
    );

    expect(sale.subtotal).toBe(115);
    expect(sale.tax).toBe(15); // 115 * 15 / 115
    expect(sale.totalAmount).toBe(115);
  });

  it('rounds VAT to 2 decimals (no floating-point cruft persisted)', async () => {
    await prisma.shop.update({
      where: { id: shopId },
      data: { taxRate: 15, taxInclusive: false },
    });
    const product = await seedProduct(shopId, { sellPrice: 9.99, costPrice: 4, quantity: 10 });

    const sale = await SaleService.create(
      saleInput({ items: [{ productId: product.id, quantity: 1 }], amountPaid: 100 }),
    );

    // 9.99 * 0.15 = 1.4985 -> 1.5 ; total 9.99 + 1.5 = 11.49
    expect(sale.tax).toBe(1.5);
    expect(sale.totalAmount).toBe(11.49);
  });
});

describe('SaleService.create — offline idempotency (real @@unique constraint)', () => {
  it('replaying the same localId returns the original sale and decrements stock once', async () => {
    const product = await seedProduct(shopId, { sellPrice: 10, quantity: 100 });
    const input = saleInput({
      items: [{ productId: product.id, quantity: 3 }],
      amountPaid: 30,
      localId: 'offline-abc',
    });

    const first = await SaleService.create({ ...input });
    const replay = await SaleService.create({ ...input });

    expect(replay.id).toBe(first.id); // same committed sale, not a new one
    expect(await salesInShop()).toHaveLength(1); // exactly one Sale
    const stored = await prisma.product.findUnique({ where: { id: product.id } });
    expect(stored!.quantity).toBe(97); // decremented once
    expect(await stockLogsInShop()).toHaveLength(1); // logged once
  });
});

describe('SaleService.create — rejection paths write nothing (transaction rollback)', () => {
  it('rejects when amountPaid is less than the total and writes nothing', async () => {
    const product = await seedProduct(shopId, { sellPrice: 10, quantity: 100 });

    await expect(
      SaleService.create(
        saleInput({ items: [{ productId: product.id, quantity: 3 }], amountPaid: 5 }),
      ),
    ).rejects.toThrow(/Insufficient payment/);

    expect(await salesInShop()).toHaveLength(0);
    expect(await stockLogsInShop()).toHaveLength(0);
    const stored = await prisma.product.findUnique({ where: { id: product.id } });
    expect(stored!.quantity).toBe(100); // untouched
  });

  it('rejects selling more than available stock and writes nothing', async () => {
    const product = await seedProduct(shopId, { sellPrice: 10, quantity: 2 });

    await expect(
      SaleService.create(
        saleInput({ items: [{ productId: product.id, quantity: 5 }], amountPaid: 1000 }),
      ),
    ).rejects.toThrow(/Insufficient stock/);

    expect(await salesInShop()).toHaveLength(0);
    expect(await stockLogsInShop()).toHaveLength(0);
    const stored = await prisma.product.findUnique({ where: { id: product.id } });
    expect(stored!.quantity).toBe(2);
  });

  it('rejects when a product is missing/inactive', async () => {
    const product = await seedProduct(shopId, { isActive: false, quantity: 100 });

    await expect(
      SaleService.create(
        saleInput({ items: [{ productId: product.id, quantity: 1 }], amountPaid: 100 }),
      ),
    ).rejects.toThrow(/not found/);

    expect(await salesInShop()).toHaveLength(0);
  });
});

describe('SaleService.create — usage counter', () => {
  it('increments the shop monthlyTransactions counter on a committed sale', async () => {
    const product = await seedProduct(shopId, { sellPrice: 10, quantity: 100 });

    await SaleService.create(
      saleInput({ items: [{ productId: product.id, quantity: 1 }], amountPaid: 10 }),
    );

    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    expect(shop!.monthlyTransactions).toBe(1);
  });
});
