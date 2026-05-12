import rateLimit from 'express-rate-limit';
import { AuthRequest } from './auth.middleware';

// Standard rate limiter - very high for supermarket operations
export const standardLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10000, // 10000 requests per window
  message: {
    success: false,
    message: 'Too many requests, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Auth endpoints - reasonable limit
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100, // 100 attempts per 15 minutes
  message: {
    success: false,
    message: 'Too many login attempts, please try again later',
  },
});

// AI endpoints — flat rate-limit per authenticated shop. Cost recovery is
// per-query credit charging (see requireCredits middleware); this rate limit
// only exists to protect against runaway loops / abuse, not to enforce
// billing.
export const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: (req) => {
    const authReq = req as AuthRequest;
    return authReq.user ? 1000 : 50; // 1000/hr per authed shop; 50/hr unauthed
  },
  message: {
    success: false,
    message: 'AI rate limit reached. Try again in a few minutes.',
  },
});

// POS endpoints - very high for busy supermarket
export const posLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 1000, // 1000 requests per minute
  message: {
    success: false,
    message: 'Too many requests, please slow down',
  },
});
