import { prisma } from '@config/prisma';
import {
  PLANS,
  allowanceFor,
  type MeteredAction,
  type PlanCode,
} from '@config/plans';

/**
 * Entitlements: what a shop's plan already covers, before its credit wallet is
 * touched at all.
 *
 * The layering is deliberate. A metered action first draws down the plan's
 * monthly allowance; only once that is spent does it fall through to
 * pay-as-you-go credits. A shop on the free Till plan has a tiny allowance and
 * therefore falls through almost immediately, which is the whole shape of the
 * business: the plan is the predictable revenue, credits are the overage.
 */

/** The billing period a shop's usage counts against right now. */
export interface Period {
  planCode: PlanCode;
  start: Date;
  /** null for the free plan, which rolls on the calendar rather than a cycle. */
  end: Date | null;
}

/** First instant of the current calendar month, UTC. */
function calendarMonthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Resolve the shop's live plan and the period its usage counts against.
 *
 * Only an ACTIVE subscription grants a paid plan. PENDING (first invoice not
 * yet paid), PAST_DUE (cycle went unpaid) and CANCELED all fall back to Till,
 * so a shop can never keep a paid allowance it has not paid for. The row is
 * still kept in those states so settling the outstanding invoice restores the
 * plan without the owner re-subscribing.
 */
export async function resolvePeriod(shopId: string, now = new Date()): Promise<Period> {
  const sub = await prisma.shopSubscription.findUnique({ where: { shopId } });

  if (
    sub &&
    sub.status === 'ACTIVE' &&
    sub.currentPeriodStart <= now &&
    sub.currentPeriodEnd > now
  ) {
    return { planCode: sub.planCode as PlanCode, start: sub.currentPeriodStart, end: sub.currentPeriodEnd };
  }

  return { planCode: 'TILL', start: calendarMonthStart(now), end: null };
}

export interface AllowanceCheck {
  planCode: PlanCode;
  /** Infinity when the plan does not cap this action. */
  allowance: number;
  used: number;
  remaining: number;
  /** True when the allowance can absorb `qty` without touching credits. */
  covered: boolean;
}

/**
 * Would the plan's allowance cover `qty` of `action`? Reads only — nothing is
 * consumed, so a caller can gate on this and consume later, once the work has
 * actually succeeded.
 */
export async function checkAllowance(
  shopId: string,
  action: MeteredAction,
  qty = 1,
  now = new Date(),
): Promise<AllowanceCheck> {
  const period = await resolvePeriod(shopId, now);
  const allowance = allowanceFor(period.planCode, action);

  if (allowance === Infinity) {
    return { planCode: period.planCode, allowance, used: 0, remaining: Infinity, covered: true };
  }
  if (allowance <= 0) {
    return { planCode: period.planCode, allowance: 0, used: 0, remaining: 0, covered: false };
  }

  const row = await prisma.usageCounter.findUnique({
    where: { shopId_periodStart_action: { shopId, periodStart: period.start, action } },
  });
  const used = row ? Number(row.used) : 0;
  const remaining = Math.max(0, allowance - used);

  return { planCode: period.planCode, allowance, used, remaining, covered: remaining >= qty };
}

/**
 * Consume `qty` of the plan's allowance, returning whether it was actually
 * covered. Call this only after the work succeeded.
 *
 * The increment is a single atomic upsert; when it overshoots the allowance the
 * increment is rolled back and the caller is told it was not covered, so the
 * overage falls through to credits. Two concurrent callers can both pass an
 * earlier `checkAllowance` and land here together — at worst that serves one
 * extra message, which is the same benign race the credit gate already accepts,
 * and far preferable to holding a lock across a network send.
 */
export async function consumeAllowance(
  shopId: string,
  action: MeteredAction,
  qty = 1,
  now = new Date(),
): Promise<boolean> {
  const period = await resolvePeriod(shopId, now);
  const allowance = allowanceFor(period.planCode, action);

  if (allowance <= 0) return false;

  const row = await prisma.usageCounter.upsert({
    where: { shopId_periodStart_action: { shopId, periodStart: period.start, action } },
    create: { shopId, periodStart: period.start, action, used: qty },
    update: { used: { increment: qty } },
  });

  if (allowance === Infinity) return true;

  if (Number(row.used) <= allowance) return true;

  // Overshot: give the units back so the counter keeps reflecting what the
  // allowance actually paid for, and let the caller bill credits instead.
  await prisma.usageCounter.update({
    where: { id: row.id },
    data: { used: { decrement: qty } },
  });
  return false;
}

/** Per-action allowance usage for the shop's current period, for the UI. */
export async function usageSummary(shopId: string, now = new Date()) {
  const period = await resolvePeriod(shopId, now);
  const plan = PLANS[period.planCode];

  const rows = await prisma.usageCounter.findMany({
    where: { shopId, periodStart: period.start },
  });
  const usedBy = new Map(rows.map((r) => [r.action, Number(r.used)]));

  const actions = Object.keys(plan.allowances) as MeteredAction[];
  return {
    plan_code: period.planCode,
    period_start: period.start.toISOString(),
    period_end: period.end ? period.end.toISOString() : null,
    allowances: actions.map((action) => {
      const allowance = allowanceFor(period.planCode, action);
      const used = usedBy.get(action) ?? 0;
      return {
        action,
        allowance: Number.isFinite(allowance) ? allowance : null,
        used,
        remaining: Number.isFinite(allowance) ? Math.max(0, allowance - used) : null,
      };
    }),
  };
}
