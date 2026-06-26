import { describe, it, expect, beforeEach } from 'vitest';
import { SupplierController } from './supplier.controller';
import { resetDb, seedSupplier, seedProduct, seedSupplierProduct, table } from '../test/prismaFake';

// Minimal Express req/res doubles — the controller only touches these fields.
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

function reqFor(supplierId: string, productId: string, shopId = 'shop_1'): any {
  return {
    user: { id: 'user_1', shopId, role: 'OWNER' },
    params: { id: supplierId, productId },
    body: {},
  };
}

beforeEach(() => {
  resetDb();
});

describe('SupplierController.removeProduct — tenancy (cross-shop tampering)', () => {
  it('rejects removing a link whose supplier belongs to ANOTHER shop and leaves it intact', async () => {
    // Attacker's shop is shop_1; the victim link lives entirely in shop_2.
    const victimSupplier = seedSupplier({ shopId: 'shop_2' });
    const victimProduct = seedProduct({ shopId: 'shop_2' });
    const link = seedSupplierProduct({ supplierId: victimSupplier.id, productId: victimProduct.id });

    const res = mockRes();
    await SupplierController.removeProduct(reqFor(victimSupplier.id, victimProduct.id, 'shop_1'), res);

    // 404 (not 200) — the attacker must not learn the link exists...
    expect(res.statusCode).toBe(404);
    expect(res.body.message).toMatch(/Supplier not found/i);
    // ...and the victim's link is still there.
    expect(table('supplierProduct')).toHaveLength(1);
    expect(table('supplierProduct')[0].id).toBe(link.id);
  });

  it("rejects when the supplier is in-shop but the productId belongs to another shop", async () => {
    const supplier = seedSupplier({ shopId: 'shop_1' });
    const foreignProduct = seedProduct({ shopId: 'shop_2' });
    // A link forged across tenants (supplier in shop_1, product in shop_2).
    const link = seedSupplierProduct({ supplierId: supplier.id, productId: foreignProduct.id });

    const res = mockRes();
    await SupplierController.removeProduct(reqFor(supplier.id, foreignProduct.id, 'shop_1'), res);

    expect(res.statusCode).toBe(404);
    expect(res.body.message).toMatch(/Product not found/i);
    expect(table('supplierProduct')).toHaveLength(1);
    expect(table('supplierProduct')[0].id).toBe(link.id);
  });

  it('removes the link when both supplier and product belong to the caller shop', async () => {
    const supplier = seedSupplier({ shopId: 'shop_1' });
    const product = seedProduct({ shopId: 'shop_1' });
    seedSupplierProduct({ supplierId: supplier.id, productId: product.id });

    const res = mockRes();
    await SupplierController.removeProduct(reqFor(supplier.id, product.id, 'shop_1'), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(table('supplierProduct')).toHaveLength(0);
  });

  it('returns 404 when the (in-shop) supplier and product exist but no link does', async () => {
    const supplier = seedSupplier({ shopId: 'shop_1' });
    const product = seedProduct({ shopId: 'shop_1' });
    // No seedSupplierProduct — nothing to delete.

    const res = mockRes();
    await SupplierController.removeProduct(reqFor(supplier.id, product.id, 'shop_1'), res);

    expect(res.statusCode).toBe(404);
    expect(res.body.message).toMatch(/not linked/i);
  });
});
