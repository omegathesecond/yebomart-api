/**
 * The plan table is where pricing meets cost, so these lock the numbers the
 * margins were computed from. A silent allowance bump is the cheapest way to
 * turn a 55% margin into a loss, and nothing else in the codebase would notice.
 *
 * Cost basis (creditPacks.ts): a WhatsApp message costs 1 YeboLink credit,
 * about USD 0.070. One YeboMart credit is E1, about USD 0.055.
 */
import { describe, it, expect } from 'vitest';
import { PLANS, PAID_PLAN_CODES, allowanceFor, planToDto, type PlanCode } from './plans';

const WHATSAPP_COST_USD = 0.07;
const SZL_PER_USD = 1 / 0.055;

/** Every WhatsApp send a plan can make in a month, across all its buckets. */
function includedWhatsAppSends(code: PlanCode): number {
  const a = PLANS[code].allowances;
  return (a.DAILY_REPORT ?? 0) + (a.LOW_STOCK_ALERT ?? 0) + (a.WHATSAPP ?? 0);
}

describe('plan definitions', () => {
  it('only SHOP and BUSY are purchasable — Till is the absence of a plan', () => {
    expect([...PAID_PLAN_CODES]).toEqual(['SHOP', 'BUSY']);
    expect(PLANS.TILL.priceSzl).toBe(0);
  });

  it('the free plan includes no automated messages', () => {
    // This is the rule that stops an unpaid shop costing us a WhatsApp a night.
    expect(PLANS.TILL.automatedMessages).toBe(false);
    expect(allowanceFor('TILL', 'DAILY_REPORT')).toBe(0);
    expect(allowanceFor('TILL', 'LOW_STOCK_ALERT')).toBe(0);
    expect(allowanceFor('TILL', 'WHATSAPP')).toBe(0);
  });

  it('the free plan still lets a shop try the assistant', () => {
    expect(allowanceFor('TILL', 'AI_QUESTION')).toBe(20);
  });

  it('paid plans include automated messages and an uncapped assistant', () => {
    for (const code of PAID_PLAN_CODES) {
      expect(PLANS[code].automatedMessages).toBe(true);
      expect(allowanceFor(code, 'AI_QUESTION')).toBe(Infinity);
      expect(allowanceFor(code, 'DAILY_REPORT')).toBeGreaterThanOrEqual(31);
    }
  });

  it.each([...PAID_PLAN_CODES])('%s clears a 45%% gross margin on messaging', (code) => {
    const costUsd = includedWhatsAppSends(code) * WHATSAPP_COST_USD;
    const priceUsd = PLANS[code].priceSzl / SZL_PER_USD;
    const margin = (priceUsd - costUsd) / priceUsd;

    expect(costUsd).toBeLessThan(priceUsd);
    expect(margin).toBeGreaterThan(0.45);
  });

  it('costs more but includes more as you go up', () => {
    expect(PLANS.BUSY.priceSzl).toBeGreaterThan(PLANS.SHOP.priceSzl);
    expect(includedWhatsAppSends('BUSY')).toBeGreaterThan(includedWhatsAppSends('SHOP'));
  });

  it('serialises unlimited as null, since Infinity is not valid JSON', () => {
    const dto = planToDto(PLANS.SHOP);
    expect(dto.allowances.AI_QUESTION).toBeNull();
    expect(dto.allowances.WHATSAPP).toBe(30);
    expect(JSON.parse(JSON.stringify(dto)).allowances.AI_QUESTION).toBeNull();
  });

  it('treats an action the plan never mentions as zero, not undefined', () => {
    expect(allowanceFor('TILL', 'WHATSAPP')).toBe(0);
  });
});
