/**
 * Tests for PurchaseOrderController — the accounts-payable invariants.
 *
 * Before this change, receiving a PO bumped inventory but never booked the
 * cost: purchases were understated, profit overstated, and there was no way to
 * see what the shop owed suppliers. These tests pin the fix:
 *
 *   (a) receiving goods books a BILL on the SupplierLedger for the cost VALUE
 *       received in that receipt (Σ qty*unitCost) and bumps Supplier.balance +
 *       PurchaseOrder.amountReceived in the same transaction — alongside the
 *       existing stock bump + RESTOCK log;
 *   (b) a partial receipt books only the partially-received value;
 *   (c) paying a supplier books a PAYMENT, lowers the balance, raises
 *       amountPaid, and refuses to overpay the balance due (partial payments
 *       are representable).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PurchaseOrderController } from './purchaseOrder.controller';
import {
  resetDb,
  seedShop,
  seedSupplier,
  seedProduct,
  seedPurchaseOrder,
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

function req(poId: string, body: Record<string, any> = {}): any {
  return {
    user: { id: 'user_1', shopId: 'shop_1', role: 'MANAGER', type: 'user' },
    params: { id: poId },
    body,
  };
}

let supplierId: string;
let productId: string;
let poId: string;
let poItemId: string;

beforeEach(() => {
  resetDb();
  seedShop({ ownerYeboidSub: '11111111-1111-1111-1111-111111111111' });
  const supplier = seedSupplier({ shopId: 'shop_1', balance: 0 });
  supplierId = supplier.id;
  const product = seedProduct({ shopId: 'shop_1', quantity: 100, costPrice: 5 });
  productId = product.id;
  const po = seedPurchaseOrder({
    shopId: 'shop_1',
    supplierId,
    status: 'SENT',
    items: [
      {
        productId,
        productName: 'Widget',
        quantity: 10,
        unitCost: 5,
        totalCost: 50,
        receivedQty: 0,
      },
    ],
  });
  poId = po.id;
  poItemId = table('pOItem')[0].id;
});

describe('PurchaseOrderController.receive — books the cost as a supplier payable', () => {
  it('full receive writes a BILL, bumps supplier balance and PO amountReceived', async () => {
    const res = mockRes();

    await PurchaseOrderController.receive(req(poId), res); // no items => receive everything

    expect(res.statusCode).toBe(200);

    // A payable was booked for the full cost value (10 * 5).
    const ledger = table('supplierLedger');
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      type: 'BILL',
      amount: 50,
      supplierId,
      poId,
    });

    // Supplier balance (what we owe) rose by the received value.
    expect(table('supplier')[0].balance).toBe(50);

    // PO now carries the billed value and a derived balance due.
    const po = table('purchaseOrder')[0];
    expect(po.amountReceived).toBe(50);
    expect(po.amountPaid).toBe(0);
    expect(po.status).toBe('RECEIVED');
    expect(res.body.data.balanceDue).toBe(50);

    // The existing stock behaviour is untouched.
    expect(table('product')[0].quantity).toBe(110);
    const stock = table('stockLog');
    expect(stock).toHaveLength(1);
    expect(stock[0]).toMatchObject({ type: 'RESTOCK', quantity: 10, newQty: 110 });
  });

  it('partial receive books only the received value', async () => {
    const res = mockRes();

    await PurchaseOrderController.receive(req(poId, { items: [{ poItemId, quantity: 4 }] }), res);

    expect(res.statusCode).toBe(200);

    const ledger = table('supplierLedger');
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ type: 'BILL', amount: 20 });

    expect(table('supplier')[0].balance).toBe(20);
    expect(table('purchaseOrder')[0].amountReceived).toBe(20);
    expect(table('purchaseOrder')[0].status).toBe('PARTIAL');
    expect(res.body.data.balanceDue).toBe(20);
  });

  it('does not book a payable when there is nothing to receive', async () => {
    // Pre-receive the whole line, then attempt to receive again.
    await PurchaseOrderController.receive(req(poId), mockRes());
    const res = mockRes();

    await PurchaseOrderController.receive(req(poId), res);

    expect(res.statusCode).toBe(400);
    // Still only the single BILL from the first (successful) receive.
    expect(table('supplierLedger')).toHaveLength(1);
  });
});

describe('PurchaseOrderController.recordPayment — partial payments against a PO', () => {
  beforeEach(async () => {
    // Receive in full so there is a 50 balance due to pay down.
    await PurchaseOrderController.receive(req(poId), mockRes());
  });

  it('books a PAYMENT, lowers the supplier balance and raises amountPaid', async () => {
    const res = mockRes();

    await PurchaseOrderController.recordPayment(req(poId, { amount: 30 }), res);

    expect(res.statusCode).toBe(200);

    const payment = table('supplierLedger').find((l) => l.type === 'PAYMENT');
    expect(payment).toMatchObject({ type: 'PAYMENT', amount: 30, supplierId, poId });

    // Owed balance dropped from 50 to 20.
    expect(table('supplier')[0].balance).toBe(20);
    const po = table('purchaseOrder')[0];
    expect(po.amountPaid).toBe(30);
    expect(res.body.data.balanceDue).toBe(20);
  });

  it('refuses a payment that exceeds the balance due', async () => {
    const res = mockRes();

    await PurchaseOrderController.recordPayment(req(poId, { amount: 80 }), res);

    expect(res.statusCode).toBe(400);
    // Balance and ledger unchanged (no PAYMENT written).
    expect(table('supplier')[0].balance).toBe(50);
    expect(table('supplierLedger').some((l) => l.type === 'PAYMENT')).toBe(false);
  });
});
