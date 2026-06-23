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
   * Sum of cash taken during a session: COMPLETED sales paid with CASH for this
   * shop since the session opened. We match on createdAt >= openedAt rather than
   * cashSessionId alone so that a sale rung up in the tiny window before its
   * cashSessionId was attached (or an offline sale synced late) still counts.
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
      _sum: { totalAmount: true },
      _count: true,
    });

    return {
      total: agg._sum.totalAmount ?? 0,
      count: agg._count,
    };
  }

  /**
   * Sum of cash paid OUT of the drawer for refunds during a session: COMPLETED
   * REFUND returns tied to this session (ReturnController.process links a cash
   * refund to the OPEN session when it completes). This is the counterpart to
   * cashSalesTotal — money leaving the till — so expected drawer cash is
   * openingFloat + cash sales − cash refunds.
   */
  private static async cashRefundsTotal(sessionId: string) {
    const agg = await prisma.return.aggregate({
      where: {
        cashSessionId: sessionId,
        type: 'REFUND',
        status: 'COMPLETED',
      },
      _sum: { refundAmount: true },
      _count: true,
    });

    return {
      total: agg._sum.refundAmount ?? 0,
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

    const [cashSales, cashRefunds] = await Promise.all([
      this.cashSalesTotal(shopId, session.openedAt),
      this.cashRefundsTotal(session.id),
    ]);

    return {
      ...session,
      cashSalesTotal: cashSales.total,
      cashSalesCount: cashSales.count,
      cashRefundsTotal: cashRefunds.total,
      cashRefundsCount: cashRefunds.count,
      // Live expected drawer = float + cash taken − cash refunded.
      expectedCash: session.openingFloat + cashSales.total - cashRefunds.total,
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
    const [cashSales, cashRefunds] = await Promise.all([
      this.cashSalesTotal(input.shopId, session.openedAt, now),
      this.cashRefundsTotal(session.id),
    ]);
    // Expected physical cash = opening float + cash sales − cash refunds paid out.
    const expectedCash = session.openingFloat + cashSales.total - cashRefunds.total;
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

    const cashRefunds = await this.cashRefundsTotal(session.id);

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
      cashRefunds: {
        total: cashRefunds.total,
        count: cashRefunds.count,
      },
      shop: session.shop,
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
