import { prisma } from '@config/prisma';
import { Prisma } from '@prisma/client';

interface OpenSessionInput {
  shopId: string;
  // null for shop-owner tokens (no User row); set for staff (PIN) tokens.
  userId?: string | null;
  openingFloat: number;
}

interface CloseSessionInput {
  sessionId: string;
  shopId: string;
  countedCash: number;
  notes?: string;
}

/**
 * Cash-drawer / shift management.
 *
 * A CashSession represents one cashier's till from open (starting float) to
 * close (end-of-day cash-up). The reconciliation is intentionally computed from
 * the authoritative Sale rows — cash, COMPLETED, created during the session —
 * rather than trusting a running counter, so a power-cut mid-shift or an
 * offline-synced sale never desyncs the expected total.
 */
export class CashSessionService {
  /**
   * Cash actually taken into the drawer during a session: COMPLETED sales paid
   * with CASH for this shop since the session opened. We match on
   * createdAt >= openedAt rather than cashSessionId alone so that a sale rung up
   * in the tiny window before its cashSessionId was attached (or an offline sale
   * synced late) still counts.
   *
   * The physical cash that lands in the till per sale is the customer's cash
   * TENDERED (Sale.amountPaid) minus the CHANGE handed back (Sale.change), which
   * by definition equals the sale total. We derive the expected drawer from the
   * persisted tendered/change (rather than just summing totalAmount) so the
   * cash-up can surface the real tendered-vs-change breakdown and reconcile
   * over/short against what the cashier actually counted out. Legacy rows have
   * change = 0 and amountPaid = total, so net is unchanged for them.
   */
  private static async cashSalesTotal(shopId: string, openedAt: Date, closedAt?: Date | null) {
    const createdAt: Prisma.DateTimeFilter = { gte: openedAt };
    if (closedAt) createdAt.lte = closedAt;

    const agg = await prisma.sale.aggregate({
      where: {
        shopId,
        status: 'COMPLETED',
        paymentMethod: 'CASH',
        createdAt,
      },
      _sum: { amountPaid: true, change: true },
      _count: true,
    });

    const tendered = agg._sum.amountPaid ?? 0;
    const change = agg._sum.change ?? 0;

    return {
      // Net cash that should be in the drawer for these sales = tendered − change.
      net: tendered - change,
      tendered,
      change,
      count: agg._count,
    };
  }

  /**
   * Open a till for a shop. Rejects (throws CONFLICT) if one is already open —
   * a shop has at most one live drawer at a time.
   */
  static async open(input: OpenSessionInput) {
    const existing = await prisma.cashSession.findFirst({
      where: { shopId: input.shopId, status: 'OPEN' },
    });
    if (existing) {
      const err = new Error('A till session is already open for this shop');
      (err as any).code = 'CONFLICT';
      throw err;
    }

    return prisma.cashSession.create({
      data: {
        shopId: input.shopId,
        userId: input.userId ?? undefined,
        openingFloat: input.openingFloat,
      },
      include: {
        user: { select: { id: true, name: true } },
      },
    });
  }

  /**
   * The currently OPEN session for a shop (or null), plus a live tally of the
   * cash taken since it opened so the POS can show running expected drawer.
   */
  static async getCurrent(shopId: string) {
    const session = await prisma.cashSession.findFirst({
      where: { shopId, status: 'OPEN' },
      include: {
        user: { select: { id: true, name: true } },
      },
    });

    if (!session) return null;

    const cashSales = await this.cashSalesTotal(shopId, session.openedAt);

    return {
      ...session,
      cashSalesTotal: cashSales.net,
      cashSalesCount: cashSales.count,
      // Tendered/change tally so the POS can show the drawer breakdown live.
      cashTendered: cashSales.tendered,
      cashChangeGiven: cashSales.change,
      // Live expected drawer = float + net cash taken so far.
      expectedCash: session.openingFloat + cashSales.net,
    };
  }

  /**
   * Find the OPEN session id for a shop, if any. Used by sale creation to tag
   * cash sales. Best-effort — never throws.
   */
  static async findOpenSessionId(shopId: string): Promise<string | null> {
    const session = await prisma.cashSession.findFirst({
      where: { shopId, status: 'OPEN' },
      select: { id: true },
    });
    return session?.id ?? null;
  }

