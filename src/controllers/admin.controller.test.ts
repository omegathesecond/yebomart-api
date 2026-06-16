import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AdminController } from './admin.controller';
import { prismaFake, resetDb, seedShop, seedUser } from '../test/prismaFake';

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
