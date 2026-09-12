import { describe, it, expect, beforeEach, vi } from 'vitest';

// auth.service imports YeboIDClient, which pulls in JwksValidator's network
// stack at module load. Stub it — these tests never touch YeboID.
vi.mock('@yebo/mcp-server', () => ({
  JwksValidator: vi.fn().mockImplementation(() => ({ verify: vi.fn() })),
  extractBearerToken: vi.fn(),
}));

import bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { resetDb, seedShop, seedUser } from '../test/prismaFake';

// Cost 4 instead of the production 12: these tests hash a dozen PINs and
// rounds-12 would add ~30s of pure CPU for no extra coverage. The code under
// test only ever calls bcrypt.compare, which is cost-agnostic.
const hash = (pin: string) => bcrypt.hash(pin, 4);

beforeEach(() => {
  resetDb();
});

describe('AuthService.loginUser — PIN is hashed, never compared as plaintext', () => {
  it('signs in a staff member whose stored PIN is a bcrypt hash', async () => {
    seedShop({ id: 'shop_1', name: 'Corner Shop' });
    seedUser({
      id: 'u1',
      shopId: 'shop_1',
      phone: '+26876000001',
      pin: await hash('1234'),
      name: 'Thandi',
      role: 'CASHIER',
    });

    const result = await AuthService.loginUser('+26876000001', '1234');

    expect(result.user?.id).toBe('u1');
    expect(result.shop.id).toBe('shop_1');
    expect(result.accessToken).toBeTruthy();
  });

  it('rejects the wrong PIN', async () => {
    seedShop({ id: 'shop_1' });
    seedUser({ shopId: 'shop_1', phone: '+26876000002', pin: await hash('1234') });

    await expect(AuthService.loginUser('+26876000002', '9999')).rejects.toThrow(
      'Invalid phone or PIN',
    );
  });

  it('rejects a PIN presented as plaintext-equal to the stored hash', async () => {
    // Guards the regression directly: if anyone reintroduces `user.pin === pin`,
    // passing the hash itself as the PIN would authenticate.
    seedShop({ id: 'shop_1' });
    const stored = await hash('1234');
    seedUser({ shopId: 'shop_1', phone: '+26876000003', pin: stored });

    await expect(AuthService.loginUser('+26876000003', stored)).rejects.toThrow(
      'Invalid phone or PIN',
    );
  });

  it('rejects an unknown phone without leaking that it is unknown', async () => {
    seedShop({ id: 'shop_1' });

    await expect(AuthService.loginUser('+26876999999', '1234')).rejects.toThrow(
      'Invalid phone or PIN',
    );
  });

  it('rejects a staff member with no PIN set', async () => {
    seedShop({ id: 'shop_1' });
    seedUser({ shopId: 'shop_1', phone: '+26876000004', pin: null });

    await expect(AuthService.loginUser('+26876000004', '1234')).rejects.toThrow(
      'Invalid phone or PIN',
    );
  });

  it('ignores deactivated staff', async () => {
    seedShop({ id: 'shop_1' });
    seedUser({
      shopId: 'shop_1',
      phone: '+26876000005',
      pin: await hash('1234'),
      isActive: false,
    });

    await expect(AuthService.loginUser('+26876000005', '1234')).rejects.toThrow(
      'Invalid phone or PIN',
    );
  });
});

describe('AuthService.loginUser — same phone across shops picks the right tenant', () => {
  it('routes to the shop whose PIN matches, not an arbitrary row', async () => {
    // The cross-tenant bug: User is unique on [shopId, phone], so one person
    // working two jobs has a row in each shop. findFirst returned whichever
    // row the planner produced.
    seedShop({ id: 'shop_a', name: 'Shop A' });
    seedShop({ id: 'shop_b', name: 'Shop B' });
    seedUser({ id: 'ua', shopId: 'shop_a', phone: '+26876001111', pin: await hash('1111') });
    seedUser({ id: 'ub', shopId: 'shop_b', phone: '+26876001111', pin: await hash('2222') });

    const a = await AuthService.loginUser('+26876001111', '1111');
    expect(a.shop.id).toBe('shop_a');
    expect(a.user?.id).toBe('ua');

    const b = await AuthService.loginUser('+26876001111', '2222');
    expect(b.shop.id).toBe('shop_b');
    expect(b.user?.id).toBe('ub');
  });

  it('refuses rather than guessing when phone AND PIN collide across shops', async () => {
    seedShop({ id: 'shop_a' });
    seedShop({ id: 'shop_b' });
    seedUser({ shopId: 'shop_a', phone: '+26876002222', pin: await hash('1234') });
    seedUser({ shopId: 'shop_b', phone: '+26876002222', pin: await hash('1234') });

    await expect(AuthService.loginUser('+26876002222', '1234')).rejects.toThrow(
      /more than one shop/,
    );
  });
});
