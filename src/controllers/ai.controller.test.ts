/**
 * Tests for the AI insights endpoint's fail-loud + billing-integrity contract.
 *
 * Two guarantees, both from the workspace "no silent fallbacks" rule:
 *   1. when the AI call fails, the endpoint surfaces a real error — it must NOT
 *      return locally-computed canned "insights" masquerading as an AI result;
 *   2. the shop is NOT charged a credit for a failed AI call (the wallet debit
 *      is deferred to settlePendingCharge, which only runs after success).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// `@config/prisma` is redirected to the in-memory fake via vitest.config alias.
import { AIController } from './ai.controller';
import { AIService } from '../services/ai.service';
import { BillingService } from '../services/billing.service';

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: any) => {
    res.body = body;
    return res;
  };
  res.send = () => res;
  return res;
}

// A request as it looks AFTER requireCreditBalance has gated it: a PendingCharge
// is stashed, ready for the handler to settle on success.
function reqWithPendingCharge(): any {
  return {
    user: { id: 'user_1', shopId: 'shop_1', role: 'OWNER' },
    originalUrl: '/api/ai/insights',
    pendingCharge: { amount: 0.5, description: 'AI assistant: insights' },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('AIController.getInsights — error surfacing + billing integrity', () => {
  it('returns a 500 error (NOT canned insights) when the AI call throws, and does NOT charge', async () => {
    vi.spyOn(AIService, 'generateInsights').mockRejectedValue(new Error('Gemini 503 unavailable'));
    const charge = vi.spyOn(BillingService, 'chargeShopCredits');

    const req = reqWithPendingCharge();
    const res = mockRes();

    await AIController.getInsights(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
    // No fabricated insights array — the failure is surfaced, not masked.
    expect(res.body.data).toBeUndefined();
    // The crux: a failed AI call must never bill the shop.
    expect(charge).not.toHaveBeenCalled();
  });

  it('charges exactly one credit settlement after a successful AI result', async () => {
    vi.spyOn(AIService, 'generateInsights').mockResolvedValue({
      insights: [{ title: 'Real AI', insight: 'x', action: 'y', priority: 'low' }],
      generated: new Date(),
    } as any);
    const charge = vi.spyOn(BillingService, 'chargeShopCredits').mockResolvedValue({} as any);

    const req = reqWithPendingCharge();
    const res = mockRes();

    await AIController.getInsights(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.insights[0].title).toBe('Real AI');
    expect(charge).toHaveBeenCalledOnce();
    expect(charge).toHaveBeenCalledWith(expect.objectContaining({ amount: 0.5, shopId: 'shop_1' }));
  });
});
