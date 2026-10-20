/**
 * Tests for ReturnController.create — the input-trust / cross-shop invariants.
 *
 * Before this change, create() wrote saleId, customerId, line unitPrice/quantity
 * and even refundAmount straight from the request body with NO validation. A
 * cashier could:
 *   - reference ANOTHER shop's sale id (cross-shop / IDOR),
 *   - reference a customer that isn't in their shop,
 *   - return items that were never on the sale, or more than were sold,
 *   - inflate the refund by sending an arbitrary refundAmount / unitPrice.
 *
 * These tests pin the fix: the referenced sale/customer must belong to the
 * caller's shop, returned items must be lines on that sale (capped at sold qty),
 * prices come from the sale snapshot, and the refund is always derived
 * server-side from the validated lines (the body refundAmount is ignored).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SaleService } from '../services/sale.service';
import { ReturnController } from './return.controller';
import {
  resetDb,
  seedShop,
  seedSale,
  seedCustomer,
  seedProduct,
  table,
} from '../test/prismaFake';

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: any) => {
    res.body = body;
    return res;
  };
  res.send = () => res;
  return res;
}

function req(body: Record<string, any>): any {
  return {
    user: { id: 'user_1', shopId: 'shop_1', role: 'CASHIER', type: 'user' },
    body,
  };
}

beforeEach(() => {
  resetDb();
  seedShop({ ownerYeboidSub: '11111111-1111-1111-1111-111111111111' });
  seedProduct({ id: 'prod_widget' });
});

// Seed a sale in shop_1 with a single line: 5 x Widget @ 10.
function seedShopSale(overrides: Record<string, any> = {}) {
  return seedSale({
    shopId: 'shop_1',
    subtotal: 50,
    totalAmount: 50,
    items: [
      {
        productId: 'prod_widget',
        productName: 'Widget',
        quantity: 5,
        unitPrice: 10,
        costPrice: 5,
        totalPrice: 50,
      },
    ],
    ...overrides,
  });
}

describe('ReturnController.create — shop-scoping & input trust', () => {
  it('rejects a saleId that belongs to another shop (cross-shop reference)', async () => {
    const otherShopSale = seedSale({
      shopId: 'shop_other',
      items: [
        {
          productId: 'prod_widget',
          productName: 'Widget',
          quantity: 5,
          unitPrice: 10,
          costPrice: 5,
          totalPrice: 50,
        },
      ],
    });

    const res = mockRes();
    await ReturnController.create(
      req({
        saleId: otherShopSale.id,
        reason: 'Change of mind',
        type: 'REFUND',
        items: [
          {
            productId: 'prod_widget',
            productName: 'Widget',
            quantity: 1,
            unitPrice: 10,
          },
        ],
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(table('return')).toHaveLength(0);
  });

  it('rejects a returned item that was not on the sale', async () => {
    const sale = seedShopSale();

    const res = mockRes();
    await ReturnController.create(
      req({
        saleId: sale.id,
        reason: 'Defective',
        type: 'REFUND',
        items: [
          {
            productId: 'prod_not_sold',
            productName: 'Gizmo',
            quantity: 1,
            unitPrice: 10,
          },
        ],
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(table('return')).toHaveLength(0);
  });

  it('rejects returning more than was sold', async () => {
    const sale = seedShopSale(); // 5 sold

    const res = mockRes();
    await ReturnController.create(
      req({
        saleId: sale.id,
        reason: 'Defective',
        type: 'REFUND',
        items: [
          {
            productId: 'prod_widget',
            productName: 'Widget',
            quantity: 6,
            unitPrice: 10,
          },
        ],
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(table('return')).toHaveLength(0);
  });

  it('rejects duplicate lines that collectively exceed the sold quantity', async () => {
    const sale = seedShopSale(); // 5 sold

    const res = mockRes();
    await ReturnController.create(
      req({
        saleId: sale.id,
        reason: 'Defective',
        type: 'REFUND',
        items: [
          {
            productId: 'prod_widget',
            productName: 'Widget',
            quantity: 3,
            unitPrice: 10,
          },
          {
            productId: 'prod_widget',
            productName: 'Widget',
            quantity: 3,
            unitPrice: 10,
          },
        ],
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(table('return')).toHaveLength(0);
  });

  it('rejects a customerId that is not in the caller shop', async () => {
    const sale = seedShopSale();
    const otherCustomer = seedCustomer({
      shopId: 'shop_other',
      name: 'Outsider',
    });

    const res = mockRes();
    await ReturnController.create(
      req({
        saleId: sale.id,
        customerId: otherCustomer.id,
        reason: 'Defective',
        type: 'REFUND',
        items: [
          {
            productId: 'prod_widget',
            productName: 'Widget',
            quantity: 1,
            unitPrice: 10,
          },
        ],
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(table('return')).toHaveLength(0);
  });

  it('ignores client refundAmount/unitPrice and derives the refund from the sale price', async () => {
    const sale = seedShopSale(); // Widget @ 10

    const res = mockRes();
    await ReturnController.create(
      req({
        saleId: sale.id,
        reason: 'Defective',
        type: 'REFUND',
        // Attacker inflates both the per-line price and the total refund.
        refundAmount: 9999,
        items: [
          {
            productId: 'prod_widget',
            productName: 'Widget',
            quantity: 2,
            unitPrice: 9999,
          },
        ],
      }),
      res,
    );

    expect(res.statusCode).toBe(201);
    const created = res.body.data;
    expect(created.refundAmount).toBe(20); // 2 x sale price 10, NOT 9999
    expect(created.items[0].unitPrice).toBe(10); // snapshot from the sale
    expect(table('return')).toHaveLength(1);
  });

  it('creates a valid return scoped to the caller shop with a matching customer', async () => {
    const sale = seedShopSale();
    const customer = seedCustomer({ shopId: 'shop_1', name: 'Regular' });

    const res = mockRes();
    await ReturnController.create(
      req({
        saleId: sale.id,
        customerId: customer.id,
        reason: 'Change of mind',
        type: 'REFUND',
        items: [
          {
            productId: 'prod_widget',
            productName: 'Widget',
            quantity: 1,
            unitPrice: 10,
          },
        ],
      }),
      res,
    );

    expect(res.statusCode).toBe(201);
    const created = res.body.data;
    expect(created.shopId).toBe('shop_1');
    expect(created.saleId).toBe(sale.id);
    expect(created.customerId).toBe(customer.id);
    expect(created.refundAmount).toBe(10);
    expect(created.status).toBe('PENDING');
  });

  it('does not book a refund for non-REFUND types even when lines have value', async () => {
    const sale = seedShopSale();

    const res = mockRes();
    await ReturnController.create(
      req({
        saleId: sale.id,
        reason: 'Wrong size',
        type: 'EXCHANGE',
        items: [
          {
            productId: 'prod_widget',
            productName: 'Widget',
            quantity: 1,
            unitPrice: 10,
          },
        ],
      }),
      res,
    );

    expect(res.statusCode).toBe(201);
    expect(res.body.data.refundAmount).toBe(0);
  });

  it('allows a receiptless return (no saleId) and derives refund from the lines', async () => {
    const res = mockRes();
    await ReturnController.create(
      req({
        reason: 'No receipt return',
        type: 'REFUND',
        refundAmount: 9999, // still ignored
        items: [
          {
            productId: 'prod_widget',
            productName: 'Widget',
            quantity: 2,
            unitPrice: 10,
          },
        ],
      }),
      res,
    );

    expect(res.statusCode).toBe(201);
    expect(res.body.data.refundAmount).toBe(20); // derived from lines, not 9999
  });
});

describe('cumulative sale entitlement', () => {
  function body(saleId: string, quantity: number, extra: any = {}) {
    return {
      saleId,
      reason: 'Change of mind',
      type: 'REFUND',
      items: [
        {
          productId: 'prod_widget',
          productName: 'Widget',
          quantity,
          unitPrice: 999,
        },
      ],
      ...extra,
    };
  }
  async function create(saleId: string, quantity: number, extra: any = {}) {
    const res = mockRes();
    await ReturnController.create(req(body(saleId, quantity, extra)), res);
    return res;
  }
  async function process(id: string, action: string) {
    const res = mockRes();
    await ReturnController.process({ ...req({ action }), params: { id } }, res);
    return res;
  }
  it('reserves pending quantities, rejects sequential over-return, and releases rejected reservations', async () => {
    const sale = seedShopSale();
    const first = await create(sale.id, 4);
    expect(first.statusCode).toBe(201);
    expect((await create(sale.id, 2)).statusCode).toBe(400);
    expect((await process(first.body.data.id, 'reject')).statusCode).toBe(200);
    expect((await create(sale.id, 5)).body.data.refundAmount).toBe(50);
    expect(table('stockLog')).toHaveLength(0);
  });
  it('does not release historical processed returns whose status was changed to rejected', async () => {
    const sale = seedShopSale();
    const created = await create(sale.id, 5);
    expect((await process(created.body.data.id, 'complete')).statusCode).toBe(200);
    table('return')[0].status = 'REJECTED';
    expect((await create(sale.id, 1)).statusCode).toBe(400);
    expect(table('return')).toHaveLength(1);
    expect(table('stockLog')).toHaveLength(1);
  });
  it('concurrent full-sale reservations cannot both succeed (serialized transaction fake)', async () => {
    const sale = seedShopSale();
    const results = await Promise.all([create(sale.id, 5), create(sale.id, 5)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 400]);
    expect(table('return')).toHaveLength(1);
    expect(table('stockLog')).toHaveLength(0);
  });
  it('aggregates duplicate request lines and duplicate sale lines at different prices', async () => {
    const sale = seedShopSale({
      totalAmount: 25,
      items: [
        {
          productId: 'prod_widget',
          productName: 'Widget',
          quantity: 1,
          unitPrice: 10,
          totalPrice: 10,
        },
        {
          productId: 'prod_widget',
          productName: 'Widget',
          quantity: 1,
          unitPrice: 20,
          totalPrice: 20,
        },
      ],
    });
    const line = body(sale.id, 1).items[0];
    const result = await create(sale.id, 1, { items: [line, line] });
    expect(result.body.data.refundAmount).toBe(25);
    expect(result.body.data.items).toHaveLength(1);
    expect((await create(sale.id, 1)).statusCode).toBe(400);
  });
  it.each([10, 11.5, 0.01, 0])(
    'partial discounted/taxed returns exhaust exactly %s charged',
    async (totalAmount) => {
      const sale = seedShopSale({
        totalAmount,
        discount: 40,
        tax: totalAmount === 11.5 ? 1.5 : 0,
      });
      let sum = 0;
      for (let i = 0; i < 5; i++) {
        const result = await create(sale.id, 1);
        expect(result.statusCode).toBe(201);
        sum += Math.round(result.body.data.refundAmount * 100);
      }
      expect(sum).toBe(Math.round(totalAmount * 100));
      expect((await create(sale.id, 1)).statusCode).toBe(400);
    },
  );
  it.each(['VOIDED', 'PENDING', 'REFUNDED'])(
    'rejects %s sales without side effects',
    async (status) => {
      const sale = seedShopSale({ status });
      expect((await create(sale.id, 1)).statusCode).toBe(400);
      expect(table('return')).toHaveLength(0);
      expect(table('stockLog')).toHaveLength(0);
    },
  );
  it('revalidates stale completion before touching stock', async () => {
    const sale = seedShopSale();
    const created = await create(sale.id, 1);
    table('sale')[0].status = 'VOIDED';
    expect((await process(created.body.data.id, 'complete')).statusCode).toBe(
      400,
    );
    expect(table('stockLog')).toHaveLength(0);
    expect(table('return')[0].status).toBe('PENDING');
  });
  it('blocks void with a reservation; rejection permits void and prevents a new return', async () => {
    const sale = seedShopSale();
    const created = await create(sale.id, 1);
    await expect(
      SaleService.voidSale(sale.id, 'shop_1', undefined, 'test'),
    ).rejects.toThrow('Cannot void');
    expect(table('sale')[0].status).toBe('COMPLETED');
    await process(created.body.data.id, 'reject');
    await SaleService.voidSale(sale.id, 'shop_1', undefined, 'test');
    expect((await create(sale.id, 1)).statusCode).toBe(400);
  });
  it('completed returns consume entitlement permanently and prevent void stock restoration', async () => {
    table('product')[0].quantity = 10;
    const sale = seedShopSale();
    const created = await create(sale.id, 5);
    expect((await process(created.body.data.id, 'complete')).statusCode).toBe(200);
    expect(table('product')[0].quantity).toBe(15);
    expect((await create(sale.id, 1)).statusCode).toBe(400);
    expect((await process(created.body.data.id, 'reject')).statusCode).toBe(400);
    await expect(SaleService.voidSale(sale.id, 'shop_1', undefined, 'test')).rejects.toThrow('Cannot void');
    expect(table('product')[0].quantity).toBe(15);
    expect(table('stockLog')).toHaveLength(1);
  });
  it('rejects an overvalued historical request at completion without stock changes', async () => {
    const sale = seedShopSale({ totalAmount: 10 });
    const created = await create(sale.id, 1);
    table('returnItem')[0].unitPrice = 100;
    expect((await process(created.body.data.id, 'complete')).statusCode).toBe(400);
    expect(table('stockLog')).toHaveLength(0);
    expect(table('return')[0].status).toBe('PENDING');
  });
  it('concurrent void and reservation have exactly one winner', async () => {
    const sale = seedShopSale();
    const results = await Promise.allSettled([
      SaleService.voidSale(sale.id, 'shop_1', undefined, 'test'),
      create(sale.id, 5),
    ]);
    const voided = table('sale')[0].status === 'VOIDED';
    expect(table('return').length).toBe(voided ? 0 : 1);
    expect(results).toHaveLength(2);
  });
});

describe('return inventory isolation', () => {
  const line = (productId: string, extra = {}) => ({
    productId, productName: 'Widget', quantity: 2, unitPrice: 10, ...extra,
  });
  const body = (exchange = false) => ({
    reason: 'Wrong size', type: exchange ? 'EXCHANGE' : 'REFUND',
    items: [line('prod_widget')],
    exchangeItems: exchange ? [line('replacement')] : [],
  });
  async function create(payload: any) {
    const res = mockRes();
    await ReturnController.create(req(payload), res);
    return res;
  }
  async function complete(id: string) {
    const res = mockRes();
    await ReturnController.process({ ...req({ action: 'complete' }), params: { id } }, res);
    return res;
  }
  const snapshot = () => structuredClone({
    products: table('product'), returns: table('return'),
    items: table('returnItem'), logs: table('stockLog'),
  });

  it.each(['returned', 'exchange'])('rejects foreign %s inventory at creation', async (kind) => {
    seedShop({ id: 'shop_2' });
    seedProduct({ id: 'foreign', shopId: 'shop_2' });
    const payload = body();
    if (kind === 'returned') payload.items = [line('foreign', { restockable: false })];
    else payload.exchangeItems = [line('foreign')];
    const before = snapshot();
    const res = await create(payload);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toContain('not found in this shop');
    expect(snapshot()).toEqual(before);
  });

  it.each(['returned', 'exchange'])('rejects missing %s products at creation', async (kind) => {
    const payload = body();
    if (kind === 'returned') payload.items = [line('missing')];
    else payload.exchangeItems = [line('missing')];
    const before = snapshot();
    expect((await create(payload)).statusCode).toBe(400);
    expect(snapshot()).toEqual(before);
  });

  it.each(['returned', 'exchange'])('revalidates %s ownership within completion', async (kind) => {
    seedShop({ id: 'shop_2' });
    seedProduct({ id: 'replacement' });
    const created = await create(body(true));
    expect(created.statusCode).toBe(201);
    const id = kind === 'returned' ? 'prod_widget' : 'replacement';
    table('product').find(p => p.id === id)!.shopId = 'shop_2';
    const before = snapshot();
    const res = await complete(created.body.data.id);
    expect(res.statusCode).toBe(400);
    expect(snapshot()).toEqual(before);
  });

  it.each(['returned', 'exchange'])('rejects %s disappearance without partial completion', async (kind) => {
    seedProduct({ id: 'replacement' });
    const created = await create(body(true));
    expect(created.statusCode).toBe(201);
    const id = kind === 'returned' ? 'prod_widget' : 'replacement';
    const products = table('product');
    products.splice(products.findIndex(p => p.id === id), 1);
    const before = snapshot();
    const res = await complete(created.body.data.id);
    expect(res.statusCode).toBe(400);
    expect(snapshot()).toEqual(before);
  });

  it.each([false, true])('completes legitimate same-shop return (exchange=%s)', async (exchange) => {
    seedProduct({ id: 'replacement', quantity: 50 });
    const created = await create(body(exchange));
    expect(created.statusCode).toBe(201);
    expect((await complete(created.body.data.id)).statusCode).toBe(200);
    expect(table('product').find(p => p.id === 'prod_widget')!.quantity).toBe(102);
    expect(table('product').find(p => p.id === 'replacement')!.quantity).toBe(exchange ? 48 : 50);
    expect(table('return')[0].status).toBe('COMPLETED');
    expect(table('stockLog')).toHaveLength(exchange ? 2 : 1);
    expect(table('stockLog').every(log => log.shopId === 'shop_1')).toBe(true);
  });

  it('validates untracked products but does not change their quantities or log stock', async () => {
    table('product')[0].trackStock = false;
    seedProduct({ id: 'replacement', trackStock: false });
    const created = await create(body(true));
    expect((await complete(created.body.data.id)).statusCode).toBe(200);
    expect(table('product').map(p => p.quantity)).toEqual([100, 100]);
    expect(table('stockLog')).toHaveLength(0);
  });
});
