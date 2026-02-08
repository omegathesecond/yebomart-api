import rateLimit from 'express-rate-limit';
import { AuthRequest } from './auth.middleware';
import { prisma } from '@config/prisma';

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

// AI endpoints - based on tier
export const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: async (req) => {
    const authReq = req as AuthRequest;
    if (!authReq.user) return 50; // Unauthenticated

    try {
      const shop = await prisma.shop.findUnique({
        where: { id: authReq.user.shopId },
        select: { tier: true },
      });

      switch (shop?.tier) {
        case 'ENTERPRISE':
          return 10000; // Unlimited for enterprise
        case 'BUSINESS':
          return 5000; // 5000 per hour
        case 'PRO':
          return 1000; // 1000 per hour
        default:
          return 100; // Free tier: 100 per hour
      }
    } catch {
      return 100;
    }
  },
  message: {
    success: false,
    message: 'AI request limit reached. Upgrade your plan for more.',
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