  /**
   * Cash up: close the session, compute expectedCash from cash sales during the
   * shift, record the variance. Done in a transaction so the close + computed
   * figures commit atomically.
   */
  static async close(input: CloseSessionInput) {
    const session = await prisma.cashSession.findFirst({
      where: { id: input.sessionId, shopId: input.shopId },
    });

    if (!session) {
      const err = new Error('Cash session not found');
      (err as any).code = 'NOT_FOUND';
      throw err;
    }
    if (session.status === 'CLOSED') {
      const err = new Error('Cash session is already closed');
      (err as any).code = 'CONFLICT';
      throw err;
    }

    const now = new Date();
    const cashSales = await this.cashSalesTotal(input.shopId, session.openedAt, now);
    const expectedCash = session.openingFloat + cashSales.net;
    const variance = input.countedCash - expectedCash;

    return prisma.$transaction(async (tx) => {
      return tx.cashSession.update({
        where: { id: session.id },
        data: {
          status: 'CLOSED',
          closedAt: now,
          countedCash: input.countedCash,
          expectedCash,
          variance,
          notes: input.notes ?? session.notes,
        },
        include: {
          user: { select: { id: true, name: true } },
        },
      });
    });
  }

  /**
   * Z-report: end-of-shift summary for a session. Totals by payment method,
   * transaction count, gross/net, and the cash-up figures (float, expected,
   * counted, variance). Window is openedAt → closedAt (or now if still open).
   */
  static async zReport(sessionId: string, shopId: string) {
    const session = await prisma.cashSession.findFirst({
      where: { id: sessionId, shopId },
      include: {
        user: { select: { id: true, name: true } },
        shop: { select: { name: true, currency: true, currencySymbol: true } },
      },
    });

    if (!session) {
      const err = new Error('Cash session not found');
      (err as any).code = 'NOT_FOUND';
      throw err;
    }

    const windowEnd = session.closedAt ?? new Date();
    const createdAt: Prisma.DateTimeFilter = { gte: session.openedAt, lte: windowEnd };

    // Cash-drawer tally for this window — tendered in, change out, net retained.
    const cashDrawer = await this.cashSalesTotal(shopId, session.openedAt, windowEnd);

    const [byMethod, totals] = await Promise.all([
      prisma.sale.groupBy({
        by: ['paymentMethod'],
        where: { shopId, status: 'COMPLETED', createdAt },
        _sum: { totalAmount: true, discount: true },
        _count: true,
      }),
      prisma.sale.aggregate({
        where: { shopId, status: 'COMPLETED', createdAt },
        _sum: { totalAmount: true, discount: true },
        _count: true,
      }),
    ]);

    const gross = totals._sum.totalAmount ?? 0;
    const totalDiscount = totals._sum.discount ?? 0;

    return {
      session: {
        id: session.id,
        status: session.status,
        openingFloat: session.openingFloat,
        openedAt: session.openedAt,
        closedAt: session.closedAt,
        countedCash: session.countedCash,
        expectedCash: session.expectedCash,
        variance: session.variance,
        notes: session.notes,
        cashier: session.user,
      },
      shop: session.shop,
      // Cash drawer reconciliation tally: how much cash customers handed over
      // (tendered), how much change was given back, and the net retained in the
      // till — the figure expectedCash is built from.
      cashDrawer: {
        tendered: cashDrawer.tendered,
        changeGiven: cashDrawer.change,
        netCash: cashDrawer.net,
      },
      transactionCount: totals._count,
      // Gross = sum of totalAmount (which already nets line discounts/sale
      // discount). Net here = gross − sale-level discounts removed at header.
      gross,
      totalDiscount,
      net: gross - totalDiscount,
      byPaymentMethod: byMethod.map((m) => ({
        method: m.paymentMethod,
        total: m._sum.totalAmount ?? 0,
        discount: m._sum.discount ?? 0,
        count: m._count,
      })),
    };
  }
}
