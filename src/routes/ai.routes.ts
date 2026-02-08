import { Router } from 'express';
import {
  AIController,
  chatSchema,
  voiceSchema,
} from '@controllers/ai.controller';
import { validateRequest } from '@middleware/validation.middleware';
import { authMiddleware } from '@middleware/auth.middleware';
import { aiLimiter } from '@middleware/rateLimit.middleware';
import { requireFeature } from '@middleware/license.middleware';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// AI endpoints - require PRO/BUSINESS tier for full AI features
// Basic insights available to all, but chat/voice require ai_assistant feature
router.post('/chat', requireFeature('ai_assistant'), aiLimiter, validateRequest(chatSchema), AIController.chat);
router.post('/voice', requireFeature('ai_assistant'), aiLimiter, validateRequest(voiceSchema), AIController.voice);
router.get('/insights', aiLimiter, AIController.getInsights);
router.get('/slow-movers', aiLimiter, AIController.getSlowMovers);
router.get('/summary', aiLimiter, AIController.getSummary);

export default router;
