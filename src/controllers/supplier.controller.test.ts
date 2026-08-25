/**
 * Tests for SupplierController.getLedger — the accounts-payable ledger view
 * added alongside the supplier-payables UI. Ledger entries themselves are
 * booked by PurchaseOrderController (receive -> BILL, recordPayment ->
 * PAYMENT); this only pins that getLedger surfaces them correctly, scoped to
 * the right supplier/shop and newest first.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SupplierController } from './supplier.controller';
import { PurchaseOrderController } from './purchaseOrder.controller';
import { resetDb, seedShop, seedSupplier, seedProduct, seedPurchaseOrder, table } from '../test/prismaFake';

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

function req(supplierId: string, query: Record<string, any> = {}): any {
  return {
    user: { id: 'user_1', shopId: 'shop_1', role: 'MANAGER', type: 'user' },
    params: { id: supplierId },
    query,
  };
}

let supplierId: string;
let poId: string;

beforeEach(async () => {
  resetDb();
  seedShop({ ownerYeboidSub: '11111111-1111-1111-1111-111111111111' });
  const supplier = seedSupplier({ shopId: 'shop_1', balance: 0 });
  supplierId = supplier.id;
  const product = seedProduct({ shopId: 'shop_1', quantity: 100, costPrice: 5 });
  const po = seedPurchaseOrder({
    shopId: 'shop_1',
    supplierId,
    status: 'SENT',
    items: [
      { productId: product.id, productName: 'Widget', quantity: 10, unitCost: 5, totalCost: 50, receivedQty: 0 },
    ],
  });
  poId = po.id;

  // Book a BILL (receive in full) then a partial PAYMENT, so the ledger has
  // two entries to page through.
  await PurchaseOrderController.receive(
    { user: { id: 'user_1', shopId: 'shop_1', role: 'MANAGER', type: 'user' }, params: { id: poId }, body: {} } as any,
    mockRes(),
  );
  await PurchaseOrderController.recordPayment(
    {
      user: { id: 'user_1', shopId: 'shop_1', role: 'MANAGER', type: 'user' },
      params: { id: poId },
      body: { amount: 20 },
    } as any,
    mockRes(),
  );
});

describe('SupplierController.getLedger', () => {
  it('returns the supplier ledger entries newest first with pagination metadata', async () => {
    const res = mockRes();

    await SupplierController.getLedger(req(supplierId), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toHaveLength(2);
    // Newest first: the PAYMENT was booked after the BILL.
    expect(res.body.data[0]).toMatchObject({ type: 'PAYMENT', amount: 20 });
    expect(res.body.data[1]).toMatchObject({ type: 'BILL', amount: 50 });
    expect(res.body.metadata).toMatchObject({ total: 2, page: 1, limit: 50, hasNext: false, hasPrev: false });
  });

  it('paginates with page/limit', async () => {
    const res = mockRes();

    await SupplierController.getLedger(req(supplierId, { page: 1, limit: 1 }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ type: 'PAYMENT', amount: 20 });
    expect(res.body.metadata).toMatchObject({ total: 2, page: 1, limit: 1, hasNext: true, hasPrev: false });
  });

  it('404s for a supplier outside the caller shop', async () => {
    seedShop({ ownerYeboidSub: '22222222-2222-2222-2222-222222222222' });
    const otherSupplier = seedSupplier({ shopId: 'shop_2', balance: 0 });
    const res = mockRes();

    await SupplierController.getLedger(req(otherSupplier.id), res);

    expect(res.statusCode).toBe(404);
    expect(table('supplierLedger')).toHaveLength(2); // unaffected
  });
});
