import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StockController, receiveStockSchema } from './stock.controller';
import { validateRequest } from '../middleware/validation.middleware';
import { prismaFake, resetDb, seedShop, seedProduct, table } from '../test/prismaFake';

// The production bug this endpoint regressed on was a CONTRACT MISMATCH at the
// validation boundary, NOT inside the service: the app client POSTed a flat
// `{ productId, quantity, costPrice }` body, but receiveStockSchema requires an
// `items[]` array — so Joi (via validateRequest) rejected every receive with a
// 400 before StockService.receive ever ran. The service-level tests
// (stock.receive.test.ts) can't catch that — they call the service directly and
// skip the schema. So these tests drive the SAME middleware chain wired in
// stock.routes.ts for POST /api/stock/receive:
//
//     validateRequest(receiveStockSchema)  ->  StockController.receive
//
// stock.controller imports `prisma` (via StockService) from `@config/prisma`,
// which the vitest config aliases to the in-memory fake — so the whole
// controller -> service -> DB chain transparently hits prismaFake here.

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

// Reproduce the exact route pipeline: run validateRequest first, and only call
// the controller if validation passed (next() fired) — mirroring how Express
// would. On a validation failure the middleware itself writes the 400 and the
// controller never runs, just like in production.
async function postReceive(body: any, user: any) {
  const req: any = { body, user };
  const res = mockRes();
  let passedValidation = false;
  validateRequest(receiveStockSchema)(req, res, () => {
    passedValidation = true;
  });
  if (passedValidation) {
    await StockController.receive(req, res);
  }
  return res;
}

// req.user as set by authMiddleware: a logged-in shop user (so receive attributes
// the movement to req.user.id and scopes to req.user.shopId).
function shopUser(shopId: string) {
  return { type: 'user', id: 'user_1', shopId };
}

beforeEach(() => {
  resetDb();
  vi.restoreAllMocks();
});

describe('POST /api/stock/receive — valid items[] batch with per-item costPrice', () => {
  it('returns 200 and persists the new quantity AND the updated product cost', async () => {
    const shop = seedShop();
    const product = seedProduct({ shopId: shop.id, quantity: 10, costPrice: 5 });

    const res = await postReceive(
      { items: [{ productId: product.id, quantity: 5, costPrice: 8 }] },
      shopUser(shop.id)
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);

    // The whole point of the receive flow: stock goes up by the received qty...
    expect(table('product')[0].quantity).toBe(15);
    // ...and the supplied supplier cost is persisted, so COGS/profit/margin
    // stay accurate after a price change (the bug the fix closed).
    expect(table('product')[0].costPrice).toBe(8);

    // A RESTOCK movement is logged for the received item.
    const logs = table('stockLog');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ type: 'RESTOCK', quantity: 5, previousQty: 10, newQty: 15 });
  });

  it('leaves the product cost untouched when no costPrice is supplied', async () => {
    const shop = seedShop();
    const product = seedProduct({ shopId: shop.id, quantity: 10, costPrice: 5 });

    const res = await postReceive(
      { items: [{ productId: product.id, quantity: 3 }] },
      shopUser(shop.id)
    );

    expect(res.statusCode).toBe(200);
    expect(table('product')[0].quantity).toBe(13);
    expect(table('product')[0].costPrice).toBe(5);
  });
});

describe('POST /api/stock/receive — validation boundary (the original regression)', () => {
  it('rejects a flat { productId, quantity } body with 400 and never touches stock', async () => {
    const shop = seedShop();
    const product = seedProduct({ shopId: shop.id, quantity: 10, costPrice: 5 });
    // If validation lets the request through, the service's first DB read is
    // product.findMany — spying on it proves the schema short-circuits first.
    const findMany = vi.spyOn(prismaFake.product, 'findMany');

    const res = await postReceive(
      // Exactly what the app client used to send — no items[] wrapper.
      { productId: product.id, quantity: 5, costPrice: 8 },
      shopUser(shop.id)
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
    // validateRequest rejects with the canonical "Validation failed" message
    // (the per-field details are dev-only, so we don't assert on them here).
    expect(res.body.message).toBe('Validation failed');
    // The controller/service must never run — stock stays exactly as seeded.
    expect(findMany).not.toHaveBeenCalled();
    expect(table('product')[0].quantity).toBe(10);
    expect(table('product')[0].costPrice).toBe(5);
    expect(table('stockLog')).toHaveLength(0);
  });

  it('rejects an item with a negative costPrice with 400 and never touches stock', async () => {
    const shop = seedShop();
    const product = seedProduct({ shopId: shop.id, quantity: 10, costPrice: 5 });
    const findMany = vi.spyOn(prismaFake.product, 'findMany');

    const res = await postReceive(
      { items: [{ productId: product.id, quantity: 5, costPrice: -3 }] },
      shopUser(shop.id)
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
    expect(findMany).not.toHaveBeenCalled();
    // A bad cost must NOT bleed through to the product (no partial write).
    expect(table('product')[0].quantity).toBe(10);
    expect(table('product')[0].costPrice).toBe(5);
    expect(table('stockLog')).toHaveLength(0);
  });
});
