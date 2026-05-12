import { Router } from 'express';
import {
  AIController,
  chatSchema,
  voiceSchema,
} from '@controllers/ai.controller';
import { validateRequest } from '@middleware/validation.middleware';
import { authMiddleware } from '@middleware/auth.middleware';
import { aiLimiter } from '@middleware/rateLimit.middleware';
import { requireCredits } from '@middleware/billing.middleware';
import { CREDIT_COSTS } from '@config/creditPacks';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// AI endpoints — pay-as-you-go credits, no tier gates anymore. Each invocation
// deducts credits from the shop's yebopay wallet BEFORE the AI call runs.
// 402 returns "INSUFFICIENT_CREDITS" with the cost, which the frontend maps
// to a "Top up" CTA.
//
// chat + voice = "Pro" workload (multi-turn reasoning + context) → 1 credit
// insights / slow-movers / summary = "Flash" workload (single-pass) → 0.5
router.post(
  '/chat',
  requireCredits(CREDIT_COSTS.AI_PRO, 'AI assistant: chat'),
  aiLimiter,
  validateRequest(chatSchema),
  AIController.chat,
);
router.post(
  '/voice',
  requireCredits(CREDIT_COSTS.AI_PRO, 'AI assistant: voice'),
  aiLimiter,
  validateRequest(voiceSchema),
  AIController.voice,
);
router.get(
  '/insights',
  requireCredits(CREDIT_COSTS.AI_FLASH, 'AI assistant: insights'),
  aiLimiter,
  AIController.getInsights,
);
router.get(
  '/slow-movers',
  requireCredits(CREDIT_COSTS.AI_FLASH, 'AI assistant: slow-movers'),
  aiLimiter,
  AIController.getSlowMovers,
);
router.get(
  '/summary',
  requireCredits(CREDIT_COSTS.AI_FLASH, 'AI assistant: summary'),
  aiLimiter,
  AIController.getSummary,
);

export default router;
