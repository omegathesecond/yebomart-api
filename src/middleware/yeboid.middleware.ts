/**
 * YeboID Bearer-token middleware for shop-owner-facing routes.
 *
 * Verifies the JWT against YeboID's JWKS, attaches `req.yeboidUserId` for
 * downstream handlers. Mirrors yebopay's authenticateYeboID — the canonical
 * Omevision pattern. Staff routes use a separate `authenticateStaff`
 * middleware (PIN-issued yebomart-internal token).
 */

import type { Request, Response, NextFunction } from 'express';
import { JwksValidator, extractBearerToken } from '@yebo/mcp-server';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      yeboidUserId?: string;
    }
  }
}

const YEBOID_JWKS_URI = process.env.YEBOID_JWKS_URI ?? 'https://api.yeboid.com/.well-known/jwks.json';
const YEBOID_ISSUER = process.env.YEBOID_ISSUER ?? 'https://api.yeboid.com';

let cachedValidator: JwksValidator | null = null;
function getValidator(): JwksValidator {
  if (cachedValidator) return cachedValidator;
  cachedValidator = new JwksValidator({ jwksUri: YEBOID_JWKS_URI, issuer: YEBOID_ISSUER });
  return cachedValidator;
}

export async function authenticateYeboID(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    res.status(401).json({ success: false, message: 'Bearer token required' });
    return;
  }
  try {
    const auth = await getValidator().verify(token);
    req.yeboidUserId = auth.userId;
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired YeboID token' });
  }
}
