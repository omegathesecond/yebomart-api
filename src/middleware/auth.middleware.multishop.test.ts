/**
 * authMiddleware's owner (YeboID) path resolves WHICH of the owner's
 * (possibly several) shops is active for a request:
 *   - no X-Shop-Id header -> the oldest shop (single-shop owners unaffected)
 *   - X-Shop-Id matching one of the owner's shops -> that shop
 *   - X-Shop-Id NOT belonging to the owner -> 403, never a silent fallback
 *     to a different shop's data
 *   - owner has no shop at all -> 401 (hasn't completed signup)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const verifyMock = vi.fn();
vi.mock('@yebo/mcp-server', () => ({
  JwksValidator: vi.fn().mockImplementation(() => ({ verify: verifyMock })),
  extractBearerToken: (header?: string) => header?.replace(/^Bearer\s+/i, '') ?? null,
}));

import { authMiddleware, AuthRequest } from './auth.middleware';
import { resetDb, seedShop } from '../test/prismaFake';
import { AuthService } from '../services/auth.service';

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

function reqWith(headers: Record<string, string>): AuthRequest {
  return { headers } as any;
}

beforeEach(() => {
  resetDb();
  verifyMock.mockReset();
});

describe('authMiddleware — multi-shop resolution for YeboID owner tokens', () => {
  it('resolves a single-shop owner to their one shop with no X-Shop-Id header (unaffected by this feature)', async () => {
    const shop = seedShop({ ownerYeboidSub: 'yeboid_mw_1', name: 'Only Shop' });
    verifyMock.mockResolvedValueOnce({ userId: 'yeboid_mw_1' });
    const next = vi.fn();
    const res = mockRes();
    const req: any = { headers: { authorization: 'Bearer valid-yeboid-token' } };

    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user.shopId).toBe(shop.id);
    expect(req.user.role).toBe('OWNER');
  });

  it('routes to the shop matching X-Shop-Id when it belongs to the owner', async () => {
    const first = seedShop({ ownerYeboidSub: 'yeboid_mw_2', name: 'First' });
    const second = await AuthService.createAdditionalShop('yeboid_mw_2', { name: 'Second' });
    verifyMock.mockResolvedValueOnce({ userId: 'yeboid_mw_2' });
    const next = vi.fn();
    const res = mockRes();
    const req: any = { headers: { authorization: 'Bearer valid-yeboid-token', 'x-shop-id': second.id } };

    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user.shopId).toBe(second.id);
    expect(req.user.shopId).not.toBe(first.id);
  });

  it('defaults to the oldest shop when X-Shop-Id header is absent, even with several shops', async () => {
    const first = seedShop({ ownerYeboidSub: 'yeboid_mw_3', name: 'Oldest' });
    await AuthService.createAdditionalShop('yeboid_mw_3', { name: 'Newer' });
    verifyMock.mockResolvedValueOnce({ userId: 'yeboid_mw_3' });
    const next = vi.fn();
    const res = mockRes();
    const req: any = { headers: { authorization: 'Bearer valid-yeboid-token' } };

    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user.shopId).toBe(first.id);
  });

  it('403s — never falls back silently — when X-Shop-Id does not belong to this owner', async () => {
    seedShop({ ownerYeboidSub: 'yeboid_mw_4', name: 'Mine' });
    const someoneElsesShop = seedShop({ ownerYeboidSub: 'yeboid_other', name: "Not Mine" });
    verifyMock.mockResolvedValueOnce({ userId: 'yeboid_mw_4' });
    const next = vi.fn();
    const res = mockRes();
    const req: any = {
      headers: { authorization: 'Bearer valid-yeboid-token', 'x-shop-id': someoneElsesShop.id },
    };

    await authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(req.user).toBeUndefined();
  });

  it('401s when the YeboID token is valid but the owner has no shop yet', async () => {
    verifyMock.mockResolvedValueOnce({ userId: 'yeboid_never_signed_up' });
    const next = vi.fn();
    const res = mockRes();

    await authMiddleware(reqWith({ authorization: 'Bearer valid-yeboid-token' }) as any, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body.message).toMatch(/Complete signup/);
  });
});
