import { describe, it, expect, beforeEach, vi } from 'vitest';
import { requireAdminRole, requireSuperAdmin } from './auth.middleware';
import { resetDb, seedAdmin } from '../test/prismaFake';

// auth.middleware imports `prisma` from `@config/prisma`, which the vitest
// config aliases to the in-memory fake — so requireAdminRole transparently
// looks the admin up in prismaFake here. The security property under test is
// that the role/active-ness is re-read from the DB row, NOT trusted from the
// JWT-derived req.user.

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

function reqWith(user: any): any {
  return { user };
}

beforeEach(() => {
  resetDb();
  vi.restoreAllMocks();
});

describe('requireAdminRole', () => {
  it('calls next() when the admin record holds an allowed role', async () => {
    seedAdmin({ id: 'admin_super', role: 'SUPER_ADMIN' });
    const next = vi.fn();
    const res = mockRes();

    await requireSuperAdmin(reqWith({ id: 'admin_super', type: 'admin' }), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  it('rejects a SUPPORT admin from a SUPER_ADMIN-gated action with 403', async () => {
    seedAdmin({ id: 'admin_support', role: 'SUPPORT' });
    const next = vi.fn();
    const res = mockRes();

    await requireSuperAdmin(reqWith({ id: 'admin_support', type: 'admin' }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('re-reads the role from the DB — a stale-but-elevated token cannot escalate', async () => {
    // DB row is SUPPORT; the (forgeable/stale) token claims SUPER_ADMIN. The
    // middleware must trust the DB, not the token.
    seedAdmin({ id: 'admin_demoted', role: 'SUPPORT' });
    const next = vi.fn();
    const res = mockRes();

    await requireSuperAdmin(reqWith({ id: 'admin_demoted', type: 'admin', role: 'SUPER_ADMIN' }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('rejects a deactivated admin with 401 even with an otherwise-valid role', async () => {
    seedAdmin({ id: 'admin_off', role: 'SUPER_ADMIN', isActive: false });
    const next = vi.fn();
    const res = mockRes();

    await requireSuperAdmin(reqWith({ id: 'admin_off', type: 'admin' }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects when the admin row no longer exists with 401', async () => {
    const next = vi.fn();
    const res = mockRes();

    await requireSuperAdmin(reqWith({ id: 'ghost', type: 'admin' }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects a non-admin principal (wrong token type) with 401', async () => {
    seedAdmin({ id: 'admin_super', role: 'SUPER_ADMIN' });
    const next = vi.fn();
    const res = mockRes();

    // A shop/staff token carrying type !== 'admin' must never pass admin gating.
    await requireSuperAdmin(reqWith({ id: 'admin_super', type: 'shop' }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('admits ADMIN or SUPER_ADMIN when both are allowed (ADMIN+ write gate)', async () => {
    seedAdmin({ id: 'admin_plain', role: 'ADMIN' });
    const next = vi.fn();
    const res = mockRes();

    await requireAdminRole('SUPER_ADMIN', 'ADMIN')(reqWith({ id: 'admin_plain', type: 'admin' }), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });
});
