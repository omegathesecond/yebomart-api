import { Router } from 'express';
import {
  AuthController,
  yeboidExchangeSchema,
  userLoginSchema,
} from '@controllers/auth.controller';
import { validateRequest } from '@middleware/validation.middleware';
import { authMiddleware } from '@middleware/auth.middleware';
import { authLimiter } from '@middleware/rateLimit.middleware';

const router = Router();

// Shop OWNER OAuth exchange — frontend completes YeboID OAuth, POSTs the
// resulting access_token here. We validate the token + look up (or create)
// the shop. No yebomart-issued token is returned; future requests use the
// YeboID access_token directly.
router.post(
  '/yeboid/exchange',
  authLimiter,
  validateRequest(yeboidExchangeSchema),
  AuthController.yeboidExchange,
);

// Staff (cashier / manager) PIN login. yebomart-internal HS256 JWT issued.
router.post(
  '/login/user',
  authLimiter,
  validateRequest(userLoginSchema),
  AuthController.userLogin,
);

// Current authenticated entity's profile (works for both auth modes).
router.get('/me', authMiddleware, AuthController.getMe);

export default router;
