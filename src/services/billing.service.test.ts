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
      refundCharge: vi.fn(),
      createCheckout: vi.fn(),
      getCheckout: vi.fn(),
    },
  };
});

import { BillingService } from './billing.service';
import { YeboPayClient, YeboPayChargeError } from './yebopay.client';
import { resetDb, seedShop } from '../test/prismaFake';

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

describe('BillingService.refundShopCredits', () => {
  it('forwards a charge reversal to YeboPay (so a failed AI call is never billed)', async () => {
    (YeboPayClient.refundCharge as any).mockResolvedValue({
      charge_id: 'ch_1',
      refunded_amount: '0.5',
      status: 'REFUNDED',
      processor_ref: 'tx_2',
      processor_status: 'SUCCEEDED',
    });

    await BillingService.refundShopCredits({ chargeId: 'ch_1', reason: 'AI insights generation failed' });

    expect(YeboPayClient.refundCharge).toHaveBeenCalledWith({
      chargeId: 'ch_1',
      amount: undefined, // full refund of the remaining amount
      reason: 'AI insights generation failed',
    });
  });

  it('propagates a refund failure loudly instead of swallowing it', async () => {
    (YeboPayClient.refundCharge as any).mockRejectedValue(new Error('YeboPay POST /v1/refunds 403: missing scope'));

    await expect(
      BillingService.refundShopCredits({ chargeId: 'ch_1' })
    ).rejects.toThrow(/v1\/refunds 403/);
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
