/**
 * The renewal pass must never penalise a shop that has actually paid.
 *
 * YeboPay does not retry a failed webhook delivery, so `invoice.paid` is
 * best-effort: a shop can settle its invoice and the event never arrive. Before
 * this, `runRenewals` read "PENDING at period end" as "did not pay" and lapsed
 * them — revoking the features of a paying customer and then WhatsApping them
 * to say their plan had paused. The poll is what makes the webhook optional.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./yebopay.client', () => ({
  YeboPayClient: {
    getInvoice: vi.fn(),
    createInvoice: vi.fn(),
    sendInvoice: vi.fn(),
  },
}));
vi.mock('./yebolink.client', () => ({
  YeboLinkClient: { sendWhatsApp: vi.fn().mockResolvedValue({ id: 'm_1' }) },
}));

import { runRenewals } from './subscription.service';
import { YeboPayClient } from './yebopay.client';
import { prisma } from '@config/prisma';
import { resetDb, seedShop } from '../test/prismaFake';

const YESTERDAY = new Date(Date.now() - 86_400_000);
const LAST_MONTH = new Date(Date.now() - 31 * 86_400_000);

async function seedUnpaidCycle(invoiceId: string | null) {
  const shop = seedShop({ ownerEmail: 'owner@example.com' });
  await (prisma as any).shopSubscription.create({
    data: {
      shopId: shop.id,
      planCode: 'SHOP',
      status: 'PENDING',
      currentPeriodStart: LAST_MONTH,
      currentPeriodEnd: YESTERDAY,
      cancelAtPeriodEnd: false,
      invoiceId,
      invoiceNumber: invoiceId ? 'INV-2026-0001' : null,
      invoicePayUrl: invoiceId ? 'https://yebopay.app/checkout/x' : null,
      lapsedNotifiedAt: null,
    },
  });
  return shop;
}

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
});

describe('runRenewals — reconciling a missed invoice.paid', () => {
  it('activates a cycle YeboPay reports PAID instead of lapsing it', async () => {
    const shop = await seedUnpaidCycle('inv_paid');
    (YeboPayClient.getInvoice as any).mockResolvedValue({ id: 'inv_paid', status: 'PAID' });

    const summary = await runRenewals();

    expect(YeboPayClient.getInvoice).toHaveBeenCalledWith('inv_paid');
    expect(summary.reconciled).toBe(1);
    expect(summary.lapsed).toBe(0);

    const sub = await (prisma as any).shopSubscription.findUnique({ where: { shopId: shop.id } });
    expect(sub.status).toBe('ACTIVE');
  });

  it('does NOT send the "your plan is paused" notice to a shop that paid', async () => {
    // The message is the real damage: features can be restored, telling a
    // paying customer their payment did not count cannot be taken back.
    const { YeboLinkClient } = await import('./yebolink.client');
    await seedUnpaidCycle('inv_paid');
    (YeboPayClient.getInvoice as any).mockResolvedValue({ id: 'inv_paid', status: 'PAID' });

    await runRenewals();

    expect(YeboLinkClient.sendWhatsApp).not.toHaveBeenCalled();
  });

  it('still lapses a cycle YeboPay confirms is unpaid', async () => {
    const shop = await seedUnpaidCycle('inv_unpaid');
    (YeboPayClient.getInvoice as any).mockResolvedValue({ id: 'inv_unpaid', status: 'SENT' });

    const summary = await runRenewals();

    expect(summary.reconciled).toBe(0);
    expect(summary.lapsed).toBe(1);

    const sub = await (prisma as any).shopSubscription.findUnique({ where: { shopId: shop.id } });
    expect(sub.status).toBe('PAST_DUE');
  });

  it('lapses rather than aborting the pass when YeboPay is unreachable', async () => {
    // Erring toward lapsing is recoverable — the next pass or the webhook puts
    // them back. Throwing would strand every later subscription in the batch.
    const shop = await seedUnpaidCycle('inv_boom');
    (YeboPayClient.getInvoice as any).mockRejectedValue(new Error('ECONNRESET'));

    const summary = await runRenewals();

    expect(summary.lapsed).toBe(1);
    expect(summary.failures).toEqual([]);

    const sub = await (prisma as any).shopSubscription.findUnique({ where: { shopId: shop.id } });
    expect(sub.status).toBe('PAST_DUE');
  });

  it('skips the poll when no invoice was ever raised', async () => {
    await seedUnpaidCycle(null);

    const summary = await runRenewals();

    expect(YeboPayClient.getInvoice).not.toHaveBeenCalled();
    expect(summary.lapsed).toBe(1);
  });
});
