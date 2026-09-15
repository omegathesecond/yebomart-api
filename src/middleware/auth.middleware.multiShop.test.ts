/**
 * Tests for authMiddleware/optionalAuth's active-shop resolution — the core
 * of multi-shop support. A YeboID owner can now own several Shop rows; these
 * middlewares decide WHICH one a request acts on from the X-Shop-Id header
 * (defaulting to the owner's oldest shop when absent), and must hard-reject
 * (never silently fall back) when the header names a shop the caller doesn't
 * own.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// authMiddleware verifies YeboID tokens via JwksValidator from
// '@yebo/mcp-server' (real JWKS network calls in prod). Stub verify() to
// resolve the bearer token string itself as the YeboID `sub`, so tests can
// drive it without touching the network.
vi.mock('@yebo/mcp-server', () => ({
  JwksValidator: vi.fn().mockImplementation(() => ({
    verify: vi.fn().mockImplementation(async (token: string) => {
      if (token.startsWith('yeboid:')) return { userId: token.slice('yeboid:'.length) };
      throw new Error('not a YeboID token');
    }),
  })),
  extractBearerToken: (header?: string) => header?.replace(/^Bearer\s+/i, '') ?? null,
}));

import { authMiddleware, optionalAuth } from './auth.middleware';
import { resetDb, seedShop } from '../test/prismaFake';

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

function reqWith(token: string, shopIdHeader?: string): any {
  return {
    headers: {
      authorization: `Bearer ${token}`,
      ...(shopIdHeader !== undefined ? { 'x-shop-id': shopIdHeader } : {}),
    },
  };
}

beforeEach(() => {
  resetDb();
});

describe('authMiddleware — multi-shop active-shop resolution', () => {
  it('with no X-Shop-Id header, resolves to the owner’s OLDEST shop', async () => {
    const older = seedShop({ ownerYeboidSub: 'owner_1', createdAt: new Date('2026-01-01') });
    seedShop({ ownerYeboidSub: 'owner_1', createdAt: new Date('2026-02-01') });
    const req = reqWith('yeboid:owner_1');
    const res = mockRes();
    const next = vi.fn();

    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user.shopId).toBe(older.id);
    expect(req.user.role).toBe('OWNER');
  });

  it('with a valid X-Shop-Id header, resolves to that specific shop', async () => {
    seedShop({ ownerYeboidSub: 'owner_2', createdAt: new Date('2026-01-01') });
    const second = seedShop({ ownerYeboidSub: 'owner_2', createdAt: new Date('2026-02-01') });
    const req = reqWith('yeboid:owner_2', second.id);
    const res = mockRes();
    const next = vi.fn();

    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user.shopId).toBe(second.id);
  });

  it('rejects with 403 when X-Shop-Id names a shop this owner does not own (never silently falls back)', async () => {
    seedShop({ ownerYeboidSub: 'owner_3' });
    const foreignShop = seedShop({ ownerYeboidSub: 'someone_else' });
    const req = reqWith('yeboid:owner_3', foreignShop.id);
    const res = mockRes();
    const next = vi.fn();

    await authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('rejects with 401 when the YeboID owner has no shop at all', async () => {
    const req = reqWith('yeboid:owner_with_no_shop');
    const res = mockRes();
    const next = vi.fn();

    await authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('single-shop owners are unaffected: no header still resolves to their one shop', async () => {
    const shop = seedShop({ ownerYeboidSub: 'solo_owner' });
    const req = reqWith('yeboid:solo_owner');
    const res = mockRes();
    const next = vi.fn();

    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user.shopId).toBe(shop.id);
  });
});

describe('optionalAuth — multi-shop active-shop resolution', () => {
  it('calls next() with no req.user when no token is provided', async () => {
    const req: any = { headers: {} };
    const res = mockRes();
    const next = vi.fn();

    await optionalAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
  });

  it('populates req.user for a valid token with no shop header (default oldest shop)', async () => {
    const shop = seedShop({ ownerYeboidSub: 'owner_4' });
    const req = reqWith('yeboid:owner_4');
    const res = mockRes();
    const next = vi.fn();

    await optionalAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user.shopId).toBe(shop.id);
  });

  it('rejects with 403 (does not silently continue as unauthenticated) on a foreign X-Shop-Id', async () => {
    seedShop({ ownerYeboidSub: 'owner_5' });
    const foreignShop = seedShop({ ownerYeboidSub: 'someone_else_2' });
    const req = reqWith('yeboid:owner_5', foreignShop.id);
    const res = mockRes();
    const next = vi.fn();

    await optionalAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
