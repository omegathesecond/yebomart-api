/**
 * Tests for the AI insights no-silent-fallback guarantee.
 *
 * GET /api/ai/insights pre-charges the shop's wallet (requireCredits) BEFORE
 * the handler runs. The previous implementation swallowed AI failures and
 * returned canned rule-based text as if it were a successful AI result — both a
 * silent fallback (CLAUDE.md violation) and billing for output never produced.
 *
 * The contract we assert here: when the model call fails or returns something
 * unparseable, generateInsights throws AIUnavailableError (the route layer maps
 * that to a loud 503 + a credit refund) — it NEVER returns canned "offline"
 * insights dressed up as AI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Force a configured-but-failing model so we exercise the failure path
// regardless of whether GEMINI_API_KEY happens to be set in the env.
const generateContent = vi.fn();
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({ generateContent }),
  })),
}));

import { AIService, AIUnavailableError } from './ai.service';
import { prisma } from '@config/prisma';

// getShopContext touches many tables the in-memory fake doesn't model; stub it
// (and the one extra weekSales aggregate) so the test targets the AI branch.
const MINIMAL_CONTEXT = {
  todaySales: { totalSales: 0, totalTransactions: 0, averageBasket: 0, topProducts: [] },
  lowStockAlerts: { total: 0, items: { critical: [], low: [], warning: [] } },
};

beforeEach(() => {
  vi.restoreAllMocks();
  generateContent.mockReset();
  vi.spyOn(AIService as any, 'getShopContext').mockResolvedValue(MINIMAL_CONTEXT);
  (prisma as any).sale.aggregate = vi
    .fn()
    .mockResolvedValue({ _sum: { totalAmount: 0 }, _count: 0 });
  (prisma as any).aIConversation = { create: vi.fn().mockResolvedValue({}) };
});

describe('AIService.generateInsights', () => {
  it('throws AIUnavailableError when the model call fails (no canned fallback)', async () => {
    generateContent.mockRejectedValue(new Error('gemini upstream 503'));

    await expect(AIService.generateInsights({ shopId: 'shop_1' })).rejects.toBeInstanceOf(
      AIUnavailableError,
    );
  });

  it('throws AIUnavailableError when the model returns an unparseable response', async () => {
    generateContent.mockResolvedValue({ response: { text: () => 'sorry, I cannot help' } });

    await expect(AIService.generateInsights({ shopId: 'shop_1' })).rejects.toBeInstanceOf(
      AIUnavailableError,
    );
  });

  it('returns real AI insights (not offline) when the model responds with valid JSON', async () => {
    generateContent.mockResolvedValue({
      response: {
        text: () =>
          '[{"title":"Stock up","insight":"Bread selling fast","action":"Reorder","priority":"high"}]',
      },
    });

    const result: any = await AIService.generateInsights({ shopId: 'shop_1' });
    expect(result.insights).toHaveLength(1);
    expect(result.insights[0].title).toBe('Stock up');
    // The success payload must NOT be flagged offline — it is genuine AI output.
    expect(result.offline).toBeUndefined();
  });
});
