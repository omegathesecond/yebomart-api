/**
 * Multi-shop support: one YeboID owner (ownerYeboidSub) can now own more than
 * one Shop row. Covers:
 *   - createAdditionalShop: carries owner identity over from the existing
 *     shop, defaults country/business type, rejects when the caller has no
 *     shop yet (never signed up).
 *   - listShopsForOwner: returns every shop for the owner, oldest first.
 *   - signInWithYeboID: with several shops for the same owner, sign-in
 *     resolves to the OLDEST one — an existing single-shop owner's sign-in
 *     is unaffected by this feature existing.
 *   - Data isolation: products (and by the same shopId-scoping pattern,
 *     every other shop-scoped resource) created under one shop never appear
 *     under a sibling shop owned by the same person.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// auth.service imports YeboIDClient, which pulls in JwksValidator's network
// stack at module load. Stub it — these tests never touch YeboID except via
// the explicit YeboIDClient.getUserInfo mock in the first-signup test.
vi.mock('@yebo/mcp-server', () => ({
  JwksValidator: vi.fn().mockImplementation(() => ({ verify: vi.fn() })),
  extractBearerToken: vi.fn(),
}));

import { AuthService } from './auth.service';
import { resetDb, seedShop, seedProduct, table } from '../test/prismaFake';
import { prisma } from '@config/prisma';

beforeEach(() => {
  resetDb();
});

describe('AuthService.createAdditionalShop', () => {
  it('creates a second shop under the same yeboidSub, carrying owner identity over', async () => {
    const first = seedShop({
      ownerYeboidSub: 'yeboid_multi_1',
      name: 'First Shop',
      ownerName: 'Thandi Dlamini',
      ownerPhone: '+26876111111',
      ownerEmail: 'thandi@example.com',
      countryCode: 'SZ',
      phoneCountryCode: '+268',
    });

    const second = await AuthService.createAdditionalShop('yeboid_multi_1', {
      name: 'Second Shop',
      businessType: 'tuckshop',
    });

    expect(second.id).not.toBe(first.id);
    expect(second.ownerYeboidSub).toBe('yeboid_multi_1');
    // Owner identity is copied from the existing shop, not re-collected.
    expect(second.ownerName).toBe('Thandi Dlamini');
    expect(second.ownerPhone).toBe('+26876111111');
    expect(second.ownerEmail).toBe('thandi@example.com');
    expect(second.businessType).toBe('tuckshop');
    expect(table('shop')).toHaveLength(2);
  });

  it('rejects when the caller has no existing shop (never completed signup)', async () => {
    await expect(
      AuthService.createAdditionalShop('yeboid_no_shop_yet', { name: 'Orphan Shop' }),
    ).rejects.toThrow(/No existing shop found/);
    expect(table('shop')).toHaveLength(0);
  });
});

describe('AuthService.listShopsForOwner', () => {
  it("lists every shop the owner has, oldest first, each tagged role 'OWNER'", async () => {
    seedShop({ ownerYeboidSub: 'yeboid_multi_2', name: 'Alpha Shop', createdAt: new Date('2026-01-01') });
    await AuthService.createAdditionalShop('yeboid_multi_2', { name: 'Beta Shop' });

    const shops = await AuthService.listShopsForOwner('yeboid_multi_2');

    expect(shops).toHaveLength(2);
    expect(shops[0].name).toBe('Alpha Shop');
    expect(shops[1].name).toBe('Beta Shop');
    expect(shops.every((s) => s.role === 'OWNER')).toBe(true);
  });

  it('returns an empty list for a YeboID sub with no shops', async () => {
    const shops = await AuthService.listShopsForOwner('yeboid_nobody');
    expect(shops).toEqual([]);
  });
});

describe('AuthService.signInWithYeboID — existing single-shop owners unaffected', () => {
  it('sign-in resolves to the OLDEST shop when the owner has several', async () => {
    const oldest = seedShop({
      ownerYeboidSub: 'yeboid_multi_3',
      name: 'Original Shop',
      createdAt: new Date('2026-01-01'),
    });
    await AuthService.createAdditionalShop('yeboid_multi_3', { name: 'New Branch' });

    const result = await AuthService.signInWithYeboID('yeboid_multi_3', 'unused-token-for-existing-shop');

    expect(result.isNewShop).toBe(false);
    expect(result.shop.id).toBe(oldest.id);
    expect(result.shop.name).toBe('Original Shop');
    // No extra shop created just by signing in.
    expect(table('shop')).toHaveLength(2);
  });

  it('a single-shop owner still resolves to their one shop (no behavior change)', async () => {
    const shop = seedShop({ ownerYeboidSub: 'yeboid_single', name: 'Only Shop' });

    const result = await AuthService.signInWithYeboID('yeboid_single', 'unused-token');

    expect(result.isNewShop).toBe(false);
    expect(result.shop.id).toBe(shop.id);
  });
});

describe('Multi-shop data isolation', () => {
  it('products created under one shop never appear under a sibling shop owned by the same person', async () => {
    const shopA = seedShop({ ownerYeboidSub: 'yeboid_multi_4', name: 'Shop A' });
    const shopB = await AuthService.createAdditionalShop('yeboid_multi_4', { name: 'Shop B' });

    seedProduct({ shopId: shopA.id, name: 'Only in A' });

    const productsInA = await prisma.product.findMany({ where: { shopId: shopA.id } });
    const productsInB = await prisma.product.findMany({ where: { shopId: shopB.id } });

    expect(productsInA).toHaveLength(1);
    expect(productsInA[0].name).toBe('Only in A');
    expect(productsInB).toHaveLength(0);
  });
});
