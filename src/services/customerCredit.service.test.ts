import { describe, it, expect } from 'vitest';
import { creditBalanceChange, evaluateCredit } from './customerCredit.service';

describe('creditBalanceChange', () => {
  it('PURCHASE increases what the customer owes', () => {
    expect(creditBalanceChange('PURCHASE', 100)).toBe(100);
  });

  it('PAYMENT reduces the balance', () => {
    expect(creditBalanceChange('PAYMENT', 100)).toBe(-100);
  });

  it('REFUND reduces the balance', () => {
    expect(creditBalanceChange('REFUND', 40)).toBe(-40);
  });

  it('ADJUSTMENT applies its signed amount (bug #2: was a no-op)', () => {
    expect(creditBalanceChange('ADJUSTMENT', 25)).toBe(25); // positive correction
    expect(creditBalanceChange('ADJUSTMENT', -25)).toBe(-25); // negative correction
  });

  it('throws on an unknown type rather than silently returning 0', () => {
    expect(() => creditBalanceChange('WAT' as any, 10)).toThrow(/Unknown credit type/);
  });
});

describe('evaluateCredit — ADJUSTMENT moves the balance (bug #2)', () => {
  it('a positive ADJUSTMENT raises the balance', () => {
    const r = evaluateCredit({ type: 'ADJUSTMENT', amount: 30, currentBalance: 100, creditLimit: 0 });
    expect(r.balanceChange).toBe(30);
    expect(r.newBalance).toBe(130);
  });

  it('a negative ADJUSTMENT lowers the balance', () => {
    const r = evaluateCredit({ type: 'ADJUSTMENT', amount: -30, currentBalance: 100, creditLimit: 0 });
    expect(r.balanceChange).toBe(-30);
    expect(r.newBalance).toBe(70);
  });
});

describe('evaluateCredit — credit limit enforcement (bug #1)', () => {
  it('flags a PURCHASE that pushes the balance over the limit', () => {
    const r = evaluateCredit({ type: 'PURCHASE', amount: 60, currentBalance: 50, creditLimit: 100 });
    expect(r.newBalance).toBe(110);
    expect(r.exceedsLimit).toBe(true);
  });

  it('allows a PURCHASE that stays within the limit', () => {
    const r = evaluateCredit({ type: 'PURCHASE', amount: 40, currentBalance: 50, creditLimit: 100 });
    expect(r.newBalance).toBe(90);
    expect(r.exceedsLimit).toBe(false);
  });

  it('allows a PURCHASE that lands exactly on the limit', () => {
    const r = evaluateCredit({ type: 'PURCHASE', amount: 50, currentBalance: 50, creditLimit: 100 });
    expect(r.newBalance).toBe(100);
    expect(r.exceedsLimit).toBe(false);
  });

  it('treats creditLimit <= 0 as "no limit" (unlimited)', () => {
    const zero = evaluateCredit({ type: 'PURCHASE', amount: 9999, currentBalance: 0, creditLimit: 0 });
    expect(zero.exceedsLimit).toBe(false);
  });

  it('never blocks a PAYMENT, even with a huge outstanding balance', () => {
    const r = evaluateCredit({ type: 'PAYMENT', amount: 10, currentBalance: 5000, creditLimit: 100 });
    expect(r.exceedsLimit).toBe(false);
    expect(r.newBalance).toBe(4990);
  });

  it('never blocks a REFUND', () => {
    const r = evaluateCredit({ type: 'REFUND', amount: 10, currentBalance: 5000, creditLimit: 100 });
    expect(r.exceedsLimit).toBe(false);
  });

  it('flags a positive ADJUSTMENT that breaches the limit', () => {
    const r = evaluateCredit({ type: 'ADJUSTMENT', amount: 80, currentBalance: 50, creditLimit: 100 });
    expect(r.exceedsLimit).toBe(true);
  });

  it('does not flag a negative ADJUSTMENT (it reduces debt)', () => {
    const r = evaluateCredit({ type: 'ADJUSTMENT', amount: -80, currentBalance: 50, creditLimit: 100 });
    expect(r.exceedsLimit).toBe(false);
    expect(r.newBalance).toBe(-30);
  });

  it('tolerates float noise around the limit boundary', () => {
    // 0.1 + 0.2 = 0.30000000000000004 in IEEE-754; rounding keeps this at-limit.
    const r = evaluateCredit({ type: 'PURCHASE', amount: 0.2, currentBalance: 0.1, creditLimit: 0.3 });
    expect(r.newBalance).toBe(0.3);
    expect(r.exceedsLimit).toBe(false);
  });
});
