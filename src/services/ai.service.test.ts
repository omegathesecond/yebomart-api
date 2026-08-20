/**
 * Tests for AIService.generateInsights fail-loud behaviour.
 *
 * The workspace "no silent fallbacks" rule: when the AI is unavailable,
 * generateInsights must THROW — it must NOT return locally-computed canned
 * "offline" insights dressed up as a real AI result (which would also let the
 * route bill the shop for an AI call that never ran).
 *
 * GEMINI_API_KEY is captured at module-load time, so we re-import the service
 * with the key removed (vi.resetModules) to exercise the unconfigured guard
 * deterministically, independent of the ambient shell.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const savedKey = process.env.GEMINI_API_KEY;

afterEach(() => {
  if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedKey;
  vi.resetModules();
});

describe('AIService.generateInsights — no canned data when AI is unconfigured', () => {
  it('throws "AI service not configured" instead of returning offline insights', async () => {
    vi.resetModules();
    delete process.env.GEMINI_API_KEY;

    const { AIService } = await import('./ai.service');

    await expect(AIService.generateInsights({ shopId: 'shop_1' })).rejects.toThrow(/not configured/i);
  });
});
