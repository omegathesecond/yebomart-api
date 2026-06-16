import { describe, it, expect, beforeEach, vi } from 'vitest';
import bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';
import { AdminController } from './admin.controller';
import { prismaFake, resetDb, seedShop, seedUser, seedAdmin, table } from '../test/prismaFake';

// admin.controller imports `prisma` from `@config/prisma`, which the vitest
// config aliases to the in-memory fake — so these controllers transparently
// hit prismaFake here. We spy on the fake's model methods to assert the exact
// `where` the controller builds (and that the SAME where is fed to count), and
// to prove the invalid-enum path short-circuits WITHOUT querying any rows.

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

function reqWith(query: Record<string, any>): any {
  return { query };
}

// The profile/password endpoints read the authenticated admin off req.user (set
// by authenticateAdmin) and the payload off req.body — no query params.
function reqAuth(user: any, body: Record<string, any> = {}): any {
  return { user, body };
}

beforeEach(() => {
  resetDb();
  vi.restoreAllMocks();
});

describe('AdminController.getShops — server-side filtering', () => {
  it('search builds the expected OR where and feeds the SAME where to count', async () => {
    const findMany = vi.spyOn(prismaFake.shop, 'findMany');
    const count = vi.spyOn(prismaFake.shop, 'count');

    await AdminController.getShops(reqWith({ search: 'acme' }), mockRes());

    expect(findMany).toHaveBeenCalledTimes(1);
    const where = findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { name: { contains: 'acme', mode: 'insensitive' } },
      { ownerName: { contains: 'acme', mode: 'insensitive' } },
      { ownerPhone: { contains: 'acme', mode: 'insensitive' } },
    ]);
    // The whole point of the fix: count gets the identical filter object so the
    // returned total matches the filtered page (not the whole table).
    expect(count).toHaveBeenCalledTimes(1);
    expect(count.mock.calls[0][0].where).toBe(where);
  });

  it('a valid status filter narrows the results (and total)', async () => {
    seedShop({ name: 'A', status: 'ACTIVE' });
    seedShop({ name: 'B', status: 'ACTIVE' });
    seedShop({ name: 'C', status: 'SUSPENDED' });

    const res = mockRes();
    await AdminController.getShops(reqWith({ status: 'active' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.shops).toHaveLength(2);
    expect(res.body.data.shops.every((s: any) => s.status === 'ACTIVE')).toBe(true);
  });

  it('an invalid status short-circuits to an empty page WITHOUT querying', async () => {
    const findMany = vi.spyOn(prismaFake.shop, 'findMany');
    const count = vi.spyOn(prismaFake.shop, 'count');

    const res = mockRes();
    await AdminController.getShops(reqWith({ status: 'GALAXY' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ shops: [], total: 0 });
    // A filter the DB can't satisfy must return nothing — not scan every row.
    expect(findMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it("treats status 'all' and an absent status as no filter", async () => {
    const findMany = vi.spyOn(prismaFake.shop, 'findMany');

    await AdminController.getShops(reqWith({ status: 'all' }), mockRes());
    expect(findMany.mock.calls[0][0].where).toEqual({});

    findMany.mockClear();

    await AdminController.getShops(reqWith({}), mockRes());
    expect(findMany.mock.calls[0][0].where).toEqual({});
  });
});

describe('AdminController.getUsers — server-side filtering', () => {
  it('search builds the expected OR where (incl. shop name) and feeds the SAME where to count', async () => {
    const findMany = vi.spyOn(prismaFake.user, 'findMany');
    const count = vi.spyOn(prismaFake.user, 'count');

    await AdminController.getUsers(reqWith({ search: 'jane' }), mockRes());

    expect(findMany).toHaveBeenCalledTimes(1);
    const where = findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { name: { contains: 'jane', mode: 'insensitive' } },
      { email: { contains: 'jane', mode: 'insensitive' } },
      { phone: { contains: 'jane', mode: 'insensitive' } },
      { shop: { is: { name: { contains: 'jane', mode: 'insensitive' } } } },
    ]);
    expect(count).toHaveBeenCalledTimes(1);
    expect(count.mock.calls[0][0].where).toBe(where);
  });

  it('a valid role filter narrows the results (and total)', async () => {
    seedUser({ name: 'Cashier 1', role: 'CASHIER' });
    seedUser({ name: 'Cashier 2', role: 'CASHIER' });
    seedUser({ name: 'Owner 1', role: 'OWNER' });

    const res = mockRes();
    await AdminController.getUsers(reqWith({ role: 'cashier' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.users).toHaveLength(2);
    expect(res.body.data.users.every((u: any) => u.role === 'CASHIER')).toBe(true);
  });

  it('an invalid role short-circuits to an empty page WITHOUT querying', async () => {
    const findMany = vi.spyOn(prismaFake.user, 'findMany');
    const count = vi.spyOn(prismaFake.user, 'count');

    const res = mockRes();
    await AdminController.getUsers(reqWith({ role: 'WIZARD' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ users: [], total: 0 });
    expect(findMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it("treats role 'all' and an absent role as no filter", async () => {
    const findMany = vi.spyOn(prismaFake.user, 'findMany');

    await AdminController.getUsers(reqWith({ role: 'all' }), mockRes());
    expect(findMany.mock.calls[0][0].where).toEqual({});

    findMany.mockClear();

    await AdminController.getUsers(reqWith({}), mockRes());
    expect(findMany.mock.calls[0][0].where).toEqual({});
  });
});

// Pagination wiring lives in the SAME getShops/getUsers methods as the filter
// logic above. The filter tests pin the `where`; these pin the offset window
// (skip/take), the ordering, and the page/limit echoed back to the client.
// Query params arrive as strings over HTTP, so we pass strings to prove the
// controller's Number() coercion actually runs.

describe('AdminController.getShops — pagination', () => {
  it('translates page/limit into skip=(page-1)*limit and take=limit on findMany', async () => {
    const findMany = vi.spyOn(prismaFake.shop, 'findMany');

    await AdminController.getShops(reqWith({ page: '3', limit: '10' }), mockRes());

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0][0];
    expect(args.skip).toBe(20); // (3 - 1) * 10
    expect(args.take).toBe(10);
  });

  it('orders by createdAt desc (newest first)', async () => {
    const findMany = vi.spyOn(prismaFake.shop, 'findMany');

    await AdminController.getShops(reqWith({}), mockRes());

    expect(findMany.mock.calls[0][0].orderBy).toEqual({ createdAt: 'desc' });
  });

  it('defaults to page 1 / limit 20 (skip 0, take 20) when params are absent', async () => {
    const findMany = vi.spyOn(prismaFake.shop, 'findMany');

    const res = mockRes();
    await AdminController.getShops(reqWith({}), res);

    const args = findMany.mock.calls[0][0];
    expect(args.skip).toBe(0); // (1 - 1) * 20
    expect(args.take).toBe(20);
    expect(res.body.data).toMatchObject({ page: 1, limit: 20 });
  });

  it('echoes the requested page/limit (as numbers) back in the response', async () => {
    const res = mockRes();
    await AdminController.getShops(reqWith({ page: '4', limit: '5' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ page: 4, limit: 5 });
  });
});

describe('AdminController.getUsers — pagination', () => {
  it('translates page/limit into skip=(page-1)*limit and take=limit on findMany', async () => {
    const findMany = vi.spyOn(prismaFake.user, 'findMany');

    await AdminController.getUsers(reqWith({ page: '3', limit: '10' }), mockRes());

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0][0];
    expect(args.skip).toBe(20); // (3 - 1) * 10
    expect(args.take).toBe(10);
  });

  it('orders by createdAt desc (newest first)', async () => {
    const findMany = vi.spyOn(prismaFake.user, 'findMany');

    await AdminController.getUsers(reqWith({}), mockRes());

    expect(findMany.mock.calls[0][0].orderBy).toEqual({ createdAt: 'desc' });
  });

  it('defaults to page 1 / limit 20 (skip 0, take 20) when params are absent', async () => {
    const findMany = vi.spyOn(prismaFake.user, 'findMany');

    const res = mockRes();
    await AdminController.getUsers(reqWith({}), res);

    const args = findMany.mock.calls[0][0];
    expect(args.skip).toBe(0); // (1 - 1) * 20
    expect(args.take).toBe(20);
    expect(res.body.data).toMatchObject({ page: 1, limit: 20 });
  });

  it('echoes the requested page/limit (as numbers) back in the response', async () => {
    const res = mockRes();
    await AdminController.getUsers(reqWith({ page: '4', limit: '5' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ page: 4, limit: 5 });
  });
});

// The Settings-page endpoints operate on the authenticated admin's OWN row
// (req.user.id), unlike the list endpoints above. These pin the happy paths and
// the two error mappings that are easy to regress: P2002 -> 409 on email clash,
// and a wrong current password -> 400 (never silently accepted).

describe('AdminController.getProfile', () => {
  it('returns the authenticated admin (without the password hash)', async () => {
    seedAdmin({ id: 'admin_1', email: 'boss@yebomart.com', name: 'Boss', role: 'SUPER_ADMIN' });

    const res = mockRes();
    await AdminController.getProfile(reqAuth({ id: 'admin_1' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      id: 'admin_1',
      email: 'boss@yebomart.com',
      name: 'Boss',
      role: 'SUPER_ADMIN',
      isActive: true,
    });
    // The controller's `select` must NOT leak the password hash to the client.
    expect(res.body.data.password).toBeUndefined();
  });

  it('returns 404 when the admin row no longer exists', async () => {
    const res = mockRes();
    await AdminController.getProfile(reqAuth({ id: 'ghost' }), res);

    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

describe('AdminController.updateProfile', () => {
  it('updates name and lower-cases the email', async () => {
    seedAdmin({ id: 'admin_1', email: 'old@yebomart.com', name: 'Old Name' });

    const res = mockRes();
    await AdminController.updateProfile(
      reqAuth({ id: 'admin_1' }, { name: 'New Name', email: 'New@Yebomart.COM' }),
      res
    );

    expect(res.statusCode).toBe(200);
    const stored = table('admin').find((a) => a.id === 'admin_1');
    expect(stored?.name).toBe('New Name');
    expect(stored?.email).toBe('new@yebomart.com');
  });

  it('maps a Prisma P2002 unique-constraint error to a 409 conflict', async () => {
    seedAdmin({ id: 'admin_1', email: 'me@yebomart.com' });

    // Simulate another admin already owning the target email: Prisma surfaces a
    // P2002 on the unique `email` column, which the controller must translate
    // to 409 (not a generic 500).
    vi.spyOn(prismaFake.admin, 'update').mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['email'] },
      })
    );

    const res = mockRes();
    await AdminController.updateProfile(
      reqAuth({ id: 'admin_1' }, { email: 'taken@yebomart.com' }),
      res
    );

    expect(res.statusCode).toBe(409);
    expect(res.body.success).toBe(false);
  });
});

describe('AdminController.changePassword', () => {
  it('rejects a wrong current password with 400 and leaves the hash untouched', async () => {
    const currentHash = await bcrypt.hash('correct-horse', 4);
    seedAdmin({ id: 'admin_1', password: currentHash });

    const res = mockRes();
    await AdminController.changePassword(
      reqAuth({ id: 'admin_1' }, { currentPassword: 'wrong-guess', newPassword: 'brand-new-pass' }),
      res
    );

    expect(res.statusCode).toBe(400);
    // The stored hash must be unchanged when the current password is wrong.
    expect(table('admin').find((a) => a.id === 'admin_1')?.password).toBe(currentHash);
  });

  it('bcrypt-rehashes the password on success (new hash verifies the new password)', async () => {
    const currentHash = await bcrypt.hash('correct-horse', 4);
    seedAdmin({ id: 'admin_1', password: currentHash });

    const res = mockRes();
    await AdminController.changePassword(
      reqAuth({ id: 'admin_1' }, { currentPassword: 'correct-horse', newPassword: 'brand-new-pass' }),
      res
    );

    expect(res.statusCode).toBe(200);
    const stored = table('admin').find((a) => a.id === 'admin_1')?.password as string;
    // It must be a fresh hash — not the old one, and not the plaintext.
    expect(stored).not.toBe(currentHash);
    expect(stored).not.toBe('brand-new-pass');
    await expect(bcrypt.compare('brand-new-pass', stored)).resolves.toBe(true);
  });
});
