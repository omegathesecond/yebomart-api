import { prisma } from '@config/prisma';
import { PLANS, type PlanCode } from '@config/plans';
import { YeboPayClient } from '@services/yebopay.client';
import { YeboLinkClient } from '@services/yebolink.client';

/**
 * YeboMart plan subscriptions, billed by invoice.
 *
 * YeboMart owns the recurrence here rather than delegating to YeboPay's
 * Subscription object, because that object only supports charging a vaulted
 * card: `POST /v1/subscriptions` hard-requires a `payment_method_id`, and
 * YeboPay's own `createSubscription` rejects MOBILE_MONEY instruments for
 * recurring billing. In this market that would exclude most shop owners.
 *
 * So each cycle we raise a YeboPay *invoice* instead, which keeps everything
 * YeboPay is genuinely good at — PDF rendering, delivery through YeboLink, a
 * hosted pay page that accepts any rail, the hourly overdue sweep and dunning
 * reminders, and an `invoice.paid` webhook back to us — while leaving the
 * billing period, entitlements and allowances where they belong, next to the
 * shop they govern.
 */

/** Days a plan invoice stays payable before the cycle is treated as unpaid. */
const INVOICE_DUE_DAYS = 7;

export class SubscriptionError extends Error {
  constructor(
    message: string,
    readonly code: 'NO_EMAIL' | 'ALREADY_SUBSCRIBED' | 'NOT_SUBSCRIBED' | 'UNKNOWN_PLAN',
  ) {
    super(message);
    this.name = 'SubscriptionError';
  }
}

function addMonths(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCMonth(out.getUTCMonth() + n);
  return out;
}

/**
 * Raise and deliver one cycle's invoice, recording it against the
 * subscription.
 *
 * The invoice id is persisted BEFORE `/send` is called. Anything that fails
 * after the email has gone out would otherwise leave a delivered invoice the
 * shop cannot be matched to when `invoice.paid` arrives.
 */
async function issueCycleInvoice(opts: {
  subscriptionId: string;
  shopId: string;
  planCode: PlanCode;
  periodStart: Date;
  periodEnd: Date;
}): Promise<{ invoiceId: string; payUrl: string }> {
  const shop = await prisma.shop.findUnique({
    where: { id: opts.shopId },
    select: { name: true, ownerName: true, ownerEmail: true, ownerYeboidSub: true, currency: true },
  });
  if (!shop) throw new SubscriptionError('Shop not found', 'NOT_SUBSCRIBED');
  if (!shop.ownerEmail) {
    throw new SubscriptionError(
      'This shop has no owner email on file, and a plan invoice has to be delivered somewhere. Add one in Settings first.',
      'NO_EMAIL',
    );
  }

  const plan = PLANS[opts.planCode];
  const period = `${opts.periodStart.toISOString().slice(0, 10)} to ${opts.periodEnd.toISOString().slice(0, 10)}`;

  const invoice = await YeboPayClient.createInvoice({
    yeboidSub: shop.ownerYeboidSub,
    currency: shop.currency || 'SZL',
    dueDate: new Date(Date.now() + INVOICE_DUE_DAYS * 86_400_000).toISOString(),
    lineItems: [
      {
        description: `YeboMart ${plan.name} plan — ${period}`,
        quantity: 1,
        unitPrice: plan.priceSzl,
      },
    ],
    toEmail: shop.ownerEmail,
    toName: shop.ownerName,
    description: `${plan.name} plan for ${shop.name}`,
    metadata: {
      yebomart_shop_id: opts.shopId,
      yebomart_subscription_id: opts.subscriptionId,
      yebomart_plan: opts.planCode,
      yebomart_period_start: opts.periodStart.toISOString(),
    },
  });

  // Persist before delivery — see the docstring.
  await prisma.shopSubscription.update({
    where: { id: opts.subscriptionId },
    data: {
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      invoiceIssuedAt: new Date(),
      invoicePayUrl: null,
    },
  });

  const sent = await YeboPayClient.sendInvoice(invoice.id);

  await prisma.shopSubscription.update({
    where: { id: opts.subscriptionId },
    data: { invoicePayUrl: sent.payUrl },
  });

  return { invoiceId: invoice.id, payUrl: sent.payUrl };
}

/**
 * Start a plan. The subscription is PENDING — and therefore still on free-tier
 * entitlements — until the first invoice is paid.
 */
export async function subscribe(shopId: string, planCode: PlanCode) {
  if (planCode === 'TILL') {
    throw new SubscriptionError('Till is the free plan; there is nothing to subscribe to.', 'UNKNOWN_PLAN');
  }

  const existing = await prisma.shopSubscription.findUnique({ where: { shopId } });
  if (existing && existing.status === 'ACTIVE' && !existing.cancelAtPeriodEnd) {
    throw new SubscriptionError(
      `This shop is already on the ${PLANS[existing.planCode as PlanCode].name} plan.`,
      'ALREADY_SUBSCRIBED',
    );
  }

  const periodStart = new Date();
  const periodEnd = addMonths(periodStart, 1);

  const sub = await prisma.shopSubscription.upsert({
    where: { shopId },
    create: {
      shopId,
      planCode,
      status: 'PENDING',
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
    },
    update: {
      planCode,
      status: 'PENDING',
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      invoiceId: null,
      invoiceNumber: null,
      invoicePayUrl: null,
      invoiceIssuedAt: null,
    },
  });

  const { payUrl } = await issueCycleInvoice({
    subscriptionId: sub.id,
    shopId,
    planCode,
    periodStart,
    periodEnd,
  });

  return { subscription: await prisma.shopSubscription.findUnique({ where: { id: sub.id } }), payUrl };
}

