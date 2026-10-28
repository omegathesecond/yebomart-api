import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import router from './sale.routes';
import { JWTUtil } from '../utils/jwt';
import { resetDb, seedShop, seedUser, seedProduct, table } from '../test/prismaFake';

vi.mock('@yebo/mcp-server', () => ({
  extractBearerToken: (header?: string) => header?.replace(/^Bearer /, ''),
  JwksValidator: class { async verify() { throw new Error('Staff token'); } },
}));
beforeEach(resetDb);

it('rejects direct line and basket discounts before route usage or sale writes', async () => {
  const shop = seedShop({ monthlyTransactions: 0 });
  const staff = seedUser({ shopId: shop.id, canDiscount: false });
  const product = seedProduct({ shopId: shop.id, sellPrice: 10, quantity: 10 });
  const app = express();
  app.use(express.json());
  app.use('/sales', router);
  const server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const { port } = server.address() as { port: number };
    // Even a stale manager token cannot bypass the persisted cashier permission.
    const token = JWTUtil.generateAccessToken({ id: staff.id, shopId: shop.id, role: 'MANAGER', type: 'user' });
    for (const line of [true, false]) {
      const response = await fetch(`http://127.0.0.1:${port}/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ items: [{ productId: product.id, quantity: 1, discount: line ? 1 : 0 }],
          discount: line ? 0 : 1, amountPaid: 10, paymentMethod: 'CASH', localId: `offline-${line}` }),
      });
      expect(response.status).toBe(403);
      expect((await response.json() as any).message).toMatch(/permission to apply discounts/);
    }
    expect(table('shop')[0].monthlyTransactions).toBe(0);
    expect(table('product')[0].quantity).toBe(10);
    expect(table('sale')).toHaveLength(0);
    expect(table('stockLog')).toHaveLength(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
