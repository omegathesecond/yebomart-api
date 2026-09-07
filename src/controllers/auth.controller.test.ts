import { describe, it, expect, beforeEach, vi } from 'vitest';

// auth.controller.ts validates YeboID access tokens via JwksValidator from
// '@yebo/mcp-server' (real JWKS network calls). Tests must never hit the
// network, so we intercept the class and drive its `verify()` per-test via
// this shared mock.
const verifyMock = vi.fn();
vi.mock('@yebo/mcp-server', () => ({
  JwksValidator: vi.fn().mockImplementation(() => ({ verify: verifyMock })),
  extractBearerToken: vi.fn(),
}));

import { AuthController } from './auth.controller';
import { resetDb, seedShop, seedUser, table } from '../test/prismaFake';

// Minimal Express req/res doubles, mirroring the pattern in
// user.controller.test.ts / customer.controller.test.ts.
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

beforeEach(() => {
  resetDb();
  verifyMock.mockReset();
});

describe('AuthController.yeboidExchange', () => {
  it('issues a session for a known/linked YeboID user (existing shop, no signup)', async () => {
    const shop = seedShop({ ownerYeboidSub: 'yeboid_owner_1', name: "Owner's Shop" });
    verifyMock.mockResolvedValueOnce({ userId: 'yeboid_owner_1' });
    const res = mockRes();

    await AuthController.yeboidExchange(
      { body: { accessToken: 'valid-yeboid-token' } } as any,
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.isNewShop).toBe(false);
    expect(res.body.data.shop.id).toBe(shop.id);
    expect(res.body.message).toBe('Signed in');
    // No new shop was created for the sign-in path.
    expect(table('shop')).toHaveLength(1);
  });

  it('rejects an invalid/expired YeboID access token with 401 and creates no shop', async () => {
    verifyMock.mockRejectedValueOnce(new Error('jwt expired'));
    const res = mockRes();

    await AuthController.yeboidExchange(
      { body: { accessToken: 'expired-or-bad-token' } } as any,
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Invalid or expired YeboID access token');
    expect(table('shop')).toHaveLength(0);
  });
});

describe('AuthController.userLogin — staff PIN login', () => {
  it('succeeds with the correct phone + PIN and issues an access token', async () => {
    const shop = seedShop();
    const user = seedUser({ phone: '+26878422613', pin: '1234', name: 'Cashier Jane' });
    const res = mockRes();

    await AuthController.userLogin(
      { body: { phone: '+26878422613', pin: '1234' } } as any,
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.id).toBe(user.id);
    expect(res.body.data.shop.id).toBe(shop.id);
    expect(typeof res.body.data.accessToken).toBe('string');
    // lastLoginAt is bumped on successful login.
    expect(table('user').find((u) => u.id === user.id)!.lastLoginAt).not.toBeNull();
  });

  it('rejects a wrong PIN with 401 and does not update lastLoginAt', async () => {
    seedShop();
    const user = seedUser({ phone: '+26878422613', pin: '1234' });
    const res = mockRes();

    await AuthController.userLogin(
      { body: { phone: '+26878422613', pin: '0000' } } as any,
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/Invalid/);
    expect(table('user').find((u) => u.id === user.id)!.lastLoginAt).toBeUndefined();
  });

  it('rejects a non-existent user/phone with 401', async () => {
    seedShop();
    const res = mockRes();

    await AuthController.userLogin(
      { body: { phone: '+26870000000', pin: '1234' } } as any,
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/Invalid/);
  });

  it('rejects a user with no PIN set (pin: null) with 401', async () => {
    seedShop();
    const user = seedUser({ phone: '+26878422613', pin: null });
    const res = mockRes();

    await AuthController.userLogin(
      { body: { phone: '+26878422613', pin: '1234' } } as any,
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
    expect(table('user').find((u) => u.id === user.id)!.lastLoginAt).toBeUndefined();
  });
});

describe('AuthController.getMe', () => {
  it("returns the shop owner's profile for a YeboID-authed request", async () => {
    const shop = seedShop({ ownerYeboidSub: 'yeboid_owner_2' });
    const res = mockRes();

    await AuthController.getMe(
      {
        user: { id: shop.id, shopId: shop.id, role: 'OWNER', type: 'shop' },
        yeboidUserId: 'yeboid_owner_2',
      } as any,
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.role).toBe('OWNER');
    expect(res.body.data.shop.id).toBe(shop.id);
  });

  it("returns the staff member's profile for a PIN-authed request", async () => {
    const shop = seedShop();
    const user = seedUser({ role: 'CASHIER' });
    const res = mockRes();

    await AuthController.getMe(
      { user: { id: user.id, shopId: shop.id, role: 'CASHIER', type: 'user' } } as any,
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.id).toBe(user.id);
    expect(res.body.data.shop.id).toBe(shop.id);
  });

  it('returns 401 when there is no authenticated user on the request', async () => {
    const res = mockRes();

    await AuthController.getMe({} as any, res);

    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Not authenticated');
  });

  it('returns 404 when the staff-token profile lookup finds no matching user', async () => {
    const res = mockRes();

    await AuthController.getMe(
      { user: { id: 'nonexistent_user_id', shopId: 'shop_1', role: 'CASHIER', type: 'user' } } as any,
      res,
    );

    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
