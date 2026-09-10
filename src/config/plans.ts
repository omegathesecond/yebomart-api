/**
 * YeboMart plans.
 *
 * Held in code, not a table: there are three of them, they change rarely, and
 * an allowance is only meaningful alongside the entitlement code that reads
 * it. The authoritative *price* a customer pays still comes from the YeboPay
 * invoice we raise, so a plan price change here only affects invoices issued
 * after the deploy — never one already sent.
 *
 * Margins are measured against landed cost (see creditPacks.ts for the full
 * cost table). One YeboMart credit is E1 ≈ USD 0.055; a WhatsApp message costs
 * us 1 YeboLink credit ≈ USD 0.070 ≈ E1.27.
 *
 * | Plan | Price   | Included WhatsApp sends | Landed cost | Margin |
 * |------|---------|-------------------------|-------------|--------|
 * | TILL | free    | none                    | infra only  | —      |
 * | SHOP | E199/mo | 31 reports + 10 alerts + 30 customer = 71 | ~$4.97 | 55% |
 * | BUSY | E499/mo | 31 reports + 20 alerts + 150 customer = 201 | ~$14.07 | 49% |
 *
 * The assistant is unlimited on both paid plans on purpose: a Gemini Flash
 * answer against a capped prompt costs us a fraction of a cent, so it is the
 * cheapest thing we serve and the best reason to choose YeboMart. Metering it
 * would cost more in goodwill than it could ever recover.
 */

/** Actions whose consumption is metered against a plan allowance. */
export type MeteredAction =
  | 'AI_QUESTION'
  | 'AI_INSIGHT'
  | 'WHATSAPP'
  | 'DAILY_REPORT'
  | 'LOW_STOCK_ALERT';

export type PlanCode = 'TILL' | 'SHOP' | 'BUSY';

/** An allowance of `Infinity` is unlimited; a missing action means zero. */
export interface PlanDefinition {
  code: PlanCode;
  name: string;
  tagline: string;
  /** Monthly price in SZL. TILL is free. */
  priceSzl: number;
  /** Whether the nightly report + low-stock alerts run for this plan at all. */
  automatedMessages: boolean;
  allowances: Partial<Record<MeteredAction, number>>;
  features: string[];
}

export const PLANS: Record<PlanCode, PlanDefinition> = {
  TILL: {
    code: 'TILL',
    name: 'Till',
    tagline: 'Everything in the app, free forever',
    priceSzl: 0,
    automatedMessages: false,
    allowances: { AI_QUESTION: 20 },
    features: [
      'POS, stock, staff PINs and cash-up',
      'Suppliers, purchase orders and the credit book',
      'Reports, audit log and VAT',
      '20 assistant questions a month',
    ],
  },
  SHOP: {
    code: 'SHOP',
    name: 'Shop',
    tagline: 'The day’s numbers on your WhatsApp, every evening',
    priceSzl: 199,
    automatedMessages: true,
    allowances: {
      AI_QUESTION: Infinity,
      AI_INSIGHT: Infinity,
      DAILY_REPORT: 31,
      LOW_STOCK_ALERT: 10,
      WHATSAPP: 30,
    },
    features: [
      'Everything in Till',
      'Daily WhatsApp report at closing time',
      'Low-stock alerts',
      'Unlimited assistant questions',
      '30 WhatsApp messages to your customers',
    ],
  },
  BUSY: {
    code: 'BUSY',
    name: 'Busy',
    tagline: 'For shops with a queue and staff on shift',
    priceSzl: 499,
    automatedMessages: true,
    allowances: {
      AI_QUESTION: Infinity,
      AI_INSIGHT: Infinity,
      DAILY_REPORT: 31,
      LOW_STOCK_ALERT: 20,
      WHATSAPP: 150,
    },
    features: [
      'Everything in Shop',
      '150 WhatsApp messages to your customers',
      'Priority WhatsApp support',
    ],
  },
};

/** Plans a shop can actually buy. TILL is the absence of a subscription. */
export const PAID_PLAN_CODES = ['SHOP', 'BUSY'] as const;

export function getPlan(code: PlanCode): PlanDefinition {
  return PLANS[code];
}

export function allowanceFor(code: PlanCode, action: MeteredAction): number {
  return PLANS[code].allowances[action] ?? 0;
}

/** JSON-safe view: Infinity is not representable, so unlimited becomes null. */
export function planToDto(p: PlanDefinition) {
  return {
    code: p.code,
    name: p.name,
    tagline: p.tagline,
    price_szl: p.priceSzl,
    automated_messages: p.automatedMessages,
    features: p.features,
    allowances: Object.fromEntries(
      Object.entries(p.allowances).map(([k, v]) => [k, Number.isFinite(v) ? v : null]),
    ),
  };
}