/**
 * Mark the cycle funded by `invoiceId` as paid. Driven by YeboPay's
 * `invoice.paid` webhook, and idempotent so a redelivered event is harmless.
 */
export async function markInvoicePaid(invoiceId: string): Promise<boolean> {
  const sub = await prisma.shopSubscription.findUnique({ where: { invoiceId } });
  if (!sub) return false;
  if (sub.status === 'ACTIVE') return true;

  const wasLapsed = Boolean(sub.lapsedNotifiedAt) || sub.status === 'PAST_DUE';

  await prisma.shopSubscription.update({
    where: { id: sub.id },
    // Cleared so a future lapse notifies again rather than being suppressed
    // by a marker from the last one.
    data: { status: 'ACTIVE', lapsedNotifiedAt: null },
  });

  // Only worth saying when something had actually stopped. A first-cycle
  // activation needs no announcement — they just bought it.
  if (wasLapsed) {
    const shop = await prisma.shop.findUnique({ where: { id: sub.shopId }, select: { name: true } });
    await notifyOwner(
      sub.shopId,
      buildResumedMessage(shop?.name ?? 'Your shop', PLANS[sub.planCode as PlanCode].name),
    );
  }
  return true;
}

/**
 * Ask YeboPay whether an invoice has been paid, and activate the cycle if so.
 *
 * This is the POLL half of the paid/not-paid question — the half that does not
 * depend on a webhook arriving. Returns true when the cycle was (or already
 * is) funded and must NOT be lapsed.
 *
 * A lookup failure returns false rather than throwing: YeboPay being briefly
 * unreachable should not abort a whole renewal pass. That errs toward lapsing
 * a shop that may have paid, which is recoverable — the next pass, or the
 * webhook, restores them — whereas throwing would strand every later
 * subscription in the batch.
 */
async function reconcileInvoice(invoiceId: string): Promise<boolean> {
  try {
    const invoice = await YeboPayClient.getInvoice(invoiceId);
    if (invoice.status !== 'PAID') return false;

    console.warn(
      `[subscriptions] invoice ${invoiceId} is PAID at YeboPay but we were never told — ` +
        'activating on reconcile. Check webhook delivery.',
    );
    return await markInvoicePaid(invoiceId);
  } catch (err: any) {
    console.error(`[subscriptions] could not reconcile invoice ${invoiceId}: ${err?.message ?? err}`);
    return false;
  }
}

/**
 * Stop at the end of the paid period. The shop keeps what it paid for and is
 * simply not invoiced again — no refund maths, no mid-cycle downgrade.
 */
export async function cancel(shopId: string) {
  const sub = await prisma.shopSubscription.findUnique({ where: { shopId } });
  if (!sub || sub.status === 'CANCELED') {
    throw new SubscriptionError('This shop is not on a paid plan.', 'NOT_SUBSCRIBED');
  }

  return prisma.shopSubscription.update({
    where: { id: sub.id },
    data: { cancelAtPeriodEnd: true, canceledAt: new Date() },
  });
}

/**
 * What the owner is told when the plan pauses.
 *
 * Deliberately not a demand for money — YeboPay is already chasing the
 * invoice. This says the one thing only YeboMart knows: which parts of their
 * shop just went quiet, and which did not. A shop owner who stops receiving
 * the evening report with no explanation assumes the product broke.
 */
export function buildLapseMessage(shopName: string, planName: string, invoiceNumber: string | null, payUrl: string | null): string {
  const lines = [
    `${shopName}: your ${planName} plan is paused${invoiceNumber ? ` — invoice ${invoiceNumber} is unpaid` : ''}.`,
    '',
    'Your till, stock, staff and reports all keep working exactly as they are. Nothing is locked.',
    '',
    'What stops until it is settled:',
    '• The evening WhatsApp report',
    '• Low-stock alerts',
    '• Unlimited assistant questions (you keep 20 a month)',
  ];
  if (payUrl) lines.push('', `Settle it here: ${payUrl}`);
  return lines.join('\n');
}

/** The other half of the loop: tell them it is working again. */
export function buildResumedMessage(shopName: string, planName: string): string {
  return [
    `${shopName}: payment received — your ${planName} plan is active again.`,
    '',
    'Your evening report is back tonight, and low-stock alerts and unlimited assistant questions are on now.',
  ].join('\n');
}

