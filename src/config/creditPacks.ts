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

// Per-action credit costs. Tweak as cost-recovery dictates.
export const CREDIT_COSTS = {
  AI_FLASH: 0.5,        // Gemini 2.0 Flash query
  AI_PRO: 1,            // Gemini 2.0 Pro query
  SMS: 1,
  WHATSAPP: 2,
  EMAIL: 1,
} as const;
