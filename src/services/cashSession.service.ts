import { prisma } from '@config/prisma';
import { Prisma } from '@prisma/client';
import { round2 } from '@utils/tax';

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
 * authoritative cash Sale rows and confirmed Return payouts for this session —
 * rather than trusting a running counter, so a power-cut mid-shift or an
 * offline-synced sale never desyncs the expected total.
 */
export class CashSessionService {
  /** Cash belongs to the drawer locked by checkout, never a timestamp window. */
  private static async cashSalesTotal(
    shopId: string,
    sessionId: string,
    db: Prisma.TransactionClient = prisma,
  ) {
    const agg = await db.sale.aggregate({
      where: {
        shopId,
        status: 'COMPLETED',
        paymentMethod: 'CASH',
        cashSessionId: sessionId,
      },
      _sum: { totalAmount: true },
      _count: true,
    });

    return {
      total: agg._sum.totalAmount ?? 0,
      count: agg._count,
    };
  }

  private static async cashRefundsTotal(shopId: string, sessionId: string, db: Prisma.TransactionClient = prisma) {
    const refunds = await db.return.aggregate({
      where: { shopId, cashSessionId: sessionId, status: 'COMPLETED',
        type: 'REFUND', settlementMethod: 'CASH', settledAt: { not: null } },
      _sum: { refundAmount: true },
      _count: true,
    });
    return { total: round2(refunds._sum.refundAmount ?? 0), count: refunds._count };
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

    try {
      return await prisma.cashSession.create({
        data: {
          shopId: input.shopId,
          userId: input.userId ?? undefined,
          openingFloat: input.openingFloat,
        },
        include: {
          user: { select: { id: true, name: true } },
        },
      });
    } catch (error) {
      // The partial unique index is the authority when concurrent opens both
      // pass the friendly pre-check above. Do not hide unrelated DB failures.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        Array.isArray(error.meta?.target) &&
        error.meta.target.includes('shopId')
      ) {
        const conflict = new Error(
          'A till session is already open for this shop',
        );
        (conflict as any).code = 'CONFLICT';
        throw conflict;
      }
      throw error;
    }
  }

  /**
   * The currently OPEN session for a shop (or null), plus a live tally of the
   * cash assigned to it so the POS can show running expected drawer.
   */
  static async getCurrent(shopId: string) {
    const session = await prisma.cashSession.findFirst({
      where: { shopId, status: 'OPEN' },
      include: {
        user: { select: { id: true, name: true } },
      },
    });

    if (!session) return null;

    const cashSales = await this.cashSalesTotal(shopId, session.id);

    const refunds = await this.cashRefundsTotal(shopId, session.id);
    return {
      ...session,
      cashRefundsTotal: refunds.total,
      cashRefundsCount: refunds.count,
      cashSalesTotal: cashSales.total,
      cashSalesCount: cashSales.count,
      // Live drawer = float + cash sales - confirmed cash payouts.
      expectedCash: round2(session.openingFloat + cashSales.total - refunds.total),
    };
  }

  /**
   * Hold the same guarded row-update lock as close until the caller commits.
   * A missing/already closing till leaves checkout unassigned. DB failures
   * propagate; they must never masquerade as the absence of an open drawer.
   * Acquire before sale/product locks, as refund settlement does. A supplied
   * session ID requires that exact drawer to remain open (cash-sale voids).
   */
  static async lockOpenSessionId(tx: Prisma.TransactionClient, shopId: string, sessionId?: string): Promise<string | null> {
    const session = sessionId ? { id: sessionId } : await tx.cashSession.findFirst({
      where: { shopId, status: 'OPEN' }, select: { id: true },
    });
    if (!session) return null;
    const locked = await tx.cashSession.updateMany({
      where: { id: session.id, shopId, status: 'OPEN' },
      data: { status: 'OPEN' },
    });
    if (sessionId && locked.count !== 1) {
      throw new Error('Cannot void a cash sale from a closed till. Use the return/refund settlement flow to record the refund.');
    }
    return locked.count === 1 ? session.id : null;
  }

  /**
   * Cash up: close the session, compute expectedCash from cash sales during the
   * shift less recorded cash refunds, record the variance. Done in a transaction so the close + computed
   * figures commit atomically.
   */
  static async close(input: CloseSessionInput) {
    return prisma.$transaction(async (tx) => {
      const session = await tx.cashSession.findFirst({
        where: { id: input.sessionId, shopId: input.shopId },
      });
      if (!session) {
        const err = new Error('Cash session not found');
        (err as any).code = 'NOT_FOUND';
        throw err;
      }

      // PostgreSQL rechecks this predicate after waiting on a competing
      // update. Only the winner may reconcile; rollback releases the claim
      // if any subsequent query fails. No intermediate CLOSED row is visible.
      const claimed = await tx.cashSession.updateMany({
        where: { id: session.id, shopId: input.shopId, status: 'OPEN' },
        data: { status: 'CLOSED' },
      });
      if (claimed.count !== 1) {
        const err = new Error('Cash session is already closed');
        (err as any).code = 'CONFLICT';
        throw err;
      }

      const now = new Date();
      const cashSales = await this.cashSalesTotal(
        input.shopId,
        session.id,
        tx,
      );
      const refunds = await this.cashRefundsTotal(input.shopId, session.id, tx);
      const expectedCash = round2(session.openingFloat + cashSales.total - refunds.total);
      return tx.cashSession.update({
        where: { id: session.id },
        data: {
          closedAt: now,
          countedCash: input.countedCash,
          expectedCash,
          variance: input.countedCash - expectedCash,
          notes: input.notes ?? session.notes,
        },
        include: { user: { select: { id: true, name: true } } },
      });
    });
  }

  /**
   * Z-report: end-of-shift summary for a session. Totals by payment method,
   * transaction count, gross/net, and the cash-up figures (float, expected,
   * counted, variance). Cash uses session membership; other payments use openedAt → closedAt.
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
    const createdAt: Prisma.DateTimeFilter = {
      gte: session.openedAt,
      lte: windowEnd,
    };

    // One snapshot supplies both the summary and payment breakdown. Never
    // recompute historical VAT using the shop's current tax configuration.
    const sales = await prisma.sale.findMany({
      where: { shopId, status: 'COMPLETED', OR: [
        { paymentMethod: 'CASH', cashSessionId: session.id },
        { paymentMethod: { not: 'CASH' }, createdAt },
      ] },
      include: { items: { select: { discount: true } } },
    });
    const sum = (values: number[]) => round2(values.reduce((a, b) => a + b, 0));
    const discountOf = (sale: typeof sales[number]) =>
      sale.discount + sale.items.reduce((total, item) => total + item.discount, 0);
    const totalDiscount = sum(sales.map(discountOf));
    // Subtotal already deducts line discounts. Restore those for gross at
    // recorded prices (VAT-inclusive for inclusive sales, exclusive otherwise).
    const gross = sum(sales.map(sale =>
      sale.subtotal + sale.items.reduce((total, item) => total + item.discount, 0)));
    const totalAmount = sum(sales.map(sale => sale.totalAmount));
    const tax = sum(sales.map(sale => sale.tax));
    const net = round2(totalAmount - tax);
    const methods = [...new Set(sales.map(sale => sale.paymentMethod))];
    const byPaymentMethod = methods.map(method => {
      const matching = sales.filter(sale => sale.paymentMethod === method);
      return {
        method,
        total: sum(matching.map(sale => sale.totalAmount)),
        discount: sum(matching.map(discountOf)),
        count: matching.length,
      };
    });

    const refunds = await this.cashRefundsTotal(shopId, session.id);
    return {
      cashRefundsTotal: refunds.total,
      cashRefundsCount: refunds.count,
      session: {
        id: session.id,
        status: session.status,
        openingFloat: session.openingFloat,
        openedAt: session.openedAt,
        closedAt: session.closedAt,
        countedCash: session.countedCash,
        expectedCash: session.status === 'CLOSED' ? session.expectedCash : round2(session.openingFloat + (byPaymentMethod.find(m => m.method === 'CASH')?.total ?? 0) - refunds.total),
        variance: session.variance,
        notes: session.notes,
        cashier: session.user,
      },
      shop: session.shop,
      transactionCount: sales.length,
      gross,
      totalDiscount,
      // Net revenue excludes persisted VAT; charged total includes it.
      net,
      tax,
      totalAmount,
      byPaymentMethod,
    };
  }
}
