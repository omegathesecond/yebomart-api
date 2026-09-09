import { Router } from 'express';
import {
  AIController,
  chatSchema,
  voiceSchema,
} from '@controllers/ai.controller';
import { validateRequest } from '@middleware/validation.middleware';
import { authMiddleware } from '@middleware/auth.middleware';
import { aiLimiter } from '@middleware/rateLimit.middleware';
import { requireCreditBalance } from '@middleware/billing.middleware';
import { CREDIT_COSTS } from '@config/creditPacks';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// AI endpoints — pay-as-you-go credits, no tier gates anymore. requireCreditBalance
// GATES on the shop having enough credits (402 "INSUFFICIENT_CREDITS" + cost,
// which the frontend maps to a "Top up" CTA) but does NOT debit up front. The
// wallet is only debited once the handler succeeds, via settlePendingCharge —
// so a Gemini outage (or any handler failure) can never bill the shop for a
// call it didn't get. The wallet has no refund endpoint, hence charge-on-success
// rather than charge-then-refund.
//
// Both tiers serve gemini-2.0-flash. The split is interactive vs background,
// NOT model tier: a question the shop typed costs 1 credit, a read it never
// asked for costs 0.5. There is no Pro model behind a Pro price.
router.post(
  '/chat',
  requireCreditBalance(CREDIT_COSTS.AI_QUESTION, 'AI assistant: chat'),
  aiLimiter,
  validateRequest(chatSchema),
  AIController.chat,
);
router.post(
  '/voice',
  requireCreditBalance(CREDIT_COSTS.AI_QUESTION, 'AI assistant: voice'),
  aiLimiter,
  validateRequest(voiceSchema),
  AIController.voice,
);
router.get(
  '/insights',
  requireCreditBalance(CREDIT_COSTS.AI_INSIGHT, 'AI assistant: insights'),
  aiLimiter,
  AIController.getInsights,
);
router.get(
  '/slow-movers',
  requireCreditBalance(CREDIT_COSTS.AI_INSIGHT, 'AI assistant: slow-movers'),
  aiLimiter,
  AIController.getSlowMovers,
);
router.get(
  '/summary',
  requireCreditBalance(CREDIT_COSTS.AI_INSIGHT, 'AI assistant: summary'),
  aiLimiter,
  AIController.getSummary,
);

export default router;
