import { randomUUID } from 'crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/config/prisma';
import {
  PurchaseOrderController as controller,
  receivePurchaseOrderSchema,
} from '../src/controllers/purchaseOrder.controller';
import { StockService } from '../src/services/stock.service';
import { SaleService } from '../src/services/sale.service';
import { race } from './lockedRace';

const shops: string[] = [];
let shopId: string,
  supplierId: string,
  productId: string,
  poId: string,
  lineId: string;
beforeEach(async () => {
  const shop = await prisma.shop.create({
    data: {
      name: 'Receipt race',
      ownerName: 'Test',
      ownerYeboidSub: randomUUID(),
      ownerPhone: randomUUID(),
    },
  });
  shopId = shop.id;
  shops.push(shopId);
  const supplier = await prisma.supplier.create({
    data: { shopId, name: 'Supplier' },
  });
  supplierId = supplier.id;
  const product = await prisma.product.create({
    data: {
      shopId,
      name: 'Widget',
      quantity: 100,
      costPrice: 2,
      sellPrice: 10,
    },
  });
  productId = product.id;
  const po = await prisma.purchaseOrder.create({
    data: {
      shopId,
      supplierId,
      status: 'SENT',
      subtotal: 50,
      totalAmount: 50,
      items: {
        create: {
          productId,
          productName: 'Widget',
          quantity: 10,
          unitCost: 5,
          totalCost: 50,
        },
      },
    },
    include: { items: true },
  });
  poId = po.id;
  lineId = po.items[0].id;
});
afterAll(async () => {
  for (const id of shops) {
    await prisma.sale.deleteMany({ where: { shopId: id } });
    await prisma.shop.delete({ where: { id } });
  }
  await prisma.$disconnect();
});
async function receive(body: any = {}, scope = shopId) {
  const res: any = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: any) {
      this.body = body;
      return this;
    },
  };
  await controller.receive(
    {
      user: { id: scope, shopId: scope, type: 'shop' },
      params: { id: poId },
      body,
    } as any,
    res,
  );
  return res;
}
function partial(quantity: number) {
  return { items: [{ poItemId: lineId, quantity }] };
}
async function reconcile(qty: number, bills: number, stockDelta = qty) {
  const po = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: poId },
    include: { items: true },
  });
  expect(po.items[0].receivedQty).toBe(qty);
  expect(po.status).toBe(qty === 10 ? 'RECEIVED' : qty ? 'PARTIAL' : 'SENT');
  expect(po.amountReceived).toBe(qty * 5);
  expect(po.amountPaid).toBe(0);
  expect(
    (await prisma.supplier.findUniqueOrThrow({ where: { id: supplierId } }))
      .balance,
  ).toBe(qty * 5);
  const ledger = await prisma.supplierLedger.findMany({ where: { poId } });
  expect(ledger).toHaveLength(bills);
  expect(ledger.every((l) => l.type === 'BILL')).toBe(true);
  expect(ledger.reduce((sum, l) => sum + l.amount, 0)).toBe(qty * 5);
  expect(
    (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
      .quantity,
  ).toBe(100 + stockDelta);
  const logs = await prisma.stockLog.findMany({
    where: { productId },
    orderBy: { previousQty: 'asc' },
  });
  expect(logs.reduce((sum, l) => sum + l.quantity, 0)).toBe(stockDelta);
  for (const log of logs)
    expect(log.newQty - log.previousQty).toBe(log.quantity);
  expect(logs.filter((l) => l.reference === poId)).toHaveLength(bills);
}
async function receiptRace(bodies: any[]) {
  const results = await race(
    Prisma.sql`SELECT id FROM "PurchaseOrder" WHERE id = ${poId} FOR UPDATE`,
    bodies.map((body) => () => receive(body)),
  );
  return results.map((r) => {
    expect(r.status).toBe('fulfilled');
    return (r as PromiseFulfilledResult<any>).value;
  });
}

