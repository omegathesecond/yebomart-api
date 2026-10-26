import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { Prisma } from '@prisma/client';
import router from './product.routes';
import { JWTUtil } from '../utils/jwt';
import { createProductSchema, updateProductSchema } from '../controllers/product.controller';
import { prisma, resetDb, seedProduct, table } from '../test/prismaFake';

vi.mock('@yebo/mcp-server', () => ({
  extractBearerToken: (header?: string) => header?.replace(/^Bearer /, ''),
  JwksValidator: class { async verify() { throw new Error('Staff token'); } },
}));
beforeEach(resetDb);

async function request(method: string, path: string, body?: object) {
  const app = express();
  app.use(express.json());
  app.use('/products', router);
  const server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const { port } = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}/products${path}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${JWTUtil.generateAccessToken({ id: 'staff_1', shopId: 'shop_1', role: 'MANAGER', type: 'user' })}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

const fields = {
  attributes: { brand: 'Acme', size: 10 },
  wholesalePrice: 0, wholesaleMinQty: 5, packPrice: 50, packSize: 6,
};
const base = { name: 'Soap', costPrice: 5, sellPrice: 10 };

describe('product optional fields through routes and service', () => {
  it.each([NaN, Infinity, -Infinity])('rejects nonfinite numeric values %s before persistence', value => {
    for (const schema of [createProductSchema, updateProductSchema]) {
      for (const invalid of [
        { wholesalePrice: value, wholesaleMinQty: 2 },
        { packPrice: value, packSize: 2 },
        { attributes: { size: value } },
      ]) {
        expect(schema.validate({ ...base, ...invalid }, { stripUnknown: true }).error).toBeDefined();
      }
    }
  });

  it('persists create and update and returns fields through all product reads', async () => {
    const created = await request('POST', '', { ...base, ...fields, barcode: '123' });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    expect(table('product')[0]).toMatchObject(fields);
    for (const path of [`/${id}`, '/barcode/123', '']) {
      const read = await request('GET', path);
      expect(read.status).toBe(200);
      expect(path === '' ? read.body.data[0] : read.body.data).toMatchObject(fields);
    }
    const changed = { attributes: { colour: 'Blue' }, wholesalePrice: 8, wholesaleMinQty: 10, packPrice: 40, packSize: 5 };
    expect((await request('PATCH', `/${id}`, changed)).status).toBe(200);
    expect((await request('GET', `/${id}`)).body.data).toMatchObject(changed);
    expect((await request('PATCH', `/${id}`, { name: 'Renamed' })).status).toBe(200);
    expect(table('product')[0]).toMatchObject({ ...changed, name: 'Renamed' });
  });

  it('clears attributes with Prisma SQL NULL and rules with null/null, while omission is a no-op', async () => {
    const product = seedProduct(fields);
    const update = vi.spyOn(prisma.product, 'update');
    const clear = { attributes: null, wholesalePrice: null, wholesaleMinQty: null, packPrice: null, packSize: null };
    expect((await request('PATCH', `/${product.id}`, clear)).status).toBe(200);
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ ...clear, attributes: Prisma.DbNull }) }));
    expect(table('product')[0]).toMatchObject({ attributes: null, wholesalePrice: null, wholesaleMinQty: null, packPrice: null, packSize: null });
    expect((await request('GET', `/${product.id}`)).body.data).toMatchObject(clear);
    update.mockRestore();
  });

  it('accepts empty attributes as replacement and omitted optional fields on create', async () => {
    expect((await request('POST', '', base)).status).toBe(201);
    const product = seedProduct(fields);
    expect((await request('PATCH', `/${product.id}`, { attributes: {} })).status).toBe(200);
    expect(table('product').find(p => p.id === product.id)?.attributes).toEqual({});
  });

  it.each([
    { wholesalePrice: -1, wholesaleMinQty: 2 },
    { wholesalePrice: 'Infinity', wholesaleMinQty: 2 },
    { wholesalePrice: '5', wholesaleMinQty: 2 },
    { wholesalePrice: 5 }, { wholesaleMinQty: 2 },
    { wholesalePrice: null, wholesaleMinQty: 2 },
    { wholesalePrice: 5, wholesaleMinQty: 0 },
    { wholesalePrice: 5, wholesaleMinQty: 1.5 },
    { packPrice: -1, packSize: 2 }, { packPrice: 5 }, { packSize: null },
    { packPrice: 5, packSize: 2147483648 },
    { packPrice: 5, packSize: 1.5 }, { packPrice: 5, packSize: 0 },
    { attributes: [] }, { attributes: { nested: {} } }, { attributes: { bool: true } },
    { attributes: { x: 'x'.repeat(501) } },
    { attributes: { ['x'.repeat(81)]: 'a' } },
    { attributes: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`a${i}`, 'x'])) },
    { attributes: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`a${i}`, 'x'.repeat(500)])) },
  ])('rejects invalid create/update case %# before any mutation', async invalid => {
    const product = seedProduct(fields);
    const before = structuredClone(table('product'));
    for (const [method, path, payload] of [
      ['POST', '', { ...base, ...invalid }],
      ['PATCH', `/${product.id}`, { name: 'Must not save', ...invalid }],
    ] as const) {
      const result = await request(method, path, payload);
      expect(result.status).toBe(400);
      expect(result.body.message).toBe('Validation failed');
      expect(table('product')).toEqual(before);
    }
  });
});
