/**
 * Tests for CashSessionController — the cash-drawer reconciliation invariants.
 *
 * Every POS shift is reconciled here, so the failure modes are silent-money
 * ones: a wrong time window quietly moves cash between shifts, a second open
 * till splits a day's takings in two, and a z-report that counts the wrong rows
 * mis-states the day. The controller is a thin transport shim over
 * CashSessionService, and the vitest alias points `@config/prisma` at the
 * in-memory fake, so driving the controller runs the REAL reconciliation
 * arithmetic against a real (fake) store — nothing is stubbed out.
 *
 * What these pin:
 *   (a) opening a till records the float, stamps OPEN, and attributes the
 *       cashier (staff PIN token) or nobody (owner YeboID token, which has no
 *       User row);
 *   (b) a shop has AT MOST ONE open till — a second open is a 409;
 *   (c) /current returns the live drawer with a running expected total, or null;
 *   (d) closing computes expectedCash = float + cash sales IN THE SESSION
 *       WINDOW and stores variance = counted − expected (signed: negative =
 *       short), ignoring pre-open sales, non-cash sales and non-COMPLETED sales;
 *   (e) closing a missing / already-closed / other-shop session is refused;
 *   (f) the z-report aggregates only sales inside openedAt→closedAt, broken
 *       down by payment method — a sale rung up after cash-up must not leak in.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CashSessionController } from './cashSession.controller';
import {
  resetDb,
  seedShop,
  seedUser,
  seedSale,
  seedCashSession,
  table,
} from '../test/prismaFake';

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

// Staff (PIN) token — carries a real User id, so the till gets a cashier.
function staffReq(body: Record<string, any> = {}, params: Record<string, any> = {}): any {
  return {
    user: { id: cashierId, shopId: 'shop_1', role: 'CASHIER', type: 'user' },
    params,
    body,
  };
}

// Shop OWNER token — authenticated via YeboID, so `id` is the SHOP id and there
// is no User row behind it.
function ownerReq(body: Record<string, any> = {}, params: Record<string, any> = {}): any {
  return {
    user: { id: 'shop_1', shopId: 'shop_1', role: 'OWNER', type: 'shop' },
    params,
    body,
  };
}

// A fixed shift in the past, so `lte: now` windows always include it and the
// arithmetic never races the wall clock.
const BEFORE_OPEN = new Date('2026-08-01T07:00:00Z');
const OPENED_AT = new Date('2026-08-01T08:00:00Z');
const MID_SHIFT = new Date('2026-08-01T10:00:00Z');
const LATE_SHIFT = new Date('2026-08-01T12:00:00Z');
const CLOSED_AT = new Date('2026-08-01T17:00:00Z');
const AFTER_CLOSE = new Date('2026-08-01T18:00:00Z');

let cashierId: string;
let rcpSeq = 0;

// Sale.receiptNumber is @@unique([shopId, receiptNumber]) and the fake enforces
// it, so every seeded sale needs its own number.
function sale(partial: Record<string, any>) {
  return seedSale({ receiptNumber: `RCP-${++rcpSeq}`, ...partial });
}

beforeEach(() => {
  resetDb();
  rcpSeq = 0;
  seedShop({
    ownerYeboidSub: '11111111-1111-1111-1111-111111111111',
    name: 'Test Shop',
    currency: 'SZL',
    currencySymbol: 'E',
  });
  cashierId = seedUser({ shopId: 'shop_1', name: 'Thandi' }).id;
});

describe('CashSessionController.open', () => {
  it('opens a till with the starting float and returns it', async () => {
    const res = mockRes();

    await CashSessionController.open(staffReq({ openingFloat: 250 }), res);

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      shopId: 'shop_1',
      openingFloat: 250,
      status: 'OPEN',
    });
    // The cash-up figures stay empty until close.
    expect(res.body.data.closedAt ?? null).toBeNull();
    expect(res.body.data.countedCash ?? null).toBeNull();

    // ...and it was actually persisted, not just echoed back.
    const rows = table('cashSession');
    expect(rows).toHaveLength(1);
    expect(rows[0].openingFloat).toBe(250);
    expect(rows[0].status).toBe('OPEN');
    expect(rows[0].openedAt).toBeInstanceOf(Date);
  });

  it('attributes the till to the staff member who opened it', async () => {
    const res = mockRes();

    await CashSessionController.open(staffReq({ openingFloat: 100 }), res);

    expect(table('cashSession')[0].userId).toBe(cashierId);
    expect(res.body.data.user).toMatchObject({ id: cashierId, name: 'Thandi' });
  });

  it('leaves the cashier unset for a shop-owner token (no User row behind it)', async () => {
    const res = mockRes();

    // The owner's token id is the SHOP id; recording it as userId would forge a
    // FK to a User that does not exist.
    await CashSessionController.open(ownerReq({ openingFloat: 100 }), res);

    expect(res.statusCode).toBe(201);
    expect(table('cashSession')[0].userId ?? null).toBeNull();
    expect(res.body.data.user).toBeNull();
  });

  it('rejects opening a second till while one is already open (409)', async () => {
    const first = mockRes();
    await CashSessionController.open(staffReq({ openingFloat: 250 }), first);
    expect(first.statusCode).toBe(201);

    const second = mockRes();
    await CashSessionController.open(staffReq({ openingFloat: 500 }), second);

    expect(second.statusCode).toBe(409);
    expect(second.body.success).toBe(false);
    expect(second.body.message).toMatch(/already open/i);
    // Critically: no second drawer was created.
    expect(table('cashSession')).toHaveLength(1);
  });

  it('allows a new till once the previous one is closed', async () => {
    seedCashSession({ status: 'CLOSED', openedAt: OPENED_AT, closedAt: CLOSED_AT });

    const res = mockRes();
    await CashSessionController.open(staffReq({ openingFloat: 300 }), res);

    expect(res.statusCode).toBe(201);
    expect(table('cashSession')).toHaveLength(2);
  });

  it('does not see another shop’s open till', async () => {
    seedShop({ ownerYeboidSub: '22222222-2222-2222-2222-222222222222' });
    seedCashSession({ shopId: 'shop_2', status: 'OPEN' });

    const res = mockRes();
    await CashSessionController.open(staffReq({ openingFloat: 100 }), res);

    expect(res.statusCode).toBe(201);
  });

  it('401s without an authenticated user', async () => {
    const res = mockRes();
    await CashSessionController.open({ body: { openingFloat: 100 }, params: {} } as any, res);
    expect(res.statusCode).toBe(401);
    expect(table('cashSession')).toHaveLength(0);
  });
});

describe('CashSessionController.current', () => {
  it('returns null when no till is open', async () => {
    const res = mockRes();

    await CashSessionController.current(staffReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeNull();
  });

  it('ignores a closed session', async () => {
    seedCashSession({ status: 'CLOSED', openedAt: OPENED_AT, closedAt: CLOSED_AT });

    const res = mockRes();
    await CashSessionController.current(staffReq(), res);

    expect(res.body.data).toBeNull();
  });

  it('returns the open session with a live cash tally and expected drawer', async () => {
    const session = seedCashSession({ openingFloat: 200, openedAt: OPENED_AT, userId: cashierId });
    sale({ createdAt: MID_SHIFT, paymentMethod: 'CASH', totalAmount: 150, status: 'COMPLETED' });
    sale({ createdAt: LATE_SHIFT, paymentMethod: 'CASH', totalAmount: 50, status: 'COMPLETED' });
    // Excluded from the drawer: taken before the till opened, non-cash, voided.
    sale({ createdAt: BEFORE_OPEN, paymentMethod: 'CASH', totalAmount: 999, status: 'COMPLETED' });
    sale({ createdAt: MID_SHIFT, paymentMethod: 'CARD', totalAmount: 400, status: 'COMPLETED' });
    sale({ createdAt: MID_SHIFT, paymentMethod: 'CASH', totalAmount: 777, status: 'VOIDED' });

    const res = mockRes();
    await CashSessionController.current(staffReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.id).toBe(session.id);
    expect(res.body.data.cashSalesTotal).toBe(200);
    expect(res.body.data.cashSalesCount).toBe(2);
    // Live expected drawer = float + cash taken so far.
    expect(res.body.data.expectedCash).toBe(400);
    expect(res.body.data.user).toMatchObject({ id: cashierId, name: 'Thandi' });
  });

  it('reports a zero tally (not null) for an open till with no sales yet', async () => {
    seedCashSession({ openingFloat: 120, openedAt: OPENED_AT });

    const res = mockRes();
    await CashSessionController.current(staffReq(), res);

    expect(res.body.data.cashSalesTotal).toBe(0);
    expect(res.body.data.cashSalesCount).toBe(0);
    expect(res.body.data.expectedCash).toBe(120);
  });

  it('does not return another shop’s open till', async () => {
    seedShop({ ownerYeboidSub: '22222222-2222-2222-2222-222222222222' });
    seedCashSession({ shopId: 'shop_2', status: 'OPEN' });

    const res = mockRes();
    await CashSessionController.current(staffReq(), res);

    expect(res.body.data).toBeNull();
  });

  it('401s without an authenticated user', async () => {
    const res = mockRes();
    await CashSessionController.current({ body: {}, params: {} } as any, res);
    expect(res.statusCode).toBe(401);
  });
});

describe('CashSessionController.close — expected vs counted', () => {
  it('computes expected cash from the shift’s cash sales and records the variance', async () => {
    const session = seedCashSession({ openingFloat: 200, openedAt: OPENED_AT });
    sale({ createdAt: MID_SHIFT, paymentMethod: 'CASH', totalAmount: 150, status: 'COMPLETED' });
    sale({ createdAt: LATE_SHIFT, paymentMethod: 'CASH', totalAmount: 50, status: 'COMPLETED' });

    const res = mockRes();
    await CashSessionController.close(
      staffReq({ countedCash: 400, notes: 'balanced' }, { id: session.id }),
      res
    );

    expect(res.statusCode).toBe(200);
    // 200 float + 200 cash sales = 400 expected; counted 400 => square.
    expect(res.body.data).toMatchObject({
      status: 'CLOSED',
      expectedCash: 400,
      countedCash: 400,
      variance: 0,
      notes: 'balanced',
    });
    expect(res.body.data.closedAt).toBeInstanceOf(Date);

    const stored = table('cashSession')[0];
    expect(stored.status).toBe('CLOSED');
    expect(stored.expectedCash).toBe(400);
    expect(stored.variance).toBe(0);
  });

  it('records a NEGATIVE variance when the drawer is short', async () => {
    const session = seedCashSession({ openingFloat: 100, openedAt: OPENED_AT });
    sale({ createdAt: MID_SHIFT, paymentMethod: 'CASH', totalAmount: 500, status: 'COMPLETED' });

    const res = mockRes();
    await CashSessionController.close(staffReq({ countedCash: 570 }, { id: session.id }), res);

    // Expected 600, counted 570 => 30 short. The sign is the whole point: a
    // short drawer must never read as a surplus.
    expect(res.body.data.expectedCash).toBe(600);
    expect(res.body.data.variance).toBe(-30);
  });

  it('records a POSITIVE variance when the drawer is over', async () => {
    const session = seedCashSession({ openingFloat: 100, openedAt: OPENED_AT });
    sale({ createdAt: MID_SHIFT, paymentMethod: 'CASH', totalAmount: 500, status: 'COMPLETED' });

    const res = mockRes();
    await CashSessionController.close(staffReq({ countedCash: 625 }, { id: session.id }), res);

    expect(res.body.data.variance).toBe(25);
  });

  it('excludes sales rung up before the till opened', async () => {
    const session = seedCashSession({ openingFloat: 100, openedAt: OPENED_AT });
    // Yesterday's takings must belong to yesterday's shift.
    sale({ createdAt: BEFORE_OPEN, paymentMethod: 'CASH', totalAmount: 900, status: 'COMPLETED' });
    sale({ createdAt: MID_SHIFT, paymentMethod: 'CASH', totalAmount: 40, status: 'COMPLETED' });

    const res = mockRes();
    await CashSessionController.close(staffReq({ countedCash: 140 }, { id: session.id }), res);

    expect(res.body.data.expectedCash).toBe(140);
    expect(res.body.data.variance).toBe(0);
  });

  it('excludes non-cash and non-COMPLETED sales from the expected drawer', async () => {
    const session = seedCashSession({ openingFloat: 100, openedAt: OPENED_AT });
    sale({ createdAt: MID_SHIFT, paymentMethod: 'CASH', totalAmount: 60, status: 'COMPLETED' });
    sale({ createdAt: MID_SHIFT, paymentMethod: 'CARD', totalAmount: 500, status: 'COMPLETED' });
    sale({ createdAt: MID_SHIFT, paymentMethod: 'MOMO', totalAmount: 300, status: 'COMPLETED' });
    sale({ createdAt: MID_SHIFT, paymentMethod: 'CREDIT', totalAmount: 200, status: 'COMPLETED' });
    sale({ createdAt: MID_SHIFT, paymentMethod: 'CASH', totalAmount: 400, status: 'VOIDED' });
    sale({ createdAt: MID_SHIFT, paymentMethod: 'CASH', totalAmount: 250, status: 'PENDING' });

    const res = mockRes();
    await CashSessionController.close(staffReq({ countedCash: 160 }, { id: session.id }), res);

    // Only the 60 cash sale counts towards the drawer.
    expect(res.body.data.expectedCash).toBe(160);
    expect(res.body.data.variance).toBe(0);
  });

  it('excludes another shop’s cash sales', async () => {
    seedShop({ ownerYeboidSub: '22222222-2222-2222-2222-222222222222' });
    const session = seedCashSession({ openingFloat: 100, openedAt: OPENED_AT });
    sale({ shopId: 'shop_2', createdAt: MID_SHIFT, paymentMethod: 'CASH', totalAmount: 800, status: 'COMPLETED' });

    const res = mockRes();
    await CashSessionController.close(staffReq({ countedCash: 100 }, { id: session.id }), res);

    expect(res.body.data.expectedCash).toBe(100);
    expect(res.body.data.variance).toBe(0);
  });

  it('bounds the tally at the close instant — a future-stamped sale is not counted', async () => {
    const session = seedCashSession({ openingFloat: 100, openedAt: OPENED_AT });
    sale({ createdAt: MID_SHIFT, paymentMethod: 'CASH', totalAmount: 40, status: 'COMPLETED' });
    // A terminal with a skewed clock, or an offline sale synced with a bad
    // timestamp, lands ahead of the cash-up instant. The drawer being counted
    // right now cannot contain it, so it belongs to a later shift — counting it
    // would show a phantom shortage on this one.
    sale({
      createdAt: new Date(Date.now() + 86_400_000),
      paymentMethod: 'CASH',
      totalAmount: 5000,
      status: 'COMPLETED',
    });

    const res = mockRes();
    await CashSessionController.close(staffReq({ countedCash: 140 }, { id: session.id }), res);

    expect(res.body.data.expectedCash).toBe(140);
    expect(res.body.data.variance).toBe(0);
  });

  it('keeps the existing notes when the cash-up sends none', async () => {
    const session = seedCashSession({ openingFloat: 50, openedAt: OPENED_AT, notes: 'opened by Thandi' });

    const res = mockRes();
    await CashSessionController.close(staffReq({ countedCash: 50 }, { id: session.id }), res);

    expect(res.body.data.notes).toBe('opened by Thandi');
  });

  it('404s on a session that does not exist', async () => {
    const res = mockRes();
    await CashSessionController.close(staffReq({ countedCash: 100 }, { id: 'nope' }), res);

    expect(res.statusCode).toBe(404);
    expect(res.body.message).toMatch(/not found/i);
  });

  it('404s on a session belonging to another shop', async () => {
    seedShop({ ownerYeboidSub: '22222222-2222-2222-2222-222222222222' });
    const other = seedCashSession({ shopId: 'shop_2', openingFloat: 100, openedAt: OPENED_AT });

    const res = mockRes();
    await CashSessionController.close(staffReq({ countedCash: 100 }, { id: other.id }), res);

    // Not a 403 leak — the till simply does not exist for this shop.
    expect(res.statusCode).toBe(404);
    expect(table('cashSession')[0].status).toBe('OPEN');
  });

  it('409s on a session that is already closed, without re-writing the figures', async () => {
    const session = seedCashSession({
      status: 'CLOSED',
      openingFloat: 100,
      openedAt: OPENED_AT,
      closedAt: CLOSED_AT,
      countedCash: 300,
      expectedCash: 300,
      variance: 0,
    });

    const res = mockRes();
    await CashSessionController.close(staffReq({ countedCash: 9999 }, { id: session.id }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.message).toMatch(/already closed/i);
    // A second cash-up must not overwrite the original reconciliation.
    const stored = table('cashSession')[0];
    expect(stored.countedCash).toBe(300);
    expect(stored.variance).toBe(0);
    expect(stored.closedAt).toEqual(CLOSED_AT);
  });

  it('401s without an authenticated user', async () => {
    const session = seedCashSession({ openedAt: OPENED_AT });
    const res = mockRes();
    await CashSessionController.close(
      { body: { countedCash: 100 }, params: { id: session.id } } as any,
      res
    );

    expect(res.statusCode).toBe(401);
    expect(table('cashSession')[0].status).toBe('OPEN');
  });
});

describe('CashSessionController.zReport', () => {
  function seedClosedShift() {
    return seedCashSession({
      status: 'CLOSED',
      userId: cashierId,
      openingFloat: 200,
      openedAt: OPENED_AT,
      closedAt: CLOSED_AT,
      countedCash: 390,
      expectedCash: 400,
      variance: -10,
      notes: 'ten short',
    });
  }

  it('returns the aggregate totals for a closed session', async () => {
    const session = seedClosedShift();
    sale({ createdAt: MID_SHIFT, paymentMethod: 'CASH', totalAmount: 150, discount: 10, status: 'COMPLETED' });
    sale({ createdAt: LATE_SHIFT, paymentMethod: 'CASH', totalAmount: 50, discount: 0, status: 'COMPLETED' });
    sale({ createdAt: MID_SHIFT, paymentMethod: 'CARD', totalAmount: 300, discount: 5, status: 'COMPLETED' });

    const res = mockRes();
    await CashSessionController.zReport(staffReq({}, { id: session.id }), res);

    expect(res.statusCode).toBe(200);
    const r = res.body.data;

    expect(r.transactionCount).toBe(3);
    expect(r.gross).toBe(500);
    expect(r.totalDiscount).toBe(15);
    expect(r.net).toBe(485);

    // Cash-up figures come straight off the session.
    expect(r.session).toMatchObject({
      id: session.id,
      status: 'CLOSED',
      openingFloat: 200,
      countedCash: 390,
      expectedCash: 400,
      variance: -10,
      notes: 'ten short',
    });
    expect(r.session.cashier).toMatchObject({ id: cashierId, name: 'Thandi' });
    expect(r.shop).toMatchObject({ name: 'Test Shop', currency: 'SZL', currencySymbol: 'E' });
  });

  it('breaks the shift down by payment method', async () => {
    const session = seedClosedShift();
    sale({ createdAt: MID_SHIFT, paymentMethod: 'CASH', totalAmount: 150, discount: 10, status: 'COMPLETED' });
    sale({ createdAt: LATE_SHIFT, paymentMethod: 'CASH', totalAmount: 50, discount: 0, status: 'COMPLETED' });
    sale({ createdAt: MID_SHIFT, paymentMethod: 'CARD', totalAmount: 300, discount: 5, status: 'COMPLETED' });

    const res = mockRes();
    await CashSessionController.zReport(staffReq({}, { id: session.id }), res);

    const byMethod: any[] = res.body.data.byPaymentMethod;
    const find = (m: string) => byMethod.find((x) => x.method === m);

    expect(byMethod).toHaveLength(2);
    // Each method appears ONCE with its sales rolled up — a per-sale row here
    // would double-count the day.
    expect(find('CASH')).toMatchObject({ total: 200, discount: 10, count: 2 });
    expect(find('CARD')).toMatchObject({ total: 300, discount: 5, count: 1 });
  });

  it('counts only sales inside the openedAt→closedAt window', async () => {
    const session = seedClosedShift();
    sale({ createdAt: BEFORE_OPEN, paymentMethod: 'CASH', totalAmount: 900, status: 'COMPLETED' });
    sale({ createdAt: MID_SHIFT, paymentMethod: 'CASH', totalAmount: 100, status: 'COMPLETED' });
    // Rung up after cash-up: belongs to the NEXT shift, not this z-report.
    sale({ createdAt: AFTER_CLOSE, paymentMethod: 'CASH', totalAmount: 700, status: 'COMPLETED' });

    const res = mockRes();
    await CashSessionController.zReport(staffReq({}, { id: session.id }), res);

    expect(res.body.data.transactionCount).toBe(1);
    expect(res.body.data.gross).toBe(100);
    expect(res.body.data.byPaymentMethod).toHaveLength(1);
    expect(res.body.data.byPaymentMethod[0]).toMatchObject({ method: 'CASH', total: 100, count: 1 });
  });

  it('excludes non-COMPLETED sales and other shops', async () => {
    seedShop({ ownerYeboidSub: '22222222-2222-2222-2222-222222222222' });
    const session = seedClosedShift();
    sale({ createdAt: MID_SHIFT, paymentMethod: 'CASH', totalAmount: 100, status: 'COMPLETED' });
    sale({ createdAt: MID_SHIFT, paymentMethod: 'CASH', totalAmount: 400, status: 'VOIDED' });
    sale({ createdAt: MID_SHIFT, paymentMethod: 'CARD', totalAmount: 250, status: 'REFUNDED' });
    sale({ shopId: 'shop_2', createdAt: MID_SHIFT, paymentMethod: 'CASH', totalAmount: 800, status: 'COMPLETED' });

    const res = mockRes();
    await CashSessionController.zReport(staffReq({}, { id: session.id }), res);

    expect(res.body.data.transactionCount).toBe(1);
    expect(res.body.data.gross).toBe(100);
  });

  it('reports zeros for a shift with no sales', async () => {
    const session = seedClosedShift();

    const res = mockRes();
    await CashSessionController.zReport(staffReq({}, { id: session.id }), res);

    expect(res.statusCode).toBe(200);
    // Zeros, not nulls — an empty shift still has to render.
    expect(res.body.data.transactionCount).toBe(0);
    expect(res.body.data.gross).toBe(0);
    expect(res.body.data.totalDiscount).toBe(0);
    expect(res.body.data.net).toBe(0);
    expect(res.body.data.byPaymentMethod).toEqual([]);
  });

  it('reports on a still-open session up to now', async () => {
    const session = seedCashSession({ openingFloat: 100, openedAt: OPENED_AT });
    sale({ createdAt: MID_SHIFT, paymentMethod: 'CASH', totalAmount: 75, status: 'COMPLETED' });

    const res = mockRes();
    await CashSessionController.zReport(staffReq({}, { id: session.id }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.session.status).toBe('OPEN');
    expect(res.body.data.gross).toBe(75);
    // Not cashed up yet.
    expect(res.body.data.session.countedCash).toBeNull();
    expect(res.body.data.session.variance).toBeNull();
  });

  it('404s on a session that does not exist', async () => {
    const res = mockRes();
    await CashSessionController.zReport(staffReq({}, { id: 'nope' }), res);

    expect(res.statusCode).toBe(404);
    expect(res.body.message).toMatch(/not found/i);
  });

  it('404s on a session belonging to another shop', async () => {
    seedShop({ ownerYeboidSub: '22222222-2222-2222-2222-222222222222' });
    const other = seedCashSession({ shopId: 'shop_2', status: 'CLOSED', openedAt: OPENED_AT, closedAt: CLOSED_AT });

    const res = mockRes();
    await CashSessionController.zReport(staffReq({}, { id: other.id }), res);

    expect(res.statusCode).toBe(404);
  });

  it('401s without an authenticated user', async () => {
    const session = seedClosedShift();
    const res = mockRes();
    await CashSessionController.zReport({ body: {}, params: { id: session.id } } as any, res);

    expect(res.statusCode).toBe(401);
  });
});

describe('open → sell → close → z-report, end to end', () => {
  it('reconciles a full shift consistently across all four endpoints', async () => {
    // 1. Open with a 200 float.
    const openRes = mockRes();
    await CashSessionController.open(staffReq({ openingFloat: 200 }), openRes);
    expect(openRes.statusCode).toBe(201);
    const sessionId = openRes.body.data.id;
    const openedAt: Date = openRes.body.data.openedAt;

    // 2. Ring up the shift. Stamped at the instant the till opened: close()
    // ends its window at `now`, so a timestamp even a second into the future
    // would fall outside the cash-up and is not what a real shift looks like.
    const during = new Date(openedAt.getTime());
    sale({ createdAt: during, paymentMethod: 'CASH', totalAmount: 300, discount: 20, status: 'COMPLETED' });
    sale({ createdAt: during, paymentMethod: 'CARD', totalAmount: 100, discount: 0, status: 'COMPLETED' });

    // 3. /current shows the live drawer before cash-up.
    const currentRes = mockRes();
    await CashSessionController.current(staffReq(), currentRes);
    expect(currentRes.body.data.expectedCash).toBe(500);
    expect(currentRes.body.data.cashSalesCount).toBe(1);

    // 4. Cash up 20 short.
    const closeRes = mockRes();
    await CashSessionController.close(staffReq({ countedCash: 480 }, { id: sessionId }), closeRes);
    expect(closeRes.body.data).toMatchObject({
      status: 'CLOSED',
      expectedCash: 500,
      countedCash: 480,
      variance: -20,
    });

    // 5. The z-report tells the same story, and the till is free again.
    const zRes = mockRes();
    await CashSessionController.zReport(staffReq({}, { id: sessionId }), zRes);
    expect(zRes.body.data.transactionCount).toBe(2);
    expect(zRes.body.data.gross).toBe(400);
    expect(zRes.body.data.session.variance).toBe(-20);

    const afterClose = mockRes();
    await CashSessionController.current(staffReq(), afterClose);
    expect(afterClose.body.data).toBeNull();
  });
});
