import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyOwner } = vi.hoisted(() => ({ verifyOwner: vi.fn() }));
vi.mock('@yebo/mcp-server', () => ({
  JwksValidator: class { verify = verifyOwner; },
  extractBearerToken: (header?: string) => header?.startsWith('Bearer ') ? header.slice(7) : null,
}));

import { authMiddleware, optionalAuth, managerAuth, staffAuth, authenticateAdmin } from './auth.middleware';
import { JWTUtil, ITokenPayload } from '../utils/jwt';
import { prisma, resetDb, seedShop, seedUser } from '../test/prismaFake';
import { UserService } from '../services/user.service';

function issue(overrides: Partial<ITokenPayload> = {}) {
  return JWTUtil.generateAccessToken({ id: 'staff', shopId: 'shop', role: 'MANAGER', type: 'user', ...overrides });
}
async function request(middleware: any, token?: string) {
  const req: any = { headers: token ? { authorization: `Bearer ${token}` } : {} };
  const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this; },
    json(body: any) { this.body = body; return this; } };
  const next = vi.fn();
  await middleware(req, res, next);
  return { req, res, next };
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetDb();
  verifyOwner.mockReset().mockRejectedValue(new Error('Not YeboID'));
  seedShop({ id: 'shop', ownerYeboidSub: 'owner' });
  seedUser({ id: 'staff', shopId: 'shop', role: 'MANAGER', isActive: true });
  seedUser({ id: 'other', shopId: 'shop', phone: '+26876000002', isActive: true });
});

describe.each([['protected', staffAuth], ['optional', optionalAuth]] as const)('%s staff authentication', (_, middleware) => {
  it.each(['deactivation', 'soft deletion'] as const)('rejects the same issued token after %s', async (change) => {
    const token = issue();
    expect((await request(middleware, token)).next).toHaveBeenCalledOnce();
    if (change === 'deactivation') await UserService.update('staff', 'shop', { isActive: false });
    else await UserService.delete('staff', 'shop');
    const result = await request(middleware, token);
    expect(result.res.statusCode).toBe(401);
    expect(result.next).not.toHaveBeenCalled();
    expect(result.req.user).toBeUndefined();
  });

  it('uses the current role and identity fields', async () => {
    const token = issue();
    await UserService.update('staff', 'shop', { role: 'CASHIER', phone: '+26876000003' });
    const result = await request(middleware, token);
    expect(result.next).toHaveBeenCalledOnce();
    expect(result.req.user).toMatchObject({ role: 'CASHIER', phone: '+26876000003' });
  });

  it.each([{ id: 'missing' }, { shopId: 'foreign' }, { type: 'admin' }, { type: 'shop' }, { shopId: '' }])(
    'rejects missing staff or invalid scope %j', async (claims) => {
      const result = await request(middleware, issue(claims as Partial<ITokenPayload>));
      expect(result.res.statusCode).toBe(401);
      expect(result.next).not.toHaveBeenCalled();
    },
  );

  it('rejects a staff row with an owner role', async () => {
    await UserService.update('staff', 'shop', { role: 'OWNER' });
    expect((await request(middleware, issue())).res.statusCode).toBe(401);
  });

  it('fails loudly when storage is unavailable', async () => {
    vi.spyOn(prisma.user, 'findFirst').mockRejectedValueOnce(new Error('Database unavailable'));
    const result = await request(middleware, issue());
    expect(result.res.statusCode).toBe(500);
    expect(result.next).not.toHaveBeenCalled();
    expect(result.req.user).toBeUndefined();
  });

  it('preserves YeboID owner authentication', async () => {
    verifyOwner.mockResolvedValueOnce({ userId: 'owner' });
    const result = await request(middleware, 'yeboid-token');
    expect(result.next).toHaveBeenCalledOnce();
    expect(result.req.user).toMatchObject({ id: 'shop', role: 'OWNER', type: 'shop' });
  });

  it('does not fall through on owner storage errors', async () => {
    verifyOwner.mockResolvedValueOnce({ userId: 'owner' });
    vi.spyOn(prisma.shop, 'findUnique').mockRejectedValueOnce(new Error('Database unavailable'));
    const result = await request(middleware, issue());
    expect(result.res.statusCode).toBe(500);
    expect(result.next).not.toHaveBeenCalled();
  });
});

it('removes manager endpoint access immediately after demotion with the same token', async () => {
  const token = issue();
  expect((await request(managerAuth, token)).next).toHaveBeenCalledOnce();
  await UserService.update('staff', 'shop', { role: 'CASHIER' });
  const result = await request(managerAuth, token);
  expect(result.res.statusCode).toBe(403);
  expect(result.next).not.toHaveBeenCalled();
  expect((await request(staffAuth, token)).next).toHaveBeenCalledOnce();
});

it('permits anonymous optional auth and requires credentials on protected routes', async () => {
  expect((await request(optionalAuth)).next).toHaveBeenCalledOnce();
  expect((await request(authMiddleware)).res.statusCode).toBe(401);
});

it('preserves separate admin authentication', async () => {
  const token = JWTUtil.generateAdminToken({ id: 'admin', email: 'admin@example.test', role: 'ADMIN', type: 'admin' });
  expect((await request(authenticateAdmin, token)).next).toHaveBeenCalledOnce();
  expect((await request(authMiddleware, token)).res.statusCode).toBe(401);
});

it('rejects invalid signatures and refresh tokens on protected and optional routes', async () => {
  const refresh = JWTUtil.generateRefreshToken({ id: 'staff', shopId: 'shop', role: 'MANAGER', type: 'user' });
  for (const middleware of [authMiddleware, optionalAuth]) {
    for (const token of ['invalid-token', refresh]) {
      const result = await request(middleware, token);
      expect(result.res.statusCode).toBe(401);
      expect(result.next).not.toHaveBeenCalled();
    }
  }
});
