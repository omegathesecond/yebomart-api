/**
 * The lapse notice is the only thing that explains a shop going quiet, so its
 * content is a real invariant. An owner whose evening report just stopped will
 * otherwise conclude the product broke — and churn without ever telling us.
 */
import { describe, it, expect } from 'vitest';
import { buildLapseMessage, buildResumedMessage } from './subscription.service';

describe('buildLapseMessage', () => {
  const msg = () => buildLapseMessage("Thandi's Tuckshop", 'Shop', 'INV-2026-000412', 'https://yebopay.app/checkout/x');

  it('names the shop, the plan and the unpaid invoice', () => {
    const m = msg();
    expect(m).toContain("Thandi's Tuckshop");
    expect(m).toContain('Shop plan is paused');
    expect(m).toContain('INV-2026-000412');
  });

  it('says plainly that the shop still works', () => {
    // The single most important line: nothing is locked. A shop owner who
    // thinks their till is held hostage will not come back.
    expect(msg()).toContain('keep working');
    expect(msg()).toContain('Nothing is locked');
  });

  it('lists exactly what stopped', () => {
    const m = msg();
    expect(m).toContain('evening WhatsApp report');
    expect(m).toContain('Low-stock alerts');
    expect(m).toContain('20 a month');
  });

  it('carries the payment link when there is one', () => {
    expect(msg()).toContain('https://yebopay.app/checkout/x');
  });

  it('omits the invoice number and link rather than printing null', () => {
    const m = buildLapseMessage('Corner Shop', 'Busy', null, null);
    expect(m).not.toContain('null');
    expect(m).not.toContain('undefined');
    expect(m).not.toContain('Settle it here');
    expect(m).toContain('Busy plan is paused');
  });
});

describe('buildResumedMessage', () => {
  it('confirms the plan is back and what returns', () => {
    const m = buildResumedMessage("Thandi's Tuckshop", 'Shop');
    expect(m).toContain('payment received');
    expect(m).toContain('active again');
    expect(m).toContain('report is back tonight');
    expect(m).not.toContain('undefined');
  });
});
