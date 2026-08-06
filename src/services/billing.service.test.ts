/**
 * Tests for the billing credit path.
 *
 * billing.service.ts is a thin orchestration layer over the YeboPay wallet
 * (the credit ledger itself lives in yebopay). The money-safety guarantees we
 * can and must assert HERE are:
 *   - a charge that fails for INSUFFICIENT_BALANCE propagates loudly (no silent
 *     fallback) so a debit can never be masked into a fake "success"
 *   - the idempotencyKey is forwarded to yebopay so a retried charge can't
 *     double-spend
 *   - top-up math is correct and metadata.credit_amount is set (without it the
 *     webhook records a payment but never delivers credits)
 *   - balance reads surface the shop-not-found error instead of guessing
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// `@config/prisma` is redirected to the in-memory fake via vitest.config alias.

// Keep the real YeboPayChargeError class (the service + tests rely on
// instanceof / its code field); stub only the network-calling client methods.
vi.mock('./yebopay.client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./yebopay.client')>();
  return {
    ...actual,
    YeboPayClient: {
      getBalance: vi.fn(),
      chargeWallet: vi.fn(),
      createCheckout: vi.fn(),
      getCheckout: vi.fn(),
      getWalletTransactions: vi.fn(),
      adjustWallet: vi.fn(),
    },
  };
});

import { BillingService } from './billing.service';
import { YeboPayClient, YeboPayChargeError, YeboPayAdjustmentError } from './yebopay.client';
import { resetDb, seedShop, table } from '../test/prismaFake';

let shopId: string;
const OWNER_SUB = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
  const shop = seedShop({ ownerYeboidSub: OWNER_SUB });
  shopId = shop.id;
});

describe('BillingService.getShopBalance', () => {
  it('returns the wallet balance keyed on the owner yeboid sub', async () => {
    (YeboPayClient.getBalance as any).mockResolvedValue({
      available: 500,
      frozen: 0,
      total: 500,
      currency: 'SZL',
    });

    const balance = await BillingService.getShopBalance(shopId);

    expect(balance).toEqual({ available: 500, currency: 'SZL' });
    expect(YeboPayClient.getBalance).toHaveBeenCalledWith(OWNER_SUB);
  });

  it('throws (no silent fallback) when the shop does not exist', async () => {
    await expect(BillingService.getShopBalance('nope')).rejects.toThrow(/Shop not found/);
    expect(YeboPayClient.getBalance).not.toHaveBeenCalled();
  });
});

describe('BillingService.chargeShopCredits', () => {
  it('forwards the charge with idempotencyKey and merges shopId into metadata', async () => {
    (YeboPayClient.chargeWallet as any).mockResolvedValue({
      id: 'ch_1',
      status: 'SUCCEEDED',
      amount: '1',
      currency: 'SZL',
      payment_method: 'WALLET',
      processor: 'wallet',
      external_ref: null,
    });

    await BillingService.chargeShopCredits({
      shopId,
      amount: 1,
      description: 'AI query',
      idempotencyKey: 'idem-key-1',
      metadata: { feature: 'ai_flash' },
    });

    expect(YeboPayClient.chargeWallet).toHaveBeenCalledWith({
      yeboidSub: OWNER_SUB,
      amount: 1,
      description: 'AI query',
      idempotencyKey: 'idem-key-1', // forwarded => retry can't double-spend
      metadata: { shopId, feature: 'ai_flash' },
    });
  });

  it('propagates INSUFFICIENT_BALANCE loudly instead of silently succeeding', async () => {
    (YeboPayClient.chargeWallet as any).mockRejectedValue(
      new YeboPayChargeError(402, 'Insufficient balance', 'INSUFFICIENT_BALANCE')
    );

    await expect(
      BillingService.chargeShopCredits({ shopId, amount: 999, description: 'AI query' })
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE', httpStatus: 402 });
  });
});

describe('BillingService.createTopUpCheckout', () => {
  beforeEach(() => {
    (YeboPayClient.createCheckout as any).mockImplementation(async () => ({
      id: 'co_1',
      hosted_url: 'https://pay.example/co_1',
      expires_at: '2099-01-01T00:00:00.000Z',
      status: 'OPEN',
    }));
  });

  it('prices a known pack and tags the checkout with credit_amount', async () => {
    const res = await BillingService.createTopUpCheckout({
      shopId,
      packId: 'STANDARD',
      successUrl: 'https://app/success',
      cancelUrl: 'https://app/cancel',
    });

    expect(res).toMatchObject({ pack: 'STANDARD', priceSzl: 450, credits: 500 });
    expect(YeboPayClient.createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 450,
        currency: 'SZL',
        yeboidSub: OWNER_SUB,
        metadata: expect.objectContaining({ credit_amount: '500', credit_pack: 'STANDARD' }),
      })
    );
  });

  it('handles a custom 1:1 top-up amount', async () => {
    const res = await BillingService.createTopUpCheckout({
      shopId,
      customAmountSzl: 50,
      successUrl: 'https://app/success',
      cancelUrl: 'https://app/cancel',
    });

    expect(res).toMatchObject({ pack: 'CUSTOM', priceSzl: 50, credits: 50 });
    expect(YeboPayClient.createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 50, metadata: expect.objectContaining({ credit_amount: '50' }) })
    );
  });

  it('rejects a custom amount below the E10 minimum', async () => {
    await expect(
      BillingService.createTopUpCheckout({
        shopId,
        customAmountSzl: 5,
        successUrl: 'https://app/success',
        cancelUrl: 'https://app/cancel',
      })
    ).rejects.toThrow(/customAmountSzl/);
    expect(YeboPayClient.createCheckout).not.toHaveBeenCalled();
  });

  it('rejects an unknown pack id', async () => {
    await expect(
      BillingService.createTopUpCheckout({
        shopId,
        packId: 'PLATINUM',
        successUrl: 'https://app/success',
        cancelUrl: 'https://app/cancel',
      })
    ).rejects.toThrow(/Unknown credit pack/);
    expect(YeboPayClient.createCheckout).not.toHaveBeenCalled();
  });
});

// ── Admin credit adjustments ────────────────────────────────────────────────
//
// The audit guarantee under test: EVERY adjustment attempt leaves a durable
// local row naming the admin and the reason — including attempts that fail.
// An audit trail that erases its own failures isn't an audit trail, and a
// failed top-up fix that vanishes is exactly the ticket nobody can resolve.

const ADMIN = { adminId: 'admin_1', adminEmail: 'ops@yebomart.com' };

function adjustmentResult(over: Record<string, any> = {}) {
  return {
    replayed: false,
    transaction: { id: 'ctx_1', amount: 100, balance_after: 150 },
    balance: { available: 150, frozen: 0, total: 150, currency: 'SZL' },
    ...over,
  };
}

describe('BillingService.adjustShopCredits', () => {
  it('writes the audit row BEFORE calling yebopay and passes its id as external_ref', async () => {
    (YeboPayClient.adjustWallet as any).mockResolvedValue(adjustmentResult());

    await BillingService.adjustShopCredits({
      shopId,
      amount: 100,
      type: 'GOODWILL',
      reason: 'Apology for the 3 Aug outage',
      ...ADMIN,
    });

    const rows = table('creditAdjustment');
    expect(rows).toHaveLength(1);
    // external_ref MUST be the local row id — that's what makes a retry after a
    // network timeout replay yebopay's row instead of crediting twice.
    expect(YeboPayClient.adjustWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        yeboidSub: OWNER_SUB,
        amount: 100,
        reason: 'Apology for the 3 Aug outage',
        actor: 'ops@yebomart.com',
        externalRef: rows[0]!.id,
      })
    );
  });

  it('marks the row APPLIED with the yebopay txn id and resulting balance', async () => {
    (YeboPayClient.adjustWallet as any).mockResolvedValue(adjustmentResult());

    const res = await BillingService.adjustShopCredits({
      shopId,
      amount: 100,
      type: 'GOODWILL',
      reason: 'Goodwill credit',
      ...ADMIN,
    });

    expect(res.adjustment.status).toBe('APPLIED');
    expect(res.adjustment.yebopayTxnId).toBe('ctx_1');
    expect(res.adjustment.balanceAfter).toBe(150);
    expect(res.balance.available).toBe(150);
    expect(table('creditAdjustment')[0]!.status).toBe('APPLIED');
  });

  it('preserves the SIGN so a negative amount claws credits back', async () => {
    (YeboPayClient.adjustWallet as any).mockResolvedValue(adjustmentResult());

    await BillingService.adjustShopCredits({
      shopId,
      amount: -40,
      type: 'CORRECTION',
      reason: 'Reversing credits granted in error',
      ...ADMIN,
    });

    expect(YeboPayClient.adjustWallet).toHaveBeenCalledWith(
      expect.objectContaining({ amount: -40 })
    );
    expect(table('creditAdjustment')[0]!.amount).toBe(-40);
  });

  it('marks the row FAILED (keeping it) and RETHROWS when yebopay rejects', async () => {
    (YeboPayClient.adjustWallet as any).mockRejectedValue(
      new YeboPayAdjustmentError(409, 'Cannot debit 500 — wallet holds only 12', 'INSUFFICIENT_BALANCE')
    );

    await expect(
      BillingService.adjustShopCredits({
        shopId,
        amount: -500,
        type: 'CORRECTION',
        reason: 'Clawback',
        ...ADMIN,
      })
    ).rejects.toBeInstanceOf(YeboPayAdjustmentError);

    // The row survives, flagged, with the reason — never deleted, never APPLIED.
    const rows = table('creditAdjustment');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('FAILED');
    expect(rows[0]!.failureReason).toContain('INSUFFICIENT_BALANCE');
    // No balance was recorded because the wallet never moved. (`?? null` because
    // the in-memory fake omits unset columns where Postgres stores NULL.)
    expect(rows[0]!.balanceAfter ?? null).toBeNull();
  });

  it('marks the row FAILED and rethrows on a transport error too (no silent success)', async () => {
    (YeboPayClient.adjustWallet as any).mockRejectedValue(new Error('fetch failed'));

    await expect(
      BillingService.adjustShopCredits({
        shopId, amount: 10, type: 'REFUND', reason: 'Re-issue failed top-up', ...ADMIN,
      })
    ).rejects.toThrow(/fetch failed/);

    expect(table('creditAdjustment')[0]!.status).toBe('FAILED');
    expect(table('creditAdjustment')[0]!.failureReason).toContain('fetch failed');
  });

  it('records WHO authorised it, so the adjustment is attributable', async () => {
    (YeboPayClient.adjustWallet as any).mockResolvedValue(adjustmentResult());

    await BillingService.adjustShopCredits({
      shopId, amount: 25, type: 'GOODWILL', reason: 'Support gesture', ...ADMIN,
    });

    expect(table('creditAdjustment')[0]).toMatchObject({
      adminId: 'admin_1',
      adminEmail: 'ops@yebomart.com',
      reason: 'Support gesture',
      type: 'GOODWILL',
    });
  });
});

describe('BillingService.getShopLedger / getShopAdjustments', () => {
  it('fetches the ledger keyed on the owner yeboid sub, forwarding pagination', async () => {
    (YeboPayClient.getWalletTransactions as any).mockResolvedValue({
      transactions: [], total: 0, limit: 25, offset: 50,
    });

    await BillingService.getShopLedger(shopId, { limit: 25, offset: 50 });

    expect(YeboPayClient.getWalletTransactions).toHaveBeenCalledWith(OWNER_SUB, {
      limit: 25, offset: 50,
    });
  });

  it('propagates a ledger failure rather than returning an empty list', async () => {
    (YeboPayClient.getWalletTransactions as any).mockRejectedValue(
      new Error('YeboPay GET /wallet/v1/transactions 503: upstream down')
    );

    // An empty ledger and an unreachable ledger must never look the same.
    await expect(BillingService.getShopLedger(shopId)).rejects.toThrow(/503/);
  });

  it('returns local adjustments newest-first', async () => {
    const { seedCreditAdjustment } = await import('../test/prismaFake');
    seedCreditAdjustment({ shopId, reason: 'older', createdAt: new Date('2026-01-01') });
    seedCreditAdjustment({ shopId, reason: 'newer', createdAt: new Date('2026-06-01') });
    seedCreditAdjustment({ shopId: 'other_shop', reason: 'other shop', createdAt: new Date('2026-07-01') });

    const rows = await BillingService.getShopAdjustments(shopId);

    expect(rows.map((r: any) => r.reason)).toEqual(['newer', 'older']);
  });
});
