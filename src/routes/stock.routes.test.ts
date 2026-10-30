import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import router from './stock.routes';
import { JWTUtil } from '../utils/jwt';
import { resetDb, seedShop, seedUser, seedProduct, table } from '../test/prismaFake';

vi.mock('@yebo/mcp-server', () => ({
  extractBearerToken: (header?: string) => header?.replace(/^Bearer /, ''),
  JwksValidator: class { async verify() { throw new Error('Staff token'); } },
}));
beforeEach(resetDb);

it('counts accepted stock movements once and rejects validation without usage', async () => {
  const shop = seedShop({ monthlyStockMoves: 0 });
  const staff = seedUser({ shopId: shop.id, role: 'MANAGER' });
  const product = seedProduct({ shopId: shop.id, quantity: 10 });
  const app = express();
  app.use(express.json());
  app.use('/stock', router);
  const server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const { port } = server.address() as { port: number };
    const token = JWTUtil.generateAccessToken({ id: staff.id, shopId: shop.id, role: 'MANAGER', type: 'user' });
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}/stock/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      await response.json();
      return response.status;
    };
    expect(await post('receive', { items: [{ productId: product.id, quantity: 0 }] })).toBe(400);
    expect(table('shop')[0].monthlyStockMoves).toBe(0);
    expect(await post('adjust', { productId: product.id, type: 'ADJUSTMENT', quantity: 2 })).toBe(200);
    expect(table('shop')[0].monthlyStockMoves).toBe(1);
    expect(await post('receive', { items: [{ productId: product.id, quantity: 3 }] })).toBe(200);
    expect(table('shop')[0].monthlyStockMoves).toBe(2);
    expect(table('product')[0].quantity).toBe(15);
    expect(table('stockLog')).toHaveLength(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
