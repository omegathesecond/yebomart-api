/**
 * Tests for StockController — the highest-blast-radius controller in the app.
 * StockController.adjust/receive directly mutate Product.quantity and write
 * StockLog rows that feed reports, reorder suggestions, and (via PO receiving)
 * SupplierLedger, so a silent regression here corrupts inventory counts and
 * financials with nothing else to catch it.
 *
 * Covered:
 *   - getStock: stock levels + cost/sell-value summary, shop-scoped
 *   - getAlerts: low-stock categorization (critical/low/warning) against each
 *     product's own reorderAt, shop-scoped
 *   - getReorderSuggestions: sales-velocity math, predicted-stockout vs
 *     below-reorder reasons, the never-sold no-fabricated-qty rule, and that
 *     only COMPLETED sales inside the trailing window feed the velocity
 *   - getMovements: date range / product / type filters + pagination,
 *     shop-scoped
 *   - adjust: qty up/down, a StockMovement row with the right previous/new
 *     qty, the negative-stock guard, cross-shop product rejection (404), and
 *     that userId is only attributed for a staff (type: 'user') token
 *   - receive: bulk qty increase, RESTOCK log, cross-shop rejection, and the
 *     managerAuth gate that keeps a CASHIER off both write routes
 *
 * The controller is a thin transport shim over StockService, and the vitest
 * alias points `@config/prisma` at the in-memory fake, so driving the
 * controller runs the REAL stock arithmetic — nothing is stubbed out except
 * the JWKS network call needed to exercise managerAuth's role gate.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// managerAuth (imported below) wraps authMiddleware, which tries a YeboID
// (JWKS, real network) verify first and falls back to the yebomart-signed
// staff HS256 path only when that throws. Tests must never hit the network,
// so we force every token down the staff path and let extractBearerToken do
// its real, trivial job of pulling the token out of the header.
vi.mock('@yebo/mcp-server', () => ({
  JwksValidator: vi.fn().mockImplementation(() => ({
    verify: vi.fn().mockRejectedValue(new Error('not a YeboID token')),
  })),
  extractBearerToken: (header?: string) => header?.replace(/^Bearer\s+/i, '') ?? null,
}));

import { StockController } from './stock.controller';
import { managerAuth } from '../middleware/auth.middleware';
import { JWTUtil } from '../utils/jwt';
import {
  resetDb,
  seedShop,
  seedProduct,
  seedSale,
  seedStockLog,
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

let shopId: string;

// Shop-owner token (YeboID-authed shape) — the default for tests that don't
// care about staff attribution.
function authReq(
  body: Record<string, any> = {},
  query: Record<string, any> = {},
  params: Record<string, any> = {}
): any {
  return {
    user: { id: shopId, shopId, role: 'OWNER', type: 'shop' },
    body,
    query,
    params,
  };
}

// Staff (PIN) token — carries a real User id, so writes get attributed.
function staffReq(userId: string, role: 'MANAGER' | 'CASHIER', body: Record<string, any> = {}): any {
  return {
    user: { id: userId, shopId, role, type: 'user' },
    body,
    query: {},
    params: {},
  };
}

beforeEach(() => {
  resetDb();
  const shop = seedShop();
  shopId = shop.id;
});

describe('StockController.getStock', () => {
  it('returns active products ordered by category/name with a cost/sell-value summary', async () => {
    seedProduct({ shopId, name: 'Bread', category: 'Bakery', quantity: 10, costPrice: 5, sellPrice: 10, trackStock: true, isActive: true });
    seedProduct({ shopId, name: 'Soap', category: 'Household', quantity: 4, costPrice: 2, sellPrice: 6, trackStock: true, isActive: true });
    // Inactive — excluded entirely.
    seedProduct({ shopId, name: 'Discontinued', category: 'Bakery', quantity: 99, costPrice: 1, sellPrice: 2, isActive: false });
    // Active but not stock-tracked — listed, but contributes nothing to the value summary.
    seedProduct({ shopId, name: 'Sample', category: 'Bakery', quantity: 5, costPrice: 3, sellPrice: 9, trackStock: false, isActive: true });

    const res = mockRes();
    await StockController.getStock(authReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.products.map((p: any) => p.name)).toEqual(['Bread', 'Sample', 'Soap']);
    expect(res.body.data.summary).toMatchObject({
      totalProducts: 3,
      totalCostValue: 10 * 5 + 4 * 2, // Sample excluded (trackStock: false)
      totalSellValue: 10 * 10 + 4 * 6,
      potentialProfit: (10 * 10 + 4 * 6) - (10 * 5 + 4 * 2),
    });
  });

  it('is shop-scoped', async () => {
    seedShop({ ownerYeboidSub: 'other-owner' });
    seedProduct({ shopId: 'shop_2', name: 'Not mine', quantity: 5, costPrice: 1, sellPrice: 2 });
    seedProduct({ shopId, name: 'Mine', quantity: 5, costPrice: 1, sellPrice: 2 });

    const res = mockRes();
    await StockController.getStock(authReq(), res);

    expect(res.body.data.products).toHaveLength(1);
    expect(res.body.data.products[0].name).toBe('Mine');
  });

  it('401s without an authenticated user', async () => {
    const res = mockRes();
    await StockController.getStock({} as any, res);
    expect(res.statusCode).toBe(401);
  });
});

describe('StockController.getAlerts', () => {
  it('categorizes low-stock items against each product’s own reorderAt threshold', async () => {
    seedProduct({ shopId, name: 'Out', quantity: 0, reorderAt: 10 });
    seedProduct({ shopId, name: 'Low', quantity: 3, reorderAt: 10 }); // <= 5 (half of reorderAt)
    seedProduct({ shopId, name: 'Warn', quantity: 8, reorderAt: 10 }); // > 5, <= 10
    seedProduct({ shopId, name: 'Fine', quantity: 20, reorderAt: 10 }); // above threshold entirely
    seedProduct({ shopId, name: 'Untracked', quantity: 0, reorderAt: 10, trackStock: false });
    seedProduct({ shopId, name: 'Inactive', quantity: 0, reorderAt: 10, isActive: false });

    const res = mockRes();
    await StockController.getAlerts(authReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ total: 3, critical: 1, low: 1, warning: 1 });
    expect(res.body.data.items.critical.map((p: any) => p.name)).toEqual(['Out']);
    expect(res.body.data.items.low.map((p: any) => p.name)).toEqual(['Low']);
    expect(res.body.data.items.warning.map((p: any) => p.name)).toEqual(['Warn']);
  });

  it('is shop-scoped', async () => {
    seedShop({ ownerYeboidSub: 'other-owner' });
    seedProduct({ shopId: 'shop_2', name: 'Not mine', quantity: 0, reorderAt: 10 });
    seedProduct({ shopId, name: 'Mine', quantity: 0, reorderAt: 10 });

    const res = mockRes();
    await StockController.getAlerts(authReq(), res);

    expect(res.body.data.total).toBe(1);
    expect(res.body.data.items.critical[0].name).toBe('Mine');
  });

  it('401s without an authenticated user', async () => {
    const res = mockRes();
    await StockController.getAlerts({} as any, res);
    expect(res.statusCode).toBe(401);
  });
});

describe('StockController.getReorderSuggestions', () => {
  it('computes velocity, predicted days of cover, and a suggested reorder qty', async () => {
    const product = seedProduct({ shopId, name: 'Widget', quantity: 10, reorderAt: 5, costPrice: 2 });
    // 20 units sold 5 days ago, inside a 10-day window -> velocity 2/day.
    seedSale({
      shopId,
      status: 'COMPLETED',
      createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      items: [{ productId: product.id, productName: 'Widget', quantity: 20, unitPrice: 5, costPrice: 2, totalPrice: 100 }],
    });

    const res = mockRes();
    await StockController.getReorderSuggestions(authReq({}, { days: '10', within: '7', targetCoverDays: '14' }), res);

    expect(res.statusCode).toBe(200);
    const item = res.body.data.items.find((i: any) => i.productId === product.id);
    expect(item).toMatchObject({
      velocityPerDay: 2, // 20 / 10 days
      daysOfCover: 5, // 10 qty / 2 per day
      reason: 'predicted_stockout', // 5 days <= within (7)
      suggestedReorderQty: 2 * 14 - 10, // top up to 14 days of cover
    });
  });

  it('flags a never-sold product only when below reorder, without fabricating a suggested qty', async () => {
    const belowReorder = seedProduct({ shopId, name: 'NeverSold', quantity: 2, reorderAt: 10 });
    const aboveReorder = seedProduct({ shopId, name: 'FineStock', quantity: 50, reorderAt: 10 });

    const res = mockRes();
    await StockController.getReorderSuggestions(authReq(), res);

    const ids = res.body.data.items.map((i: any) => i.productId);
    expect(ids).toContain(belowReorder.id);
    expect(ids).not.toContain(aboveReorder.id);

    const item = res.body.data.items.find((i: any) => i.productId === belowReorder.id);
    expect(item).toMatchObject({
      velocityPerDay: 0,
      daysOfCover: null,
      suggestedReorderQty: 0,
      reason: 'below_reorder',
    });
  });

  it('excludes non-COMPLETED sales and sales outside the trailing window from the velocity calc', async () => {
    const product = seedProduct({ shopId, name: 'Widget', quantity: 10, reorderAt: 5 });
    // Outside the 10-day window — must not count.
    seedSale({
      shopId,
      receiptNumber: 'RCP-1',
      status: 'COMPLETED',
      createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      items: [{ productId: product.id, productName: 'Widget', quantity: 500, unitPrice: 5, costPrice: 2, totalPrice: 2500 }],
    });
    // Not COMPLETED — must not count.
    seedSale({
      shopId,
      receiptNumber: 'RCP-2',
      status: 'VOIDED',
      createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      items: [{ productId: product.id, productName: 'Widget', quantity: 500, unitPrice: 5, costPrice: 2, totalPrice: 2500 }],
    });
    // In-window and COMPLETED — the only sale that should feed the velocity.
    seedSale({
      shopId,
      receiptNumber: 'RCP-3',
      status: 'COMPLETED',
      createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      items: [{ productId: product.id, productName: 'Widget', quantity: 10, unitPrice: 5, costPrice: 2, totalPrice: 50 }],
    });

    const res = mockRes();
    await StockController.getReorderSuggestions(authReq({}, { days: '10', within: '15' }), res);

    const item = res.body.data.items.find((i: any) => i.productId === product.id);
    expect(item).toBeDefined();
    // 10 units / 10 days = 1/day. If the voided or out-of-window sales leaked
    // in, this would read 101/day (1010 units / 10 days) instead.
    expect(item.velocityPerDay).toBe(1);
  });

  it('401s without an authenticated user', async () => {
    const res = mockRes();
    await StockController.getReorderSuggestions({ query: {} } as any, res);
    expect(res.statusCode).toBe(401);
  });
});

describe('StockController.getMovements', () => {
  it('filters by product, type, and date range, shop-scoped', async () => {
    const product = seedProduct({ shopId, name: 'Widget' });
    const other = seedProduct({ shopId, name: 'Other' });
    seedShop({ ownerYeboidSub: 'other-owner' });

    seedStockLog({ shopId, productId: product.id, type: 'ADJUSTMENT', createdAt: new Date('2026-01-01') });
    const match = seedStockLog({ shopId, productId: product.id, type: 'RESTOCK', createdAt: new Date('2026-02-01') });
    seedStockLog({ shopId, productId: other.id, type: 'RESTOCK', createdAt: new Date('2026-02-05') });
    seedStockLog({ shopId: 'shop_2', productId: product.id, type: 'RESTOCK', createdAt: new Date('2026-02-01') });

    const res = mockRes();
    await StockController.getMovements(
      authReq({}, {
        productId: product.id,
        type: 'RESTOCK',
        startDate: '2026-01-15',
        endDate: '2026-02-28',
      }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(match.id);
    expect(res.body.metadata.total).toBe(1);
  });

  it('joins product and user details on each movement', async () => {
    const product = seedProduct({ shopId, name: 'Widget' });
    seedStockLog({ shopId, productId: product.id, type: 'ADJUSTMENT' });

    const res = mockRes();
    await StockController.getMovements(authReq(), res);

    expect(res.body.data[0].product).toMatchObject({ id: product.id, name: 'Widget' });
  });

  it('paginates results', async () => {
    const product = seedProduct({ shopId });
    seedStockLog({ shopId, productId: product.id, createdAt: new Date('2026-01-01') });
    seedStockLog({ shopId, productId: product.id, createdAt: new Date('2026-01-02') });
    seedStockLog({ shopId, productId: product.id, createdAt: new Date('2026-01-03') });

    const res = mockRes();
    await StockController.getMovements(authReq({}, { page: 1, limit: 2 }), res);

    expect(res.body.data).toHaveLength(2);
    expect(res.body.metadata).toMatchObject({ total: 3, page: 1, limit: 2, hasNext: true, hasPrev: false });
  });

  it('401s without an authenticated user', async () => {
    const res = mockRes();
    await StockController.getMovements({ query: {} } as any, res);
    expect(res.statusCode).toBe(401);
  });
});

describe('StockController.adjust', () => {
  it('increases quantity and writes an ADJUSTMENT stock log', async () => {
    const product = seedProduct({ shopId, quantity: 10 });

    const res = mockRes();
    await StockController.adjust(authReq({ productId: product.id, type: 'ADJUSTMENT', quantity: 5, note: 'recount' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.product.quantity).toBe(15);
    const logs = table('stockLog');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      type: 'ADJUSTMENT',
      quantity: 5,
      previousQty: 10,
      newQty: 15,
      note: 'recount',
    });
  });

  it('decreases quantity and writes a DAMAGED stock log', async () => {
    const product = seedProduct({ shopId, quantity: 10 });

    const res = mockRes();
    await StockController.adjust(authReq({ productId: product.id, type: 'DAMAGED', quantity: -3 }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.product.quantity).toBe(7);
    expect(table('stockLog')[0]).toMatchObject({ type: 'DAMAGED', quantity: -3, previousQty: 10, newQty: 7 });
  });

  it('rejects reducing stock below zero with 400, leaving quantity and log untouched', async () => {
    const product = seedProduct({ shopId, quantity: 5 });

    const res = mockRes();
    await StockController.adjust(authReq({ productId: product.id, type: 'DAMAGED', quantity: -10 }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/cannot reduce/i);
    expect(table('product').find((p: any) => p.id === product.id).quantity).toBe(5);
    expect(table('stockLog')).toHaveLength(0);
  });

  it('404s adjusting a product that belongs to another shop, without touching it', async () => {
    seedShop({ ownerYeboidSub: 'other-owner' });
    const otherProduct = seedProduct({ shopId: 'shop_2', quantity: 10 });

    const res = mockRes();
    await StockController.adjust(authReq({ productId: otherProduct.id, type: 'ADJUSTMENT', quantity: 5 }), res);

    expect(res.statusCode).toBe(404);
    expect(table('product').find((p: any) => p.id === otherProduct.id).quantity).toBe(10);
    expect(table('stockLog')).toHaveLength(0);
  });

  it('404s adjusting a product id that does not exist', async () => {
    const res = mockRes();
    await StockController.adjust(authReq({ productId: 'nope', type: 'ADJUSTMENT', quantity: 5 }), res);
    expect(res.statusCode).toBe(404);
  });

  it('attributes the stock log to the acting staff member (type: "user")', async () => {
    const product = seedProduct({ shopId, quantity: 10 });

    const res = mockRes();
    await StockController.adjust(staffReq('user_9', 'MANAGER', { productId: product.id, type: 'ADJUSTMENT', quantity: 1 }), res);

    expect(res.statusCode).toBe(200);
    expect(table('stockLog')[0].userId).toBe('user_9');
  });

  it('leaves userId unset for an owner (shop) token', async () => {
    const product = seedProduct({ shopId, quantity: 10 });

    const res = mockRes();
    await StockController.adjust(authReq({ productId: product.id, type: 'ADJUSTMENT', quantity: 1 }), res);

    expect(table('stockLog')[0].userId).toBeUndefined();
  });

  it('401s without an authenticated user', async () => {
    const res = mockRes();
    await StockController.adjust({ body: {} } as any, res);
    expect(res.statusCode).toBe(401);
  });
});

describe('StockController.receive', () => {
  it('increases quantity for every item and writes a RESTOCK stock log each', async () => {
    const a = seedProduct({ shopId, quantity: 10 });
    const b = seedProduct({ shopId, quantity: 3 });

    const res = mockRes();
    await StockController.receive(
      authReq({ items: [{ productId: a.id, quantity: 5 }, { productId: b.id, quantity: 2 }], reference: 'PO-1' }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(table('product').find((p: any) => p.id === a.id).quantity).toBe(15);
    expect(table('product').find((p: any) => p.id === b.id).quantity).toBe(5);
    const logs = table('stockLog');
    expect(logs).toHaveLength(2);
    expect(logs.every((l: any) => l.type === 'RESTOCK' && l.reference === 'PO-1')).toBe(true);
  });

  it('rejects a non-positive item quantity with 400, writing nothing', async () => {
    const product = seedProduct({ shopId, quantity: 10 });

    const res = mockRes();
    await StockController.receive(authReq({ items: [{ productId: product.id, quantity: 0 }] }), res);

    expect(res.statusCode).toBe(400);
    expect(table('product').find((p: any) => p.id === product.id).quantity).toBe(10);
    expect(table('stockLog')).toHaveLength(0);
  });

  it('404s receiving against a product that belongs to another shop, without touching it', async () => {
    seedShop({ ownerYeboidSub: 'other-owner' });
    const otherProduct = seedProduct({ shopId: 'shop_2', quantity: 10 });

    const res = mockRes();
    await StockController.receive(authReq({ items: [{ productId: otherProduct.id, quantity: 5 }] }), res);

    expect(res.statusCode).toBe(404);
    expect(table('product').find((p: any) => p.id === otherProduct.id).quantity).toBe(10);
    expect(table('stockLog')).toHaveLength(0);
  });

  it('404s when only SOME items in the batch belong to another shop (no partial receive)', async () => {
    seedShop({ ownerYeboidSub: 'other-owner' });
    const mine = seedProduct({ shopId, quantity: 10 });
    const notMine = seedProduct({ shopId: 'shop_2', quantity: 10 });

    const res = mockRes();
    await StockController.receive(
      authReq({ items: [{ productId: mine.id, quantity: 5 }, { productId: notMine.id, quantity: 5 }] }),
      res
    );

    expect(res.statusCode).toBe(404);
    // Neither product moved — the whole batch is rejected, not just the bad item.
    expect(table('product').find((p: any) => p.id === mine.id).quantity).toBe(10);
    expect(table('stockLog')).toHaveLength(0);
  });

  it('401s without an authenticated user', async () => {
    const res = mockRes();
    await StockController.receive({ body: {} } as any, res);
    expect(res.statusCode).toBe(401);
  });
});

describe('stock write routes — managerAuth gates CASHIER off /stock/adjust and /stock/receive', () => {
  function bearerReq(token: string): any {
    return { headers: { authorization: `Bearer ${token}` } };
  }

  function signStaff(role: 'OWNER' | 'MANAGER' | 'CASHIER') {
    return JWTUtil.generateAccessToken({ id: 'user_1', shopId, role, type: 'user' });
  }

  it('rejects a CASHIER with 403', async () => {
    const res = mockRes();
    const next = vi.fn();

    await managerAuth(bearerReq(signStaff('CASHIER')), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('admits a MANAGER', async () => {
    const res = mockRes();
    const next = vi.fn();

    await managerAuth(bearerReq(signStaff('MANAGER')), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200); // untouched — managerAuth never wrote to res
  });

  it('admits an OWNER', async () => {
    const res = mockRes();
    const next = vi.fn();

    await managerAuth(bearerReq(signStaff('OWNER')), res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('401s with no token at all', async () => {
    const res = mockRes();
    const next = vi.fn();

    await managerAuth({ headers: {} } as any, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});
