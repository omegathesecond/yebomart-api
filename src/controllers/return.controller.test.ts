/**
 * ReturnController.create / process — returns & exchanges, against a REAL
 * Postgres. The restock/exchange logic runs inside prisma.$transaction, so the
 * test drives the controller end-to-end (fake req/res) and asserts the money +
 * stock outcomes:
 *   - refund amount is computed from the returned line items (or honoured if
 *     explicitly supplied)
 *   - completing a return RESTORES stock and writes a RETURN StockLog
 *   - completing an EXCHANGE deducts the swapped-out item from stock
 *   - non-restockable items are not put back
 *
 * The controller constructs its own PrismaClient from DATABASE_URL, which the
 * harness points at the test DB — so its writes land in the same database the
 * assertions read via the shared prisma client.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ReturnController } from './return.controller';
import { prisma, resetDb } from '../test/db';
import { seedShop, seedProduct, seedUser } from '../test/factories';

let shopId: string;
let userId: string;

beforeEach(async () => {
  await resetDb();
  const shop = await seedShop();
  shopId = shop.id;
  const user = await seedUser(shopId, { canManageStock: true });
  userId = user.id;
});

/** Minimal AuthRequest stand-in. type:'user' => stock logs get attributed. */
function makeReq(over: Record<string, any> = {}): any {
  return {
    user: { type: 'user', id: userId, shopId },
    body: {},
    params: {},
    query: {},
    ...over,
  };
}

/** Capture-only Response: records the status code + JSON body the controller emits. */
function makeRes() {
  const res: any = {
    statusCode: 0,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: any) {
      res.body = payload;
      return res;
    },
    send(payload?: any) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

describe('ReturnController.create', () => {
  it('computes the refund from the returned line items when not supplied', async () => {
    const product = await seedProduct(shopId, { sellPrice: 10, quantity: 100 });
    const res = makeRes();

    await ReturnController.create(
      makeReq({
        body: {
          reason: 'Defective unit',
          type: 'REFUND',
          items: [
            { productId: product.id, productName: 'Widget', quantity: 3, unitPrice: 10 },
          ],
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(201);
    const created = res.body.data;
    expect(created.refundAmount).toBe(30); // 3 * 10
    expect(created.status).toBe('PENDING');
    // Stock is NOT touched until the return is completed.
    const stored = await prisma.product.findUnique({ where: { id: product.id } });
    expect(stored!.quantity).toBe(100);
  });

  it('honours an explicitly supplied refundAmount', async () => {
    const product = await seedProduct(shopId, { sellPrice: 10, quantity: 100 });
    const res = makeRes();

    await ReturnController.create(
      makeReq({
        body: {
          reason: 'Partial refund agreed',
          type: 'REFUND',
          refundAmount: 25,
          items: [
            { productId: product.id, productName: 'Widget', quantity: 3, unitPrice: 10 },
          ],
        },
      }),
      res,
    );

    expect(res.body.data.refundAmount).toBe(25);
  });

  it('records refundAmount 0 for a non-REFUND (exchange) return', async () => {
    const product = await seedProduct(shopId, { sellPrice: 10, quantity: 100 });
    const res = makeRes();

    await ReturnController.create(
      makeReq({
        body: {
          reason: 'Wrong size',
          type: 'EXCHANGE',
          items: [{ productId: product.id, productName: 'Widget', quantity: 1, unitPrice: 10 }],
        },
      }),
      res,
    );

    expect(res.body.data.refundAmount).toBe(0);
  });
});

/** Helper: create a PENDING return and return its id. */
async function createReturn(body: Record<string, any>): Promise<string> {
  const res = makeRes();
  await ReturnController.create(makeReq({ body }), res);
  expect(res.statusCode).toBe(201);
  return res.body.data.id;
}

describe('ReturnController.process — complete restores stock', () => {
  it('restocks a restockable returned item and writes a RETURN stock log', async () => {
    const product = await seedProduct(shopId, { sellPrice: 10, quantity: 100 });
    const returnId = await createReturn({
      reason: 'Changed mind',
      type: 'REFUND',
      items: [
        { productId: product.id, productName: 'Widget', quantity: 4, unitPrice: 10, restockable: true },
      ],
    });

    const res = makeRes();
    await ReturnController.process(
      makeReq({ params: { id: returnId }, body: { action: 'complete' } }),
      res,
    );

    expect(res.body.data.status).toBe('COMPLETED');

    const stored = await prisma.product.findUnique({ where: { id: product.id } });
    expect(stored!.quantity).toBe(104); // 100 + 4 restored

    const logs = await prisma.stockLog.findMany({ where: { shopId, productId: product.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      type: 'RETURN',
      quantity: 4,
      previousQty: 100,
      newQty: 104,
      reference: returnId,
    });

    const items = await prisma.returnItem.findMany({ where: { returnId } });
    expect(items[0].restocked).toBe(true);
  });

  it('does NOT restock a non-restockable item', async () => {
    const product = await seedProduct(shopId, { sellPrice: 10, quantity: 100 });
    const returnId = await createReturn({
      reason: 'Damaged beyond resale',
      type: 'REFUND',
      items: [
        { productId: product.id, productName: 'Widget', quantity: 4, unitPrice: 10, restockable: false },
      ],
    });

    const res = makeRes();
    await ReturnController.process(
      makeReq({ params: { id: returnId }, body: { action: 'complete' } }),
      res,
    );

    const stored = await prisma.product.findUnique({ where: { id: product.id } });
    expect(stored!.quantity).toBe(100); // unchanged
    expect(await prisma.stockLog.count({ where: { shopId } })).toBe(0);
  });

  it('deducts exchange items from stock on completion', async () => {
    const returned = await seedProduct(shopId, { name: 'Returned', sellPrice: 10, quantity: 100 });
    const swapped = await seedProduct(shopId, { name: 'Swapped', sellPrice: 10, quantity: 50 });

    const returnId = await createReturn({
      reason: 'Wrong colour',
      type: 'EXCHANGE',
      items: [
        { productId: returned.id, productName: 'Returned', quantity: 2, unitPrice: 10, restockable: true },
      ],
      exchangeItems: [
        { productId: swapped.id, productName: 'Swapped', quantity: 2, unitPrice: 10 },
      ],
    });

    const res = makeRes();
    await ReturnController.process(
      makeReq({ params: { id: returnId }, body: { action: 'complete' } }),
      res,
    );

    const ret = await prisma.product.findUnique({ where: { id: returned.id } });
    const swp = await prisma.product.findUnique({ where: { id: swapped.id } });
    expect(ret!.quantity).toBe(102); // returned item back in
    expect(swp!.quantity).toBe(48); // swapped item out

    const swapLog = await prisma.stockLog.findFirst({
      where: { shopId, productId: swapped.id },
    });
    expect(swapLog).toMatchObject({ type: 'SALE', quantity: -2, previousQty: 50, newQty: 48 });
  });

  it('approve/reject do not move stock', async () => {
    const product = await seedProduct(shopId, { sellPrice: 10, quantity: 100 });
    const returnId = await createReturn({
      reason: 'Pending review',
      type: 'REFUND',
      items: [
        { productId: product.id, productName: 'Widget', quantity: 4, unitPrice: 10, restockable: true },
      ],
    });

    const res = makeRes();
    await ReturnController.process(
      makeReq({ params: { id: returnId }, body: { action: 'approve' } }),
      res,
    );

    expect(res.body.data.status).toBe('APPROVED');
    const stored = await prisma.product.findUnique({ where: { id: product.id } });
    expect(stored!.quantity).toBe(100); // untouched until completed
  });
});
