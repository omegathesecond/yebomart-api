/**
 * Credit packs for yebomart's pay-as-you-go billing.
 *
 * 1 credit = E1 (SZL); pack discounts apply at top-up time. All credits in the
 * shop's yebopay wallet are valued 1:1 at the SZL anchor — discounts are pure
 * bonus credits, not a separate currency.
 *
 * Adding a new pack: extend CREDIT_PACKS. The frontend renders the catalog
 * from /api/billing/credit-packs.
 */

export interface CreditPack {
  id: 'STARTER' | 'STANDARD' | 'BULK';
  name: string;
  description: string;
  // What the shop pays (in their local currency, SZL anchor).
  priceSzl: number;
  // Credits delivered to the wallet on payment.
  credits: number;
  // For UI: % saved vs the 1:1 price.
  discountPercent: number;
}

export const CREDIT_PACKS: CreditPack[] = [
  {
    id: 'STARTER',
    name: 'Starter pack',
    description: '100 credits — enough to try out AI + send a few messages',
    priceSzl: 100,
    credits: 100,
    discountPercent: 0,
  },
  {
    id: 'STANDARD',
    name: 'Standard pack',
    description: '500 credits — covers a busy shop for ~2 weeks of AI + comms',
    priceSzl: 450,
    credits: 500,
    discountPercent: 10,
  },
  {
    id: 'BULK',
    name: 'Bulk pack',
    description: '2000 credits — best value, lasts a typical shop ~2 months',
    priceSzl: 1600,
    credits: 2000,
    discountPercent: 20,
  },
];

export function findPack(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find((p) => p.id === id);
}

/**
 * Per-action credit costs, priced off LANDED COST, not guesswork.
 *
 * Cost basis (see yebolink/api/src/config/pricing.ts, the source of truth):
 *   - YeboLink sells credits at $0.070 (its deepest pack) to $0.080 (list).
 *   - 1 YeboMart credit = E1 = ~$0.055 (SZL is pegged 1:1 to ZAR).
 *
 * | Action        | YeboLink cost        | = SZL   | We charge | Margin |
 * |---------------|----------------------|---------|-----------|--------|
 * | WhatsApp      | 1 credit    ($0.070) | E1.27   | 3 credits | 58%    |
 * | Email         | 0.1 credit  ($0.007) | E0.13   | 1 credit  | 87%    |
 * | SMS (SZ)      | 8 cr/segment ($0.56) | E10.18  | 20 credits| 49%    |
 * | AI question   | Gemini Flash <$0.001 | E0.02   | 1 credit  | 98%    |
 *
 * SMS is deliberately expensive because it IS expensive: one Eswatini segment
 * costs 8x a WhatsApp message. Pricing it at parity (the old `SMS: 1`) lost
 * roughly E9 on every send. The price steers traffic to WhatsApp, which is
 * both cheaper for us and a better experience for the customer.
 *
 * SMS is also billed per SEGMENT by carriers (160 GSM-7 chars), and this flat
 * rate covers one segment to the home market. Long or international messages
 * still cost us more than we charge — see the destination-aware TODO in
 * docs before enabling SMS as a routine channel.
 */
export const CREDIT_COSTS = {
  /** Interactive question to the assistant (chat + voice). Serves Flash. */
  AI_QUESTION: 1,
  /** Background read the shop did not explicitly ask for (insights, summary). */
  AI_INSIGHT: 0.5,
  SMS: 20,
  WHATSAPP: 3,
  EMAIL: 1,
} as const;
