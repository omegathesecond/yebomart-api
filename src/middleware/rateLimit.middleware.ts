import rateLimit from 'express-rate-limit';
import { AuthRequest } from './auth.middleware';
import { prisma } from '@config/prisma';

// Standard rate limiter
export const standardLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: {
    success: false,
    message: 'Too many requests, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Auth endpoints - stricter
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // 10 attempts per 15 minutes
  message: {
    success: false,
    message: 'Too many login attempts, please try again later',
  },
});

// AI endpoints - based on tier
export const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: async (req) => {
    const authReq = req as AuthRequest;
    if (!authReq.user) return 10; // Unauthenticated

    try {
      const shop = await prisma.shop.findUnique({
        where: { id: authReq.user.shopId },
        select: { tier: true },
      });

      switch (shop?.tier) {
        case 'BUSINESS':
          return 500; // 500 per hour
        case 'PRO':
          return 100; // 100 per hour
        default:
          return 20; // Free tier: 20 per hour
      }
    } catch {
      return 20;
    }
  },
  message: {
    success: false,
    message: 'AI request limit reached. Upgrade your plan for more.',
  },
});

// POS endpoints - lenient but still limited
export const posLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute (1 per second average)
  message: {
    success: false,
    message: 'Too many requests, please slow down',
  },
});
