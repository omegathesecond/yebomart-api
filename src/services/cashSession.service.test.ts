/**
 * Tests for the cash-drawer reconciliation math.
 *
 * The Z-report / cash-up exists to catch over/short at till close. That only
 * works if "expected cash in the drawer" is derived from what each cash sale
 * actually put there: customer cash TENDERED (Sale.amountPaid) minus CHANGE
 * handed back (Sale.change). These tests pin that derivation so a regression
 * (e.g. reverting to summing totalAmount, or ignoring change) is caught.
 */
import { describe, it, expect, beforeEach } from 'vitest';

// `@config/prisma` is redirected to the in-memory fake via vitest.config alias.
import { CashSessionService } from './cashSession.service';
import { resetDb, seedShop, seedCashSession, seedSale } from '../test/prismaFake';

let shopId: string;

beforeEach(() => {
  resetDb();
  shopId = seedShop().id;
});

describe('CashSessionService.getCurrent — drawer tally', () => {
  it('expected cash = float + Σ(tendered − change), and exposes the tendered/change breakdown', async () => {
    const session = seedCashSession({ shopId, openingFloat: 200 });

    // Cash sale: total 70, customer tendered 100, change 30 → net 70 into drawer.
    seedSale({ shopId, receiptNumber: null, cashSessionId: session.id, paymentMethod: 'CASH', totalAmount: 70, amountPaid: 100, change: 30 });
    // Exact-cash sale: total 50, tendered 50, change 0 → net 50.
    seedSale({ shopId, receiptNumber: null, cashSessionId: session.id, paymentMethod: 'CASH', totalAmount: 50, amountPaid: 50, change: 0 });
    // Non-cash sale must NOT count toward the cash drawer.
    seedSale({ shopId, receiptNumber: null, paymentMethod: 'CARD', totalAmount: 999, amountPaid: 999, change: 0 });

    const current = await CashSessionService.getCurrent(shopId);

    expect(current).not.toBeNull();
    expect(current!.cashSalesCount).toBe(2);
    expect(current!.cashTendered).toBe(150); // 100 + 50
    expect(current!.cashChangeGiven).toBe(30); // 30 + 0
    expect(current!.cashSalesTotal).toBe(120); // net retained = 70 + 50
    expect(current!.expectedCash).toBe(320); // float 200 + net 120
  });

  it('returns null when no session is open', async () => {
    expect(await CashSessionService.getCurrent(shopId)).toBeNull();
  });
});

describe('CashSessionService.close — variance', () => {
  it('computes variance against expected cash derived from tendered − change (short)', async () => {
    const session = seedCashSession({ shopId, openingFloat: 100 });
    // total 80, tendered 100, change 20 → net 80. Expected drawer = 100 + 80 = 180.
    seedSale({ shopId, receiptNumber: null, cashSessionId: session.id, paymentMethod: 'CASH', totalAmount: 80, amountPaid: 100, change: 20 });

    const closed = await CashSessionService.close({
      sessionId: session.id,
      shopId,
      countedCash: 175, // E5 short
    });

    expect(closed.expectedCash).toBe(180);
    expect(closed.countedCash).toBe(175);
    expect(closed.variance).toBe(-5); // negative = short
    expect(closed.status).toBe('CLOSED');
  });

  it('treats legacy rows (change defaulting to 0) as tendered == net', async () => {
    const session = seedCashSession({ shopId, openingFloat: 50 });
    // Legacy shape: amountPaid stored as the total, change 0.
    seedSale({ shopId, receiptNumber: null, cashSessionId: session.id, paymentMethod: 'CASH', totalAmount: 40, amountPaid: 40, change: 0 });

    const closed = await CashSessionService.close({
      sessionId: session.id,
      shopId,
      countedCash: 90,
    });

    expect(closed.expectedCash).toBe(90); // 50 + 40
    expect(closed.variance).toBe(0); // balanced
  });
});
