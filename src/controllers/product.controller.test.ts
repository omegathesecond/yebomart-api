/**
 * Tests for ProductController — the catalog CRUD + barcode lookup + bulk
 * import/update + CSV export that every sale, stock movement and margin
 * report depends on. Focus areas: shop-scoping (a product never leaks across
 * tenants) and the bulk endpoints' created/updated/skipped/failed counters,
 * since those can mutate hundreds of rows in one call with no other net.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ProductController,
  createProductSchema,
  updateProductSchema,
  bulkImportSchema,
  bulkUpdateSchema,
} from './product.controller';
import { resetDb, seedShop, seedProduct, table } from '../test/prismaFake';

function mockRes() {
  const res: any = { statusCode: 200, body: undefined, headers: {} as Record<string, string> };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: any) => {
    res.body = body;
    return res;
  };
  res.setHeader = (name: string, value: string) => {
    res.headers[name] = value;
    return res;
  };
  res.send = (body?: any) => {
    if (body !== undefined) res.body = body;
    return res;
  };
  return res;
}

function req(overrides: Record<string, any> = {}): any {
  return {
    user: { id: 'user_1', shopId: 'shop_1', role: 'MANAGER', type: 'user' },
    params: {},
    query: {},
    body: {},
    ...overrides,
  };
}

beforeEach(() => {
  resetDb();
  seedShop({ id: 'shop_1', ownerYeboidSub: '11111111-1111-1111-1111-111111111111' });
  seedShop({ id: 'shop_2', ownerYeboidSub: '22222222-2222-2222-2222-222222222222' });
});

describe('ProductController.create', () => {
  it('creates a product scoped to the caller shop', async () => {
    const res = mockRes();

    await ProductController.create(
      req({ body: { name: 'Widget', costPrice: 5, sellPrice: 10 } }),
      res
    );

    expect(res.statusCode).toBe(201);
    expect(res.body.data.name).toBe('Widget');
    expect(res.body.data.shopId).toBe('shop_1');
    expect(table('product')).toHaveLength(1);
  });

  it('ignores a client-supplied shopId and always scopes to req.user.shopId', async () => {
    const res = mockRes();

    await ProductController.create(
      req({ body: { name: 'Widget', costPrice: 5, sellPrice: 10, shopId: 'shop_2' } }),
      res
    );

    expect(res.body.data.shopId).toBe('shop_1');
  });

  it('rejects a duplicate barcode within the same shop with 409', async () => {
    seedProduct({ shopId: 'shop_1', barcode: 'B1' });
    const res = mockRes();

    await ProductController.create(
      req({ body: { name: 'Another Widget', barcode: 'B1', costPrice: 5, sellPrice: 10 } }),
      res
    );

    expect(res.statusCode).toBe(409);
    expect(res.body.message).toMatch(/already exists/);
    expect(table('product')).toHaveLength(1);
  });

  it('allows the same barcode across different shops', async () => {
    seedProduct({ shopId: 'shop_2', barcode: 'B1' });
    const res = mockRes();

    await ProductController.create(
      req({ body: { name: 'Widget', barcode: 'B1', costPrice: 5, sellPrice: 10 } }),
      res
    );

    expect(res.statusCode).toBe(201);
    expect(table('product')).toHaveLength(2);
  });

  it('401s when there is no authenticated user', async () => {
    const res = mockRes();
    await ProductController.create(req({ user: undefined }), res);
    expect(res.statusCode).toBe(401);
  });
});

describe('createProductSchema — required-field validation', () => {
  it('requires name, costPrice and sellPrice', () => {
    const { error } = createProductSchema.validate({});
    expect(error).toBeDefined();
  });

  it('accepts a minimal valid payload', () => {
    const { error } = createProductSchema.validate({ name: 'Widget', costPrice: 5, sellPrice: 10 });
    expect(error).toBeUndefined();
  });

  it('rejects an invalid unit', () => {
    const { error } = createProductSchema.validate({
      name: 'Widget',
      costPrice: 5,
      sellPrice: 10,
      unit: 'gallon',
    });
    expect(error).toBeDefined();
  });
});

describe('ProductController.list', () => {
  it('never returns another shop\'s products', async () => {
    seedProduct({ shopId: 'shop_1', name: 'Mine' });
    seedProduct({ shopId: 'shop_2', name: 'Theirs' });
    const res = mockRes();

    await ProductController.list(req(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Mine');
  });

  it('paginates and reports metadata', async () => {
    for (let i = 0; i < 3; i++) seedProduct({ shopId: 'shop_1', name: `P${i}` });
    const res = mockRes();

    await ProductController.list(req({ query: { page: 1, limit: 2 } }), res);

    expect(res.body.data).toHaveLength(2);
    expect(res.body.metadata).toMatchObject({ total: 3, page: 1, limit: 2, hasNext: true });
  });

  it('filters by search term', async () => {
    seedProduct({ shopId: 'shop_1', name: 'Blue Widget' });
    seedProduct({ shopId: 'shop_1', name: 'Red Gadget' });
    const res = mockRes();

    await ProductController.list(req({ query: { search: 'widget' } }), res);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Blue Widget');
  });

  it('filters by category', async () => {
    seedProduct({ shopId: 'shop_1', name: 'A', category: 'Drinks' });
    seedProduct({ shopId: 'shop_1', name: 'B', category: 'Snacks' });
    const res = mockRes();

    await ProductController.list(req({ query: { category: 'Drinks' } }), res);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('A');
  });
});

describe('ProductController.getById', () => {
  it('returns the product for the caller shop', async () => {
    const p = seedProduct({ shopId: 'shop_1', name: 'Widget' });
    const res = mockRes();

    await ProductController.getById(req({ params: { id: p.id } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.id).toBe(p.id);
  });

  it('404s for a missing id', async () => {
    const res = mockRes();
    await ProductController.getById(req({ params: { id: 'does-not-exist' } }), res);
    expect(res.statusCode).toBe(404);
  });

  it('404s (does not leak) a product belonging to another shop', async () => {
    const p = seedProduct({ shopId: 'shop_2', name: 'Theirs' });
    const res = mockRes();

    await ProductController.getById(req({ params: { id: p.id } }), res);

    expect(res.statusCode).toBe(404);
  });
});

describe('ProductController.getByBarcode', () => {
  it('finds a product by barcode within the caller shop', async () => {
    seedProduct({ shopId: 'shop_1', barcode: 'B1', name: 'Widget' });
    const res = mockRes();

    await ProductController.getByBarcode(req({ params: { barcode: 'B1' } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.name).toBe('Widget');
  });

  it('404s for a barcode that does not exist', async () => {
    const res = mockRes();
    await ProductController.getByBarcode(req({ params: { barcode: 'NOPE' } }), res);
    expect(res.statusCode).toBe(404);
  });

  it('does not find a barcode that belongs to another shop', async () => {
    seedProduct({ shopId: 'shop_2', barcode: 'B1' });
    const res = mockRes();

    await ProductController.getByBarcode(req({ params: { barcode: 'B1' } }), res);

    expect(res.statusCode).toBe(404);
  });
});

describe('ProductController.update', () => {
  it('applies a partial update', async () => {
    const p = seedProduct({ shopId: 'shop_1', name: 'Widget', sellPrice: 10 });
    const res = mockRes();

    await ProductController.update(req({ params: { id: p.id }, body: { sellPrice: 15 } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.sellPrice).toBe(15);
    expect(res.body.data.name).toBe('Widget'); // untouched fields survive
  });

  it('rejects a cross-shop update with 404 and leaves the row untouched', async () => {
    const p = seedProduct({ shopId: 'shop_2', name: 'Theirs', sellPrice: 10 });
    const res = mockRes();

    await ProductController.update(req({ params: { id: p.id }, body: { sellPrice: 999 } }), res);

    expect(res.statusCode).toBe(404);
    expect(table('product')[0].sellPrice).toBe(10);
  });

  it('rejects a barcode update that collides with another product in the same shop', async () => {
    seedProduct({ shopId: 'shop_1', barcode: 'B1' });
    const p2 = seedProduct({ shopId: 'shop_1', barcode: 'B2' });
    const res = mockRes();

    await ProductController.update(req({ params: { id: p2.id }, body: { barcode: 'B1' } }), res);

    expect(res.statusCode).toBe(409);
  });
});

describe('updateProductSchema — partial payloads', () => {
  it('accepts an empty object (all fields optional)', () => {
    const { error } = updateProductSchema.validate({});
    expect(error).toBeUndefined();
  });

  it('rejects an invalid unit', () => {
    const { error } = updateProductSchema.validate({ unit: 'gallon' });
    expect(error).toBeDefined();
  });
});

describe('ProductController.delete', () => {
  it('soft-deletes by setting isActive = false, not removing the row', async () => {
    const p = seedProduct({ shopId: 'shop_1', isActive: true });
    const res = mockRes();

    await ProductController.delete(req({ params: { id: p.id } }), res);

    expect(res.statusCode).toBe(200);
    expect(table('product')).toHaveLength(1);
    expect(table('product')[0].isActive).toBe(false);
  });

  it('rejects a cross-shop delete with 404 and leaves the row active', async () => {
    const p = seedProduct({ shopId: 'shop_2', isActive: true });
    const res = mockRes();

    await ProductController.delete(req({ params: { id: p.id } }), res);

    expect(res.statusCode).toBe(404);
    expect(table('product')[0].isActive).toBe(true);
  });

  it('404s for a missing id', async () => {
    const res = mockRes();
    await ProductController.delete(req({ params: { id: 'does-not-exist' } }), res);
    expect(res.statusCode).toBe(404);
  });
});

describe('ProductController.getCategories', () => {
  it('returns distinct, sorted categories scoped to the caller shop', async () => {
    seedProduct({ shopId: 'shop_1', category: 'Snacks' });
    seedProduct({ shopId: 'shop_1', category: 'Drinks' });
    seedProduct({ shopId: 'shop_1', category: 'Snacks' }); // duplicate
    seedProduct({ shopId: 'shop_2', category: 'OtherShopCategory' });
    const res = mockRes();

    await ProductController.getCategories(req(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual(['Drinks', 'Snacks']);
  });

  it('excludes inactive products and null categories', async () => {
    seedProduct({ shopId: 'shop_1', category: 'Snacks', isActive: false });
    seedProduct({ shopId: 'shop_1', category: null });
    const res = mockRes();

    await ProductController.getCategories(req(), res);

    expect(res.body.data).toEqual([]);
  });
});

describe('ProductController.bulkImport', () => {
  it('creates new rows and updates existing ones matched by barcode when updateExisting=true', async () => {
    seedProduct({ shopId: 'shop_1', barcode: 'B1', name: 'Old Name', sellPrice: 10 });
    const res = mockRes();

    await ProductController.bulkImport(
      req({
        body: {
          updateExisting: true,
          products: [
            { barcode: 'B1', name: 'New Name', costPrice: 4, sellPrice: 12 },
            { barcode: 'B2', name: 'Brand New', costPrice: 3, sellPrice: 6 },
          ],
        },
      }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.data.created).toBe(1);
    expect(res.body.data.updated).toBe(1);
    expect(res.body.data.skipped).toBe(0);
    expect(table('product')).toHaveLength(2);
    expect(table('product').find((p) => p.barcode === 'B1').sellPrice).toBe(12);
  });

  it('skips existing rows when updateExisting=false', async () => {
    seedProduct({ shopId: 'shop_1', barcode: 'B1', name: 'Old Name', sellPrice: 10 });
    const res = mockRes();

    await ProductController.bulkImport(
      req({
        body: {
          updateExisting: false,
          products: [
            { barcode: 'B1', name: 'Attempted Overwrite', costPrice: 4, sellPrice: 999 },
            { barcode: 'B2', name: 'Brand New', costPrice: 3, sellPrice: 6 },
          ],
        },
      }),
      res
    );

    expect(res.body.data.created).toBe(1);
    expect(res.body.data.updated).toBe(0);
    expect(res.body.data.skipped).toBe(1);
    expect(table('product').find((p) => p.barcode === 'B1').sellPrice).toBe(10); // untouched
  });

  it('never touches another shop\'s products even on a barcode match', async () => {
    seedProduct({ shopId: 'shop_2', barcode: 'B1', name: 'Their Product', sellPrice: 999 });
    const res = mockRes();

    await ProductController.bulkImport(
      req({
        body: {
          updateExisting: true,
          products: [{ barcode: 'B1', name: 'My Product', costPrice: 1, sellPrice: 2 }],
        },
      }),
      res
    );

    // No match within shop_1, so this is a fresh create — shop_2's row is untouched.
    expect(res.body.data.created).toBe(1);
    expect(res.body.data.updated).toBe(0);
    expect(table('product')).toHaveLength(2);
    expect(table('product').find((p) => p.shopId === 'shop_2').sellPrice).toBe(999);
    expect(table('product').find((p) => p.shopId === 'shop_1').name).toBe('My Product');
  });
});

describe('bulkImportSchema — required-field validation', () => {
  it('requires at least one product with name/costPrice/sellPrice', () => {
    const { error } = bulkImportSchema.validate({ products: [] });
    expect(error).toBeDefined();
  });

  it('rejects a product row missing required fields', () => {
    const { error } = bulkImportSchema.validate({ products: [{ name: 'Widget' }] });
    expect(error).toBeDefined();
  });

  it('accepts a valid batch', () => {
    const { error } = bulkImportSchema.validate({
      products: [{ name: 'Widget', costPrice: 5, sellPrice: 10 }],
    });
    expect(error).toBeUndefined();
  });
});

describe('ProductController.bulkUpdate', () => {
  it('updates valid rows and fails rows with a bad product id', async () => {
    const p1 = seedProduct({ shopId: 'shop_1', sellPrice: 10 });
    const res = mockRes();

    await ProductController.bulkUpdate(
      req({
        body: {
          updates: [
            { id: p1.id, sellPrice: 20 },
            { id: 'does-not-exist', sellPrice: 30 },
          ],
        },
      }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.data.updated).toBe(1);
    expect(res.body.data.failed).toBe(1);
    expect(res.body.data.errors[0]).toMatchObject({ identifier: 'does-not-exist', error: 'Product not found' });
    expect(table('product').find((p) => p.id === p1.id).sellPrice).toBe(20);
  });

  it('rejects an update targeting a product in another shop (scoped as not found)', async () => {
    const other = seedProduct({ shopId: 'shop_2', sellPrice: 10 });
    const res = mockRes();

    await ProductController.bulkUpdate(
      req({ body: { updates: [{ id: other.id, sellPrice: 999 }] } }),
      res
    );

    expect(res.body.data.updated).toBe(0);
    expect(res.body.data.failed).toBe(1);
    expect(table('product')[0].sellPrice).toBe(10);
  });

  it('matches by barcode when no id is given', async () => {
    seedProduct({ shopId: 'shop_1', barcode: 'B1', quantity: 5 });
    const res = mockRes();

    await ProductController.bulkUpdate(
      req({ body: { updates: [{ barcode: 'B1', quantity: 50 }] } }),
      res
    );

    expect(res.body.data.updated).toBe(1);
    expect(table('product')[0].quantity).toBe(50);
  });
});

describe('bulkUpdateSchema — required-field validation', () => {
  it('requires each update to carry an id or a barcode', () => {
    const { error } = bulkUpdateSchema.validate({ updates: [{ sellPrice: 10 }] });
    expect(error).toBeDefined();
  });

  it('accepts an update identified by id alone', () => {
    const { error } = bulkUpdateSchema.validate({ updates: [{ id: 'p1', sellPrice: 10 }] });
    expect(error).toBeUndefined();
  });
});

describe('ProductController.exportCSV', () => {
  it('returns a CSV of only the requesting shop\'s active products', async () => {
    seedProduct({ shopId: 'shop_1', name: 'Mine', barcode: 'B1', costPrice: 5, sellPrice: 10, quantity: 3, reorderAt: 1, unit: 'each' });
    seedProduct({ shopId: 'shop_2', name: 'Theirs', barcode: 'B2' });
    const res = mockRes();

    await ProductController.exportCSV(req(), res);

    expect(res.headers['Content-Type']).toBe('text/csv');
    expect(res.headers['Content-Disposition']).toBe('attachment; filename=products.csv');
    expect(res.body).toContain('Mine');
    expect(res.body).not.toContain('Theirs');
  });

  it('excludes soft-deleted (inactive) products', async () => {
    seedProduct({ shopId: 'shop_1', name: 'Active Product', isActive: true, reorderAt: 5 });
    seedProduct({ shopId: 'shop_1', name: 'Inactive Product', isActive: false, reorderAt: 5 });
    const res = mockRes();

    await ProductController.exportCSV(req(), res);

    expect(res.body).toContain('Active Product');
    expect(res.body).not.toContain('Inactive Product');
  });

  it('returns just the header row when the shop has no products', async () => {
    const res = mockRes();

    await ProductController.exportCSV(req(), res);

    expect(res.body.split('\n')).toHaveLength(1);
    expect(res.body).toContain('barcode,name,category');
  });
});
