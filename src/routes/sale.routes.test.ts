import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import router from './sale.routes';
import { JWTUtil } from '../utils/jwt';
import { resetDb, seedShop, seedProduct, table } from '../test/prismaFake';

vi.mock('@yebo/mcp-server', () => ({
  extractBearerToken: (header?: string) => header?.replace(/^Bearer /, ''),
  JwksValidator: class { async verify() { throw new Error('Staff token'); } },
}));
beforeEach(() => { resetDb(); seedShop({ id: 'shop_1' }); });

async function request(method: string, path: string, body?: object) {
  const app = express();
  app.use(express.json());
  app.use('/sales', router);
  const server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const { port } = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${port}/sales${path}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${JWTUtil.generateAccessToken({ id: 'staff_1', shopId: 'shop_1', role: 'MANAGER', type: 'user' })}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

it('rejects invalid requests without usage and counts only one sale across HTTP replays', async () => {
  expect((await request('POST', '', {})).status).toBe(400);
  expect(table('shop')[0].monthlyTransactions ?? 0).toBe(0);
  const product = seedProduct({ shopId: 'shop_1', quantity: 10, sellPrice: 10 });
  const payload = { paymentMethod: 'CASH', localId: 'http-retry', amountPaid: 10,
    items: [{ productId: product.id, quantity: 1 }] };
  expect((await request('POST', '', payload)).status).toBe(201);
  expect((await request('POST', '', payload)).status).toBe(201);
  expect(table('sale')).toHaveLength(1);
  expect(table('shop')[0].monthlyTransactions).toBe(1);
});
