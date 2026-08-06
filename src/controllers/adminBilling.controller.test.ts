/**
 * Tests for the admin billing surface.
 *
 * Two contracts matter here and both are about NOT lying to the operator:
 *   1. A yebopay outage must never render as "balance 0" or "no transactions".
 *      getShopBilling returns balance/ledger as null WITH a non-null
 *      walletError, so the UI is forced to show a failure.
 *   2. A failed adjustment must never report success. The handler echoes
 *      yebopay's actionable status (409 over-debit, 403 missing scope) and
 *      falls back to 502 — never 200 — when the wallet did not move.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// `@config/prisma` is redirected to the in-memory fake via vitest.config alias.
import { AdminBillingController, adjustCreditsSchema } from './adminBilling.controller';
import { BillingService } from '../services/billing.service';
import { YeboPayAdjustmentError } from '../services/yebopay.client';
import { resetDb, seedShop, seedAdmin, seedCreditAdjustment, table } from '../test/prismaFake';

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

let shopId: string;
let adminId: string;

beforeEach(() => {
  resetDb();
  vi.restoreAllMocks();
  shopId = seedShop({ name: 'Test Shop' }).id;
  adminId = seedAdmin({ email: 'ops@yebomart.com' }).id;
});

const query = { limit: 50, offset: 0 };

describe('getShopBilling', () => {
  it('returns balance, ledger and the local audit trail on the happy path', async () => {
    vi.spyOn(BillingService, 'getShopBalance').mockResolvedValue({ available: 250, currency: 'SZL' });
    vi.spyOn(BillingService, 'getShopLedger').mockResolvedValue({
      transactions: [
        {
          id: 'ctx_1',
          type: 'DEBIT',
          ref_type: 'MERCHANT_CHARGE',
          amount: 0.5,
          balance_before: 250.5,
          balance_after: 250,
          description: 'AI assistant',
          external_ref: null,
          merchant_app: 'yebomart',
          created_at: '2026-08-01T00:00:00.000Z',
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    });
    seedCreditAdjustment({ shopId, reason: 'Goodwill' });

    const req: any = { params: { id: shopId }, query, user: { id: adminId, type: 'admin' } };
    const res = mockRes();

    await AdminBillingController.getShopBilling(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.balance).toEqual({ available: 250, currency: 'SZL' });
    expect(res.body.data.ledger.total).toBe(1);
    expect(res.body.data.adjustments).toHaveLength(1);
    expect(res.body.data.shop.name).toBe('Test Shop');
    // No error => the UI renders the numbers.
    expect(res.body.data.walletError).toBeNull();
  });

  it('404s an unknown shop', async () => {
    const req: any = { params: { id: 'nope' }, query, user: { id: adminId, type: 'admin' } };
    const res = mockRes();

    await AdminBillingController.getShopBilling(req, res);

    expect(res.statusCode).toBe(404);
  });

  it('surfaces a yebopay outage as walletError with NULL balance — never a fake zero', async () => {
    vi.spyOn(BillingService, 'getShopBalance').mockRejectedValue(
      new Error('YeboPay GET /wallet/v1/balance 503: upstream down')
    );
    vi.spyOn(BillingService, 'getShopLedger').mockRejectedValue(new Error('upstream down'));
    seedCreditAdjustment({ shopId, reason: 'Earlier goodwill credit' });

    const req: any = { params: { id: shopId }, query, user: { id: adminId, type: 'admin' } };
    const res = mockRes();

    await AdminBillingController.getShopBilling(req, res);

    // The critical assertion: a zero balance and an unreachable wallet must
    // never be indistinguishable to the operator.
    expect(res.body.data.balance).toBeNull();
    expect(res.body.data.ledger).toBeNull();
    expect(res.body.data.walletError).toContain('503');
    // ...while the local audit trail still comes through, which is what makes
    // the page useful during exactly the outage that caused the ticket.
    expect(res.body.data.adjustments).toHaveLength(1);
  });
});

describe('adjustShopCredits', () => {
  const body = { amount: 100, type: 'GOODWILL' as const, reason: 'Apology for outage' };

  function reqFor(over: Record<string, any> = {}) {
    return {
      params: { id: shopId },
      body: { ...body },
      user: { id: adminId, type: 'admin' },
      ...over,
    } as any;
  }

  it('applies the adjustment and reports the new balance', async () => {
    const spy = vi.spyOn(BillingService, 'adjustShopCredits').mockResolvedValue({
      adjustment: { id: 'adj_1', status: 'APPLIED' } as any,
      balance: { available: 350, frozen: 0, total: 350, currency: 'SZL' },
      replayed: false,
    } as any);

    const res = mockRes();
    await AdminBillingController.adjustShopCredits(reqFor(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.balance.available).toBe(350);
    // The audit row must name the admin by the email on their CURRENT record,
    // not whatever a 24h-old token happened to carry.
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ shopId, amount: 100, adminId, adminEmail: 'ops@yebomart.com' })
    );
  });

  it('404s an unknown shop without attempting an adjustment', async () => {
    const spy = vi.spyOn(BillingService, 'adjustShopCredits');
    const res = mockRes();

    await AdminBillingController.adjustShopCredits(reqFor({ params: { id: 'nope' } }), res);

    expect(res.statusCode).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it('echoes yebopay 409 INSUFFICIENT_BALANCE rather than flattening it to 500', async () => {
    vi.spyOn(BillingService, 'adjustShopCredits').mockRejectedValue(
      new YeboPayAdjustmentError(409, 'Cannot debit 500 — wallet holds only 12', 'INSUFFICIENT_BALANCE')
    );

    const res = mockRes();
    await AdminBillingController.adjustShopCredits(
      reqFor({ body: { amount: -500, type: 'CORRECTION', reason: 'Clawback' } }),
      res
    );

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('INSUFFICIENT_BALANCE');
    expect(res.body.success).toBe(false);
  });

  it('echoes a 403 when the API key lacks the wallet.write scope', async () => {
    vi.spyOn(BillingService, 'adjustShopCredits').mockRejectedValue(
      new YeboPayAdjustmentError(403, 'Missing required scope: wallet.write', 'ADJUSTMENT_FAILED')
    );

    const res = mockRes();
    await AdminBillingController.adjustShopCredits(reqFor(), res);

    // An un-granted scope must read as a config problem, not a server bug.
    expect(res.statusCode).toBe(403);
    expect(res.body.message).toMatch(/wallet\.write/);
  });

  it('returns 502 (never 200) when yebopay is unreachable', async () => {
    vi.spyOn(BillingService, 'adjustShopCredits').mockRejectedValue(new Error('fetch failed'));

    const res = mockRes();
    await AdminBillingController.adjustShopCredits(reqFor(), res);

    expect(res.statusCode).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('ADJUSTMENT_FAILED');
  });

  it('401s when the request carries no admin id', async () => {
    const spy = vi.spyOn(BillingService, 'adjustShopCredits');
    const res = mockRes();

    await AdminBillingController.adjustShopCredits(reqFor({ user: undefined }), res);

    expect(res.statusCode).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it('401s when the admin record no longer exists (deleted mid-session)', async () => {
    const spy = vi.spyOn(BillingService, 'adjustShopCredits');
    const res = mockRes();

    await AdminBillingController.adjustShopCredits(
      reqFor({ user: { id: 'admin_gone', type: 'admin' } }),
      res
    );

    expect(res.statusCode).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it('leaves no audit row behind when it rejects before reaching the service', async () => {
    const res = mockRes();
    await AdminBillingController.adjustShopCredits(reqFor({ params: { id: 'nope' } }), res);
    expect(table('creditAdjustment')).toHaveLength(0);
  });
});

describe('adjustCreditsSchema', () => {
  const valid = { amount: 50, type: 'GOODWILL', reason: 'Support gesture' };

  it('accepts a well-formed grant and a well-formed clawback', () => {
    expect(adjustCreditsSchema.validate(valid).error).toBeUndefined();
    expect(
      adjustCreditsSchema.validate({ ...valid, amount: -50, type: 'CORRECTION' }).error
    ).toBeUndefined();
  });

  it('rejects a zero amount — a no-op adjustment is always a mistake', () => {
    const { error } = adjustCreditsSchema.validate({ ...valid, amount: 0 });
    expect(error?.message).toMatch(/must not be zero/);
  });

  it('rejects a missing or too-short reason so adjustments stay auditable', () => {
    expect(adjustCreditsSchema.validate({ amount: 50, type: 'GOODWILL' }).error).toBeDefined();
    expect(adjustCreditsSchema.validate({ ...valid, reason: 'x' }).error?.message).toMatch(/auditable/);
  });

  it('rejects an unknown adjustment type', () => {
    expect(adjustCreditsSchema.validate({ ...valid, type: 'FREEBIE' }).error).toBeDefined();
  });

  it('rejects an amount beyond the ceiling in either direction', () => {
    expect(adjustCreditsSchema.validate({ ...valid, amount: 100_001 }).error).toBeDefined();
    expect(adjustCreditsSchema.validate({ ...valid, amount: -100_001 }).error).toBeDefined();
  });
});