describe('Postgres purchase order receipt entitlement', () => {
  it('books a simultaneous full receipt once and rejects its replay', async () => {
    const results = await receiptRace([{}, {}]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    expect(results.find((r) => r.statusCode === 400).body.message).toMatch(
      /already fully received/,
    );
    expect((await receive()).statusCode).toBe(400);
    await reconcile(10, 1);
  });
  it('rejects a competing partial receipt that exceeds the remaining entitlement', async () => {
    const results = await receiptRace([partial(6), partial(6)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    expect(results.find((r) => r.statusCode === 400).body.message).toMatch(
      /only 4 outstanding/,
    );
    await reconcile(6, 1);
    expect((await receive(partial(4))).statusCode).toBe(200);
    await reconcile(10, 2);
  });
  it('accepts two partial receipts whose combined quantity fits', async () => {
    expect(
      (await receiptRace([partial(4), partial(6)])).map((r) => r.statusCode),
    ).toEqual([200, 200]);
    await reconcile(10, 2);
  });
  it('reconciles a full receipt competing with a partial receipt in either order', async () => {
    const results = await receiptRace([{}, partial(6)]);
    const successful = results.filter((r) => r.statusCode === 200).length;
    expect(results.every((r) => [200, 400].includes(r.statusCode))).toBe(true);
    await reconcile(10, successful);
  });
  it('allocates tax once across blocked concurrent partial receipts and final retry', async () => {
    await prisma.purchaseOrder.update({ where: { id: poId }, data: { tax: 0.01, totalAmount: 50.01 } });
    expect((await receiptRace([partial(4), partial(6)])).map(r => r.statusCode)).toEqual([200, 200]);
    expect((await receive()).statusCode).toBe(400);
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } });
    expect(po.amountReceived).toBe(50.01);
    const bills = await prisma.supplierLedger.findMany({ where: { poId } });
    expect(bills).toHaveLength(2);
    expect(bills.reduce((sum, bill) => sum + Math.round(bill.amount * 100), 0)).toBe(5001);
    expect((await prisma.supplier.findUniqueOrThrow({ where: { id: supplierId } })).balance).toBeCloseTo(50.01, 10);
  });
  it('rejects duplicate line ids in schema and controller without writes', async () => {
    const body = {
      items: [partial(6).items[0], partial(6).items[0]],
      updateCost: true,
    };
    expect(receivePurchaseOrderSchema.validate(body).error).toBeDefined();
    const result = await receive(body);
    expect(result.statusCode).toBe(400);
    expect(result.body.message).toMatch(/Duplicate/);
    await reconcile(0, 0);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
        .costPrice,
    ).toBe(2);
  });
  it('rejects foreign orders and foreign lines, rolling back the entire payload', async () => {
    expect((await receive({}, 'foreign-shop')).statusCode).toBe(404);
    expect(
      (
        await receive({
          items: [
            ...partial(2).items,
            { poItemId: 'foreign-line', quantity: 1 },
          ],
        })
      ).statusCode,
    ).toBe(400);
    await reconcile(0, 0);
  });
  it('rolls back stock, costs and payable writes when a stock log cannot be persisted', async () => {
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: any) {
        this.body = body;
        return this;
      },
    };
    // Invalid staff FK fails after Product.update inside the real transaction.
    await controller.receive(
      {
        user: { id: 'missing-staff', shopId, type: 'user' },
        params: { id: poId },
        body: { updateCost: true },
      } as any,
      res,
    );
    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
    await reconcile(0, 0);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
        .costPrice,
    ).toBe(2);
  });
  it('keeps stock and logs correct against a simultaneous bulk restock', async () => {
    const results = await race<any>(
      Prisma.sql`SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE`,
      [
        () => receive({ updateCost: true }),
        () =>
          StockService.receive({ shopId, items: [{ productId, quantity: 7 }] }),
      ],
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect((results[0] as PromiseFulfilledResult<any>).value.statusCode).toBe(
      200,
    );
    await reconcile(10, 1, 17);
    const logs = await prisma.stockLog.findMany({
      where: { productId },
      orderBy: { previousQty: 'asc' },
    });
    expect(logs).toHaveLength(2);
    expect(logs[0].newQty).toBe(logs[1].previousQty);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
        .costPrice,
    ).toBe(5);
  });
  it('serializes multi-product receipts and restocks supplied in opposite orders', async () => {
    const other = await prisma.product.create({
      data: { shopId, name: 'Other widget', quantity: 20, costPrice: 2, sellPrice: 10 },
    });
    const otherLine = await prisma.pOItem.create({
      data: { poId, productId: other.id, productName: other.name,
        quantity: 10, unitCost: 5, totalCost: 50 },
    });
    await prisma.purchaseOrder.update({ where: { id: poId }, data: { subtotal: 100, totalAmount: 100 } });
    const lines = [{ poItemId: lineId, productId },
      { poItemId: otherLine.id, productId: other.id }]
      .sort((a, b) => a.productId.localeCompare(b.productId));
    const results = await race<any>(
      Prisma.sql`SELECT id FROM "Product" WHERE id = ${lines[0].productId} FOR UPDATE`,
      [
        () => receive({ items: [...lines].reverse().map(l => ({ poItemId: l.poItemId, quantity: 10 })) }),
        () => StockService.receive({ shopId, items: lines.map(l => ({ productId: l.productId, quantity: 7 })) }),
      ],
    );
    expect(results.every(r => r.status === 'fulfilled')).toBe(true);
    expect((results[0] as PromiseFulfilledResult<any>).value.statusCode).toBe(200);
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, include: { items: true } });
    expect(po.status).toBe('RECEIVED');
    expect(po.amountReceived).toBe(100);
    expect(po.items.every(l => l.receivedQty === 10)).toBe(true);
    expect((await prisma.supplier.findUniqueOrThrow({ where: { id: supplierId } })).balance).toBe(100);
    const bills = await prisma.supplierLedger.findMany({ where: { poId } });
    expect(bills).toHaveLength(1);
    expect(bills[0].amount).toBe(100);
    for (const [id, initial] of [[productId, 100], [other.id, 20]] as const) {
      expect((await prisma.product.findUniqueOrThrow({ where: { id } })).quantity).toBe(initial + 17);
      const logs = await prisma.stockLog.findMany({ where: { productId: id }, orderBy: { previousQty: 'asc' } });
      expect(logs).toHaveLength(2);
      expect(logs[0].previousQty).toBe(initial);
      expect(logs[0].newQty).toBe(logs[1].previousQty);
      expect(logs[1].newQty).toBe(initial + 17);
    }
  });
  it('preserves a simultaneous sale decrement and its audit trail', async () => {
    const results = await race<any>(
      Prisma.sql`SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE`,
      [
        () => receive(),
        () =>
          SaleService.create({
            shopId,
            items: [{ productId, quantity: 3 }],
            paymentMethod: 'CASH',
            amountPaid: 30,
          }),
      ],
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect((results[0] as PromiseFulfilledResult<any>).value.statusCode).toBe(
      200,
    );
    await reconcile(10, 1, 7);
    const logs = await prisma.stockLog.findMany({ where: { productId } });
    expect(logs).toHaveLength(2);
    const sale = logs.find((l) => l.quantity === -3)!;
    const receipt = logs.find((l) => l.quantity === 10)!;
    expect(
      sale.newQty === receipt.previousQty ||
        receipt.newQty === sale.previousQty,
    ).toBe(true);
  });
});
