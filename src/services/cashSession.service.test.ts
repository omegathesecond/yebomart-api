/**
 * CashSessionService — open / close / Z-report reconciliation, against a REAL
 * Postgres so the aggregate SQL that computes expectedCash actually runs.
 *
 * The reconciliation guarantee (loss-prevention critical):
 *   expectedCash = openingFloat + (CASH, COMPLETED sales rung up during shift)
 *   variance     = countedCash - expectedCash
 * A sale that is VOIDED (the in-system equivalent of a cash refund leaving the
 * drawer) drops out of the cash total — so it must NOT inflate expectedCash.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CashSessionService } from './cashSession.service';
import { SaleService } from './sale.service';
import { resetDb } from '../test/db';
import { seedShop, seedProduct, seedUser } from '../test/factories';

let shopId: string;
let userId: string;

beforeEach(async () => {
  await resetDb();
  const shop = await seedShop();
  shopId = shop.id;
  const user = await seedUser(shopId);
  userId = user.id;
});

/** Ring up a real sale through the create path (CASH unless overridden). */
async function ringUp(productId: string, quantity: number, over: Record<string, any> = {}) {
  return SaleService.create({
    shopId,
    paymentMethod: 'CASH',
    items: [{ productId, quantity }],
    amountPaid: 1_000_000, // plenty; change is irrelevant to the drawer total
    ...over,
  } as any);
}

describe('CashSessionService.open', () => {
  it('opens a session with the starting float', async () => {
    const session = await CashSessionService.open({ shopId, openingFloat: 200 });
    expect(session.status).toBe('OPEN');
    expect(session.openingFloat).toBe(200);
  });

  it('refuses a second open session for the same shop', async () => {
    await CashSessionService.open({ shopId, openingFloat: 200 });
    await expect(CashSessionService.open({ shopId, openingFloat: 50 })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});

describe('CashSessionService.close — cash-up reconciliation', () => {
  it('expectedCash = float + cash sales; variance = counted - expected', async () => {
    const product = await seedProduct(shopId, { sellPrice: 10, quantity: 100 });
    const session = await CashSessionService.open({ shopId, openingFloat: 100 });

    // Two cash sales: 3*10 + 5*10 = 80 taken into the drawer.
    await ringUp(product.id, 3);
    await ringUp(product.id, 5);

    // Cashier counts E175 — E5 short of the E180 expected.
    const closed = await CashSessionService.close({
      sessionId: session.id,
      shopId,
      countedCash: 175,
    });

    expect(closed.status).toBe('CLOSED');
    expect(closed.expectedCash).toBe(180); // 100 float + 80 cash sales
    expect(closed.countedCash).toBe(175);
    expect(closed.variance).toBe(-5); // short
    expect(closed.closedAt).toBeTruthy();
  });

  it('excludes non-cash sales from the expected drawer total', async () => {
    const product = await seedProduct(shopId, { sellPrice: 10, quantity: 100 });
    const session = await CashSessionService.open({ shopId, openingFloat: 100 });

    await ringUp(product.id, 4); // 40 CASH
    await ringUp(product.id, 4, { paymentMethod: 'CARD' }); // 40 CARD — not in drawer

    const closed = await CashSessionService.close({
      sessionId: session.id,
      shopId,
      countedCash: 140,
    });

    expect(closed.expectedCash).toBe(140); // 100 + 40 cash only
    expect(closed.variance).toBe(0);
  });

  it('excludes a VOIDED cash sale (cash refunded out) from expectedCash', async () => {
    const product = await seedProduct(shopId, { sellPrice: 10, quantity: 100 });
    const session = await CashSessionService.open({ shopId, openingFloat: 100 });

    await ringUp(product.id, 5); // 50 CASH — stays
    const refunded = await ringUp(product.id, 5); // 50 CASH — then voided
    await SaleService.voidSale(refunded.id, shopId, userId, 'customer refund');

    const closed = await CashSessionService.close({
      sessionId: session.id,
      shopId,
      countedCash: 150,
    });

    // Only the one surviving E50 cash sale counts: 100 + 50 = 150.
    expect(closed.expectedCash).toBe(150);
    expect(closed.variance).toBe(0);
  });

  it('rejects closing an already-closed session', async () => {
    const session = await CashSessionService.open({ shopId, openingFloat: 100 });
    await CashSessionService.close({ sessionId: session.id, shopId, countedCash: 100 });

    await expect(
      CashSessionService.close({ sessionId: session.id, shopId, countedCash: 100 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('CashSessionService.zReport', () => {
  it('totals reconcile by payment method and overall gross', async () => {
    const product = await seedProduct(shopId, { sellPrice: 10, quantity: 100 });
    const session = await CashSessionService.open({ shopId, openingFloat: 100 });

    await ringUp(product.id, 3); // 30 CASH
    await ringUp(product.id, 2, { paymentMethod: 'CARD' }); // 20 CARD

    const z = await CashSessionService.zReport(session.id, shopId);

    expect(z.transactionCount).toBe(2);
    expect(z.gross).toBe(50);

    const byMethod = Object.fromEntries(z.byPaymentMethod.map((m) => [m.method, m.total]));
    expect(byMethod.CASH).toBe(30);
    expect(byMethod.CARD).toBe(20);
  });
});
