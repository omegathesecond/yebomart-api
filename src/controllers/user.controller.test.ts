import { describe, it, expect, beforeEach } from 'vitest';
import { UserController } from './user.controller';
import { resetDb, seedUser, table } from '../test/prismaFake';

// Minimal Express req/res doubles. The controller only touches the fields set
// here; res records status + JSON body for assertions. Mirrors the doubles in
// customer.controller.test.ts.
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

// `actingId` is the authenticated caller's user id (req.user.id); `targetId`
// is the :id being edited. Role defaults to CASHIER — the escalation actor.
function updateReq(
  actingId: string,
  targetId: string,
  body: Record<string, any>,
  role: 'OWNER' | 'MANAGER' | 'CASHIER' = 'CASHIER',
): any {
  return {
    user: { id: actingId, shopId: 'shop_1', role },
    params: { id: targetId },
    body,
  };
}

beforeEach(() => {
  resetDb();
});

describe('UserController.update — privilege-escalation guard', () => {
  it('an OWNER can update another user (incl. role + permission flags)', async () => {
    const staff = seedUser({ name: 'Cashier', role: 'CASHIER', canDiscount: false });
    const res = mockRes();

    await UserController.update(
      updateReq('shop_1', staff.id, { role: 'MANAGER', canDiscount: true }, 'OWNER'),
      res,
    );

    expect(res.statusCode).toBe(200);
    const row = table('user').find((u) => u.id === staff.id)!;
    expect(row.role).toBe('MANAGER');
    expect(row.canDiscount).toBe(true);
  });

  it('a CASHIER updating ANOTHER user is rejected with 403 and no write occurs', async () => {
    const me = seedUser({ name: 'Me', role: 'CASHIER' });
    const victim = seedUser({ name: 'Victim', role: 'CASHIER', canVoid: false });
    const res = mockRes();

    await UserController.update(
      updateReq(me.id, victim.id, { canVoid: true }, 'CASHIER'),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(res.body.success).toBe(false);
    // Nothing changed on the victim row.
    expect(table('user').find((u) => u.id === victim.id)!.canVoid).toBe(false);
  });

  it('a CASHIER escalating their OWN permissions is rejected with 403 and no write occurs', async () => {
    const me = seedUser({
      name: 'Me',
      role: 'CASHIER',
      canDiscount: false,
      canVoid: false,
      canViewReports: false,
      canManageStock: false,
    });
    const res = mockRes();

    // Self-edit (params.id === user.id) but touching privileged fields.
    await UserController.update(
      updateReq(me.id, me.id, { canDiscount: true, canViewReports: true }, 'CASHIER'),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(res.body.success).toBe(false);
    // The escalation did NOT persist.
    const row = table('user').find((u) => u.id === me.id)!;
    expect(row.canDiscount).toBe(false);
    expect(row.canViewReports).toBe(false);
  });

  it('a CASHIER promoting their OWN role is rejected with 403 and no write occurs', async () => {
    const me = seedUser({ name: 'Me', role: 'CASHIER' });
    const res = mockRes();

    await UserController.update(
      updateReq(me.id, me.id, { role: 'MANAGER' }, 'CASHIER'),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(table('user').find((u) => u.id === me.id)!.role).toBe('CASHIER');
  });

  it('a CASHIER reactivating themselves (isActive) is rejected with 403', async () => {
    const me = seedUser({ name: 'Me', role: 'CASHIER', isActive: false });
    const res = mockRes();

    await UserController.update(
      updateReq(me.id, me.id, { isActive: true }, 'CASHIER'),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(table('user').find((u) => u.id === me.id)!.isActive).toBe(false);
  });

  it('a CASHIER may still edit their OWN non-privileged profile (name)', async () => {
    const me = seedUser({ name: 'Old Name', role: 'CASHIER' });
    const res = mockRes();

    await UserController.update(
      updateReq(me.id, me.id, { name: 'New Name' }, 'CASHIER'),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(table('user').find((u) => u.id === me.id)!.name).toBe('New Name');
  });
});