/**
 * Send a plan message and report whether it went.
 *
 * These bypass the plan allowance and the credit wallet on purpose. Billing a
 * shop to be told its billing has failed is absurd, and charging an allowance
 * the lapse has just revoked could not work anyway. The cost (about E1.27 a
 * message) is ours, and it is far cheaper than a silent churn.
 */
async function notifyOwner(shopId: string, text: string): Promise<boolean> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { name: true, ownerPhone: true, notifyPhone: true },
  });
  const recipient = shop?.notifyPhone ?? shop?.ownerPhone;
  if (!recipient) {
    console.warn(`[subscriptions] shop ${shopId} has no recipient phone; cannot send plan notice`);
    return false;
  }
  try {
    await YeboLinkClient.sendWhatsApp(recipient, text);
    return true;
  } catch (err: any) {
    console.error(`[subscriptions] plan notice FAILED for shop ${shopId}: ${err?.message ?? err}`);
    return false;
  }
}

export interface RenewalSummary {
  considered: number;
  invoiced: number;
  lapsed: number;
  ended: number;
  /** Cycles found already PAID at YeboPay whose webhook never reached us. A
   *  number that is persistently non-zero means webhook delivery is degraded. */
  reconciled: number;
  /** Owners told their plan paused. Lower than `lapsed` when a send failed;
   *  those retry on the next pass. */
  lapseNoticesSent: number;
  failures: Array<{ shopId: string; error: string }>;
}

/**
 * One renewal pass, fired by Cloud Scheduler.
 *
 * Three things happen to a subscription whose period has run out:
 *   - cancelAtPeriodEnd → CANCELED, no further invoices;
 *   - ACTIVE            → roll to the next period and invoice it;
 *   - PENDING/PAST_DUE  → the cycle was never paid, so it lapses to PAST_DUE
 *                          and the shop drops to free-tier entitlements. The
 *                          row is kept, so paying the outstanding invoice
 *                          still restores the plan.
 */
export async function runRenewals(now = new Date()): Promise<RenewalSummary> {
  const due = await prisma.shopSubscription.findMany({
    where: { currentPeriodEnd: { lte: now }, status: { in: ['ACTIVE', 'PENDING', 'PAST_DUE'] } },
  });

  const summary: RenewalSummary = { considered: due.length, invoiced: 0, lapsed: 0, ended: 0, reconciled: 0, lapseNoticesSent: 0, failures: [] };

  for (const sub of due) {
    try {
      if (sub.cancelAtPeriodEnd) {
        await prisma.shopSubscription.update({ where: { id: sub.id }, data: { status: 'CANCELED' } });
        summary.ended++;
        continue;
      }

      if (sub.status !== 'ACTIVE') {
        // Before penalising anyone, ASK. YeboPay does not retry a failed
        // webhook delivery, so `invoice.paid` is best-effort — a shop can have
        // paid days ago and the event simply never arrived. Lapsing on the
        // absence of a webhook would take a paying shop's features away and
        // then tell them their plan had paused, which is the worst message we
        // could send to someone who just paid us.
        if (sub.invoiceId) {
          const reconciled = await reconcileInvoice(sub.invoiceId);
          if (reconciled) {
            summary.reconciled++;
            continue;
          }
        }

        await prisma.shopSubscription.update({ where: { id: sub.id }, data: { status: 'PAST_DUE' } });
        summary.lapsed++;

        // Once per lapse, not once per night: a lapsed row stays due forever,
        // so `lapsedNotifiedAt` is what stops this becoming a daily nag. A
        // failed send leaves it null and is retried on the next pass.
        if (!sub.lapsedNotifiedAt) {
          const shop = await prisma.shop.findUnique({ where: { id: sub.shopId }, select: { name: true } });
          const sent = await notifyOwner(
            sub.shopId,
            buildLapseMessage(
              shop?.name ?? 'Your shop',
              PLANS[sub.planCode as PlanCode].name,
              sub.invoiceNumber,
              sub.invoicePayUrl,
            ),
          );
          if (sent) {
            await prisma.shopSubscription.update({
              where: { id: sub.id },
              data: { lapsedNotifiedAt: new Date() },
            });
            summary.lapseNoticesSent++;
          }
        }
        continue;
      }

      const periodStart = sub.currentPeriodEnd;
      const periodEnd = addMonths(periodStart, 1);

      // PENDING again until the new cycle's invoice is paid: entitlements
      // follow the money, not the calendar.
      await prisma.shopSubscription.update({
        where: { id: sub.id },
        data: { status: 'PENDING', currentPeriodStart: periodStart, currentPeriodEnd: periodEnd },
      });

      await issueCycleInvoice({
        subscriptionId: sub.id,
        shopId: sub.shopId,
        planCode: sub.planCode as PlanCode,
        periodStart,
        periodEnd,
      });
      summary.invoiced++;
    } catch (err: any) {
      console.error(`[subscriptions] renewal FAILED for shop ${sub.shopId}: ${err?.message ?? err}`);
      summary.failures.push({ shopId: sub.shopId, error: err?.message ?? String(err) });
    }
  }

  return summary;
}
