import { Router } from 'express';
import {
  AuthController,
  registerSchema,
  loginSchema,
  userLoginSchema,
  refreshTokenSchema,
} from '@controllers/auth.controller';
import { validateRequest } from '@middleware/validation.middleware';
import { authMiddleware } from '@middleware/auth.middleware';
import { authLimiter } from '@middleware/rateLimit.middleware';

const router = Router();

// Public routes (with rate limiting)
router.post('/register', authLimiter, validateRequest(registerSchema), AuthController.register);
router.post('/login', authLimiter, validateRequest(loginSchema), AuthController.login);
router.post('/login/user', authLimiter, validateRequest(userLoginSchema), AuthController.userLogin);
router.post('/refresh', authLimiter, validateRequest(refreshTokenSchema), AuthController.refreshToken);

// Protected routes
router.get('/me', authMiddleware, AuthController.getMe);

export default router;
