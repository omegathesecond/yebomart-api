import { Router } from 'express';
import {
  AIController,
  chatSchema,
  voiceSchema,
} from '@controllers/ai.controller';
import { validateRequest } from '@middleware/validation.middleware';
import { authMiddleware } from '@middleware/auth.middleware';
import { aiLimiter } from '@middleware/rateLimit.middleware';
import { requireFeature, checkAiUsage } from '@middleware/license.middleware';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// AI endpoints - available on ALL tiers (usage-limited per tier)
// LITE: 10/mo, STARTER: 50/mo, BUSINESS: 200/mo, PRO: 1000/mo, ENTERPRISE: unlimited
router.post('/chat', requireFeature('ai_assistant'), checkAiUsage, aiLimiter, validateRequest(chatSchema), AIController.chat);
router.post('/voice', requireFeature('ai_assistant'), checkAiUsage, aiLimiter, validateRequest(voiceSchema), AIController.voice);
router.get('/insights', checkAiUsage, aiLimiter, AIController.getInsights);
router.get('/slow-movers', checkAiUsage, aiLimiter, AIController.getSlowMovers);
router.get('/summary', checkAiUsage, aiLimiter, AIController.getSummary);

export default router;
