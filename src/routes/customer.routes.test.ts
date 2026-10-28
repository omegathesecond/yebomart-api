import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import router from './customer.routes';
import { UserService } from '../services/user.service';
import { JWTUtil } from '../utils/jwt';
import { CustomerController } from '../controllers/customer.controller';
import { resetDb, seedUser, seedCustomer, table } from '../test/prismaFake';

// Exercise real staff authentication and manager authorization without fetching JWKS.
vi.mock('@yebo/mcp-server', () => ({
  extractBearerToken: (header?: string) => header?.replace(/^Bearer /, ''),
  JwksValidator: class {
    async verify() { throw new Error('Staff token'); }
  },
}));

beforeEach(resetDb);

async function patch(id: string, body: object, role: 'MANAGER' | 'CASHIER' = 'MANAGER', issuedToken?: string) {
  const app = express();
  app.use(express.json());
  app.use('/api/customers', router);
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const address = server.address() as { port: number };
    if (!issuedToken) seedUser({ id: 'staff_1', shopId: 'shop_1', role, isActive: true });
    const token = issuedToken ?? JWTUtil.generateAccessToken({ id: 'staff_1', shopId: 'shop_1', role, type: 'user' });
    const response = await fetch(`http://127.0.0.1:${address.port}/api/customers/${id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe('PATCH /api/customers/:id', () => {
  it.each([
    { balance: 0 }, { shopId: 'shop_2' }, { id: 'replacement' },
    { createdAt: '2026-01-01' }, { updatedAt: '2026-01-01' },
    { shop: { connect: { id: 'shop_2' } } }, { credits: { deleteMany: {} } },
    { sales: { deleteMany: {} } }, { unknown: true },
    { creditLimit: -1 }, { creditLimit: 'invalid' }, { email: 'invalid' },
    { name: ' ' }, { name: 'x' }, { name: 'x'.repeat(101) },
  ])('rejects unsafe or invalid input %j without any mutation', async (payload) => {
    const customer = seedCustomer({ balance: 80, creditLimit: 150 });
    const before = structuredClone(table('customer'));
    const response = await patch(customer.id, { name: 'Changed', ...payload });
    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Validation failed');
    expect(table('customer')).toEqual(before);
    expect(table('customerCredit')).toEqual([]);
  });

  it('blocks cashiers', async () => {
    const customer = seedCustomer();
    const before = structuredClone(table('customer'));
    expect((await patch(customer.id, { name: 'Changed' }, 'CASHIER')).status).toBe(403);
    expect(table('customer')).toEqual(before);
    expect(table('customerCredit')).toEqual([]);
  });

  it('returns a clear 404 for a customer outside the active shop', async () => {
    const customer = seedCustomer({ shopId: 'shop_2' });
    const before = structuredClone(table('customer'));
    const response = await patch(customer.id, { name: 'Changed' });
    expect(response.status).toBe(404);
    expect(response.body.message).toBe('Customer not found');
    expect(table('customer')).toEqual(before);
  });

  it('preserves omitted fields, including the existing credit limit', async () => {
    const customer = seedCustomer({ phone: '+26878422613', email: 'test@example.com', address: 'Main St', balance: 80, creditLimit: 150 });
    expect((await patch(customer.id, { name: '  New Name  ' })).status).toBe(200);
    expect(table('customer')[0]).toMatchObject({ ...customer, name: 'New Name' });
    expect((await patch(customer.id, { creditLimit: 0, isActive: false })).status).toBe(200);
    expect(table('customer')[0]).toMatchObject({ name: 'New Name', creditLimit: 0, isActive: false, balance: 80 });
    expect(table('customerCredit')).toEqual([]);
  });

  it('allowlists fields even when the controller is called directly', async () => {
    const customer = seedCustomer({ balance: 80 });
    const res: any = { status: () => res, json: () => res };
    await CustomerController.update({ user: { shopId: 'shop_1' }, params: { id: customer.id }, body: { name: 'Changed', balance: 0, shopId: 'shop_2' } } as any, res);
    expect(table('customer')[0]).toMatchObject({ name: 'Changed', balance: 80, shopId: 'shop_1' });
    expect(table('customerCredit')).toEqual([]);
  });
});


describe('live staff authority on customer write routes', () => {
  it.each(['deactivation', 'soft deletion', 'demotion'] as const)('rejects a previously admitted token after %s', async change => {
    const customer = seedCustomer();
    seedUser({ id: 'staff_1', shopId: 'shop_1', role: 'MANAGER', isActive: true });
    seedUser({ id: 'other', shopId: 'shop_1', phone: '+26876000009', isActive: true });
    const token = JWTUtil.generateAccessToken({ id: 'staff_1', shopId: 'shop_1', role: 'MANAGER', type: 'user' });
    expect((await patch(customer.id, { name: 'Before change' }, 'MANAGER', token)).status).toBe(200);
    if (change === 'soft deletion') await UserService.delete('staff_1', 'shop_1');
    else await UserService.update('staff_1', 'shop_1', change === 'demotion' ? { role: 'CASHIER' } : { isActive: false });
    const before = structuredClone(table('customer'));
    expect((await patch(customer.id, { name: 'Unauthorized change' }, 'MANAGER', token)).status).toBe(change === 'demotion' ? 403 : 401);
    expect(table('customer')).toEqual(before);
  });
});
