/**
 * Tests for the post-success credit-billing flow.
 *
 * The money-safety guarantee under test: a billable AI action GATES on balance
 * up front (requireCreditBalance) but the wallet is debited ONLY after the
 * handler succeeds (settlePendingCharge). The wallet has no refund endpoint, so
 * pre-charging would bill the shop for a call that later fails with no way to
 * give the credit back. These tests pin that ordering down.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// `@config/prisma` is redirected to the in-memory fake via vitest.config alias.
import { requireCreditBalance, settlePendingCharge } from './billing.middleware';
import { BillingService } from '../services/billing.service';
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

let shopId: string;

beforeEach(() => {
  resetDb();
  vi.restoreAllMocks();
  const shop = seedShop();
  shopId = shop.id;
});

describe('requireCreditBalance — gate only, never debits', () => {
  it('passes when the balance covers the cost, stashing a PendingCharge but NOT charging', async () => {
    const getBalance = vi
      .spyOn(BillingService, 'getShopBalance')
      .mockResolvedValue({ available: 10, currency: 'SZL' });
    const charge = vi.spyOn(BillingService, 'chargeShopCredits');

    const req: any = { user: { shopId }, originalUrl: '/api/ai/insights' };
    const res = mockRes();
    const next = vi.fn();

    await requireCreditBalance(0.5, 'AI assistant: insights')(req, res, next);

    expect(getBalance).toHaveBeenCalledWith(shopId);
    expect(next).toHaveBeenCalledOnce();
    // The gate must NOT debit — that's settlePendingCharge's job, post-success.
    expect(charge).not.toHaveBeenCalled();
    expect(req.pendingCharge).toEqual({ amount: 0.5, description: 'AI assistant: insights' });
  });

  it('returns 402 INSUFFICIENT_CREDITS (and does not call next or charge) when the balance is short', async () => {
    vi.spyOn(BillingService, 'getShopBalance').mockResolvedValue({ available: 0.2, currency: 'SZL' });
    const charge = vi.spyOn(BillingService, 'chargeShopCredits');

    const req: any = { user: { shopId }, originalUrl: '/api/ai/insights' };
    const res = mockRes();
    const next = vi.fn();

    await requireCreditBalance(0.5, 'AI assistant: insights')(req, res, next);

    expect(res.statusCode).toBe(402);
    expect(res.body).toMatchObject({ code: 'INSUFFICIENT_CREDITS', cost: 0.5 });
    expect(next).not.toHaveBeenCalled();
    expect(charge).not.toHaveBeenCalled();
    expect(req.pendingCharge).toBeUndefined();
  });
});

describe('settlePendingCharge — the deferred, post-success debit', () => {
  it('charges exactly the stashed amount once, with an idempotency key', async () => {
    const charge = vi.spyOn(BillingService, 'chargeShopCredits').mockResolvedValue({} as any);

    const req: any = {
      user: { shopId },
      originalUrl: '/api/ai/insights',
      pendingCharge: { amount: 0.5, description: 'AI assistant: insights' },
    };

    await settlePendingCharge(req);

    expect(charge).toHaveBeenCalledOnce();
    expect(charge).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId,
        amount: 0.5,
        description: 'AI assistant: insights',
        idempotencyKey: expect.stringContaining(shopId),
      }),
    );
    // Cleared so a second settle on the same request can't double-charge.
    expect(req.pendingCharge).toBeUndefined();
  });

  it('is a no-op when there is no PendingCharge (handler failed before settling)', async () => {
    const charge = vi.spyOn(BillingService, 'chargeShopCredits');
    const req: any = { user: { shopId }, originalUrl: '/api/ai/insights' };

    await settlePendingCharge(req);

    expect(charge).not.toHaveBeenCalled();
  });

  it('does NOT throw if the post-success charge fails — the customer already has their result', async () => {
    vi.spyOn(BillingService, 'chargeShopCredits').mockRejectedValue(new Error('yebopay down'));
    const req: any = {
      user: { shopId },
      originalUrl: '/api/ai/insights',
      pendingCharge: { amount: 0.5, description: 'AI assistant: insights' },
    };

    // Must resolve, not reject — billing failure after delivery is logged, not surfaced.
    await expect(settlePendingCharge(req)).resolves.toBeUndefined();
  });
});
