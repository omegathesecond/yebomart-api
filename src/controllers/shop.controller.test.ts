/**
 * Tests for ShopController — the Settings-page backend and the main place
 * cross-shop authorization is enforced for shop-scoped resources (getById /
 * update / getStats all reject a shop id other than the caller's own, and
 * update additionally gates on OWNER role). Gaps here are security-relevant,
 * not just coverage nits.
 *
 * Covered:
 *   - getNotificationSettings / updateNotificationSettings: read + write,
 *     '' clearing notifyPhone back to null
 *   - getTaxSettings / updateTaxSettings: read + write, '' clearing taxNumber
 *   - getById: cross-shop 403, not-found 404, happy path
 *   - update: cross-shop 403, non-owner 403 (independent from the shop-id
 *     check), happy path
 *   - getStats: cross-shop 403
 *   - getBusinessTypes: public list (no auth required)
 *   - getConfig: business config derivation incl. the 'general' fallback for
 *     a null/undefined businessType
 *   - the defensive `!req.user` -> 401 branch and the generic
 *     ApiResponse.serverError branch (ShopService mocked to throw), on every
 *     method
 *
 * Drives the real ShopService against the in-memory prisma fake (mirrors
 * user.controller.test.ts / customer.controller.test.ts), and uses
 * vi.spyOn(ShopService, ...) only for the handful of cases that need a forced
 * failure the fake can't otherwise produce.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ownerAuth (used below to prove the PATCH routes are owner-only) wraps
// authMiddleware, which tries a YeboID (JWKS, real network) verify first and
// falls back to the yebomart-signed staff HS256 path only when that throws.
// Force every token down the staff path so tests never hit the network —
// mirrors stock.controller.test.ts's managerAuth coverage.
vi.mock('@yebo/mcp-server', () => ({
  JwksValidator: vi.fn().mockImplementation(() => ({
    verify: vi.fn().mockRejectedValue(new Error('not a YeboID token')),
  })),
  extractBearerToken: (header?: string) => header?.replace(/^Bearer\s+/i, '') ?? null,
}));

import { ShopController } from './shop.controller';
import { ShopService } from '../services/shop.service';
import { ownerAuth } from '../middleware/auth.middleware';
import { JWTUtil } from '../utils/jwt';
import { resetDb, seedShop, table } from '../test/prismaFake';

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

function reqFor(opts: {
  user?: { id: string; shopId: string; role: 'OWNER' | 'MANAGER' | 'CASHIER' };
  params?: Record<string, any>;
  body?: Record<string, any>;
  query?: Record<string, any>;
}): any {
  return {
    user: opts.user,
    params: opts.params ?? {},
    body: opts.body ?? {},
    query: opts.query ?? {},
  };
}

const owner = (shopId: string) => ({ id: 'user_1', shopId, role: 'OWNER' as const });
const manager = (shopId: string) => ({ id: 'user_1', shopId, role: 'MANAGER' as const });
const cashier = (shopId: string) => ({ id: 'user_1', shopId, role: 'CASHIER' as const });

let shopId: string;

beforeEach(() => {
  resetDb();
  const shop = seedShop({
    notifyWhatsAppReports: true,
    notifyLowStock: true,
    notifyPhone: null,
    ownerPhone: '+26876123456',
    taxRate: 15,
    taxInclusive: false,
    taxNumber: null,
    businessType: null,
  });
  shopId = shop.id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ShopController.getNotificationSettings', () => {
  it('returns the current shop notification prefs + resolved recipient', async () => {
    const res = mockRes();
    await ShopController.getNotificationSettings(reqFor({ user: owner(shopId) }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      notifyWhatsAppReports: true,
      notifyLowStock: true,
      notifyPhone: null,
      ownerPhone: '+26876123456',
      recipientPhone: '+26876123456',
    });
  });

  it('401s when req.user is missing', async () => {
    const res = mockRes();
    await ShopController.getNotificationSettings(reqFor({}), res);

    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('serverErrors when ShopService throws unexpectedly', async () => {
    vi.spyOn(ShopService, 'getNotificationSettings').mockRejectedValue(new Error('db exploded'));
    const res = mockRes();
    await ShopController.getNotificationSettings(reqFor({ user: owner(shopId) }), res);

    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

describe('notification/tax PATCH routes are owner-only (ownerAuth gate in shop.routes.ts)', () => {
  function bearerReq(token: string): any {
    return { headers: { authorization: `Bearer ${token}` } };
  }

  function signStaff(role: 'OWNER' | 'MANAGER' | 'CASHIER') {
    return JWTUtil.generateAccessToken({ id: 'user_1', shopId, role, type: 'user' });
  }

  it('rejects a MANAGER with 403 before the controller ever runs', async () => {
    const res = mockRes();
    const next = vi.fn();

    await ownerAuth(bearerReq(signStaff('MANAGER')), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('rejects a CASHIER with 403 before the controller ever runs', async () => {
    const res = mockRes();
    const next = vi.fn();

    await ownerAuth(bearerReq(signStaff('CASHIER')), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('admits an OWNER', async () => {
    const res = mockRes();
    const next = vi.fn();

    await ownerAuth(bearerReq(signStaff('OWNER')), res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('ShopController.updateNotificationSettings', () => {
  it('updates the notify flags for the owner', async () => {
    const res = mockRes();
    await ShopController.updateNotificationSettings(
      reqFor({ user: owner(shopId), body: { notifyWhatsAppReports: false, notifyLowStock: false } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.data.notifyWhatsAppReports).toBe(false);
    expect(res.body.data.notifyLowStock).toBe(false);
    expect(table('shop').find((s) => s.id === shopId)!.notifyWhatsAppReports).toBe(false);
  });

  it('sets an override notifyPhone and reflects it in recipientPhone', async () => {
    const res = mockRes();
    await ShopController.updateNotificationSettings(
      reqFor({ user: owner(shopId), body: { notifyPhone: '+26876999999' } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.data.notifyPhone).toBe('+26876999999');
    expect(res.body.data.recipientPhone).toBe('+26876999999');
    expect(table('shop').find((s) => s.id === shopId)!.notifyPhone).toBe('+26876999999');
  });

  it("clears notifyPhone with '' and falls back to ownerPhone as the recipient", async () => {
    // Seed an override first so the clear has something to undo.
    await ShopController.updateNotificationSettings(
      reqFor({ user: owner(shopId), body: { notifyPhone: '+26876999999' } }),
      mockRes(),
    );

    const res = mockRes();
    await ShopController.updateNotificationSettings(
      reqFor({ user: owner(shopId), body: { notifyPhone: '' } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.data.notifyPhone).toBeNull();
    expect(res.body.data.recipientPhone).toBe('+26876123456');
    expect(table('shop').find((s) => s.id === shopId)!.notifyPhone).toBeNull();
  });

  it('401s when req.user is missing', async () => {
    const res = mockRes();
    await ShopController.updateNotificationSettings(reqFor({ body: { notifyLowStock: false } }), res);

    expect(res.statusCode).toBe(401);
  });

  it('serverErrors when ShopService throws unexpectedly', async () => {
    vi.spyOn(ShopService, 'updateNotificationSettings').mockRejectedValue(new Error('db exploded'));
    const res = mockRes();
    await ShopController.updateNotificationSettings(
      reqFor({ user: owner(shopId), body: { notifyLowStock: false } }),
      res,
    );

    expect(res.statusCode).toBe(500);
  });
});

describe('ShopController.getTaxSettings', () => {
  it('returns the current shop tax config', async () => {
    const res = mockRes();
    await ShopController.getTaxSettings(reqFor({ user: owner(shopId) }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ taxRate: 15, taxInclusive: false, taxNumber: null });
  });

  it('401s when req.user is missing', async () => {
    const res = mockRes();
    await ShopController.getTaxSettings(reqFor({}), res);

    expect(res.statusCode).toBe(401);
  });

  it('serverErrors when ShopService throws unexpectedly', async () => {
    vi.spyOn(ShopService, 'getTaxSettings').mockRejectedValue(new Error('db exploded'));
    const res = mockRes();
    await ShopController.getTaxSettings(reqFor({ user: owner(shopId) }), res);

    expect(res.statusCode).toBe(500);
  });
});

describe('ShopController.updateTaxSettings', () => {
  it('updates taxRate and taxInclusive for the owner', async () => {
    const res = mockRes();
    await ShopController.updateTaxSettings(
      reqFor({ user: owner(shopId), body: { taxRate: 7.5, taxInclusive: true } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ taxRate: 7.5, taxInclusive: true, taxNumber: null });
    expect(table('shop').find((s) => s.id === shopId)!.taxRate).toBe(7.5);
  });

  it("clears taxNumber with ''", async () => {
    await ShopController.updateTaxSettings(
      reqFor({ user: owner(shopId), body: { taxNumber: 'VAT-123' } }),
      mockRes(),
    );

    const res = mockRes();
    await ShopController.updateTaxSettings(
      reqFor({ user: owner(shopId), body: { taxNumber: '' } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.data.taxNumber).toBeNull();
    expect(table('shop').find((s) => s.id === shopId)!.taxNumber).toBeNull();
  });

  it('401s when req.user is missing', async () => {
    const res = mockRes();
    await ShopController.updateTaxSettings(reqFor({ body: { taxRate: 5 } }), res);

    expect(res.statusCode).toBe(401);
  });

  it('serverErrors when ShopService throws unexpectedly', async () => {
    vi.spyOn(ShopService, 'updateTaxSettings').mockRejectedValue(new Error('db exploded'));
    const res = mockRes();
    await ShopController.updateTaxSettings(
      reqFor({ user: owner(shopId), body: { taxRate: 5 } }),
      res,
    );

    expect(res.statusCode).toBe(500);
  });
});

describe('ShopController.getById', () => {
  it('returns the shop when :id matches the caller\'s own shopId', async () => {
    const res = mockRes();
    await ShopController.getById(reqFor({ user: owner(shopId), params: { id: shopId } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.id).toBe(shopId);
  });

  it("403s with 'Access denied' when :id is a DIFFERENT shop", async () => {
    const otherShop = seedShop();
    const res = mockRes();
    await ShopController.getById(
      reqFor({ user: owner(shopId), params: { id: otherShop.id } }),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(res.body.message).toBe('Access denied');
  });

  it('404s when the shop does not exist', async () => {
    const res = mockRes();
    await ShopController.getById(
      reqFor({ user: { id: 'user_1', shopId: 'missing_shop', role: 'OWNER' }, params: { id: 'missing_shop' } }),
      res,
    );

    expect(res.statusCode).toBe(404);
  });

  it('401s when req.user is missing', async () => {
    const res = mockRes();
    await ShopController.getById(reqFor({ params: { id: shopId } }), res);

    expect(res.statusCode).toBe(401);
  });

  it('serverErrors on an unexpected (non "not found") ShopService failure', async () => {
    vi.spyOn(ShopService, 'getById').mockRejectedValue(new Error('db exploded'));
    const res = mockRes();
    await ShopController.getById(reqFor({ user: owner(shopId), params: { id: shopId } }), res);

    expect(res.statusCode).toBe(500);
  });

  it('serverErrors (not an unhandled throw) when ShopService rejects with an Error that has no message', async () => {
    const errorWithoutMessage = new Error();
    delete (errorWithoutMessage as { message?: string }).message;
    vi.spyOn(ShopService, 'getById').mockRejectedValue(errorWithoutMessage);
    const res = mockRes();
    await ShopController.getById(reqFor({ user: owner(shopId), params: { id: shopId } }), res);

    expect(res.statusCode).toBe(500);
  });
});

describe('ShopController.update', () => {
  it('an OWNER can update their own shop', async () => {
    const res = mockRes();
    await ShopController.update(
      reqFor({ user: owner(shopId), params: { id: shopId }, body: { name: 'New Name' } }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.data.name).toBe('New Name');
    expect(table('shop').find((s) => s.id === shopId)!.name).toBe('New Name');
  });

  it("403s with 'Access denied' when :id is a DIFFERENT shop, even for an OWNER", async () => {
    const otherShop = seedShop({ name: 'Other Shop' });
    const res = mockRes();
    await ShopController.update(
      reqFor({ user: owner(shopId), params: { id: otherShop.id }, body: { name: 'Hijacked' } }),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(res.body.message).toBe('Access denied');
    expect(table('shop').find((s) => s.id === otherShop.id)!.name).toBe('Other Shop');
  });

  it("403s with 'Only owners can update shop settings' for a MANAGER on their OWN shop", async () => {
    const res = mockRes();
    await ShopController.update(
      reqFor({ user: manager(shopId), params: { id: shopId }, body: { name: 'Hijacked' } }),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(res.body.message).toBe('Only owners can update shop settings');
    expect(table('shop').find((s) => s.id === shopId)!.name).toBe('Test Shop');
  });

  it("403s with 'Only owners can update shop settings' for a CASHIER on their OWN shop", async () => {
    const res = mockRes();
    await ShopController.update(
      reqFor({ user: cashier(shopId), params: { id: shopId }, body: { name: 'Hijacked' } }),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(res.body.message).toBe('Only owners can update shop settings');
  });

  it('401s when req.user is missing', async () => {
    const res = mockRes();
    await ShopController.update(reqFor({ params: { id: shopId }, body: { name: 'X' } }), res);

    expect(res.statusCode).toBe(401);
  });

  it('serverErrors when ShopService throws unexpectedly', async () => {
    vi.spyOn(ShopService, 'update').mockRejectedValue(new Error('db exploded'));
    const res = mockRes();
    await ShopController.update(
      reqFor({ user: owner(shopId), params: { id: shopId }, body: { name: 'X' } }),
      res,
    );

    expect(res.statusCode).toBe(500);
  });
});

describe('ShopController.getStats', () => {
  it("403s with 'Access denied' when :id is a DIFFERENT shop", async () => {
    const otherShop = seedShop();
    const res = mockRes();
    await ShopController.getStats(
      reqFor({ user: owner(shopId), params: { id: otherShop.id } }),
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(res.body.message).toBe('Access denied');
  });

  it('returns stats for the caller\'s own shop', async () => {
    // ShopService.getStats does a `quantity: { lte: prisma.product.fields.reorderAt }`
    // column-to-column comparison the in-memory fake doesn't model (it's a real
    // Postgres feature, not something worth teaching the fake for one read
    // endpoint) — mocked here so this test stays focused on the controller's
    // pass-through, matching the cross-shop-403 scope this method actually
    // needs covering.
    const stats = { today: { sales: 0, transactions: 0 }, inventory: { totalProducts: 0 } };
    vi.spyOn(ShopService, 'getStats').mockResolvedValue(stats as any);
    const res = mockRes();
    await ShopController.getStats(reqFor({ user: owner(shopId), params: { id: shopId } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual(stats);
  });

  it('401s when req.user is missing', async () => {
    const res = mockRes();
    await ShopController.getStats(reqFor({ params: { id: shopId } }), res);

    expect(res.statusCode).toBe(401);
  });

  it('serverErrors when ShopService throws unexpectedly', async () => {
    vi.spyOn(ShopService, 'getStats').mockRejectedValue(new Error('db exploded'));
    const res = mockRes();
    await ShopController.getStats(reqFor({ user: owner(shopId), params: { id: shopId } }), res);

    expect(res.statusCode).toBe(500);
  });
});

describe('ShopController.getBusinessTypes', () => {
  it('returns the full business types list without requiring auth', async () => {
    const res = mockRes();
    await ShopController.getBusinessTypes(reqFor({}), res);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.some((t: any) => t.id === 'general')).toBe(true);
  });
});

describe('ShopController.getConfig', () => {
  it("derives config from the shop's businessType", async () => {
    const shop = seedShop({ businessType: 'restaurant' });
    const res = mockRes();
    await ShopController.getConfig(reqFor({ user: owner(shop.id) }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.businessType).toBe('restaurant');
    expect(res.body.data.config).toBeDefined();
  });

  it("falls back to 'general' when businessType is null", async () => {
    const res = mockRes();
    await ShopController.getConfig(reqFor({ user: owner(shopId) }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.businessType).toBe('general');
  });

  it("falls back to 'general' when businessType is undefined", async () => {
    const shop = seedShop();
    delete shop.businessType;
    const res = mockRes();
    await ShopController.getConfig(reqFor({ user: owner(shop.id) }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.businessType).toBe('general');
  });

  it('401s when req.user is missing', async () => {
    const res = mockRes();
    await ShopController.getConfig(reqFor({}), res);

    expect(res.statusCode).toBe(401);
  });

  it('serverErrors when ShopService throws unexpectedly', async () => {
    vi.spyOn(ShopService, 'getById').mockRejectedValue(new Error('db exploded'));
    const res = mockRes();
    await ShopController.getConfig(reqFor({ user: owner(shopId) }), res);

    expect(res.statusCode).toBe(500);
  });
});
