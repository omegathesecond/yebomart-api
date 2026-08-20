/**
 * Unified yebomart auth middleware.
 *
 * Two valid tokens:
 *   - YeboID Bearer (RS256, JWKS-validated)  → shop OWNER. We look up the
 *     Shop by ownerYeboidSub and populate req.user with the owner shape.
 *   - Staff HS256 Bearer (yebomart-signed)   → cashier/manager. PIN-issued.
 *
 * Routes don't need to know which; they read `req.user.shopId` + role.
 * For admin-dashboard routes, `authenticateAdmin` is the separate path
 * (yebomart-issued admin tokens — that's an internal-staff concern).
 */

import { Request, Response, NextFunction } from 'express';
import { JWTUtil, IDecodedToken } from '@utils/jwt';
import { ApiResponse } from '@utils/ApiResponse';
import { UserRole, AdminRole } from '@prisma/client';
import { JwksValidator, extractBearerToken } from '@yebo/mcp-server';
import { prisma } from '@config/prisma';

export interface AuthRequest extends Request {
  user?: IDecodedToken;
  yeboidUserId?: string;
}

const YEBOID_JWKS_URI = process.env.YEBOID_JWKS_URI ?? 'https://api.yeboid.com/.well-known/jwks.json';
const YEBOID_ISSUER = process.env.YEBOID_ISSUER ?? 'https://api.yeboid.com';

let cachedJwksValidator: JwksValidator | null = null;
function getJwksValidator(): JwksValidator {
  if (cachedJwksValidator) return cachedJwksValidator;
  cachedJwksValidator = new JwksValidator({ jwksUri: YEBOID_JWKS_URI, issuer: YEBOID_ISSUER });
  return cachedJwksValidator;
}

/**
 * Authenticate a request as a shop OWNER (YeboID JWT) or STAFF member
 * (yebomart-signed HS256). Populates req.user uniformly. Most routes use this.
 */
export const authMiddleware = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      ApiResponse.unauthorized(res, 'No token provided');
      return;
    }

    // Try YeboID first — RS256 + JWKS. If it parses + validates, this is an
    // owner. If it errors (wrong issuer / wrong signing alg / bad signature),
    // fall through to staff HS256 path.
    try {
      const auth = await getJwksValidator().verify(token);
      req.yeboidUserId = auth.userId;

      // Owner → resolve to the Shop they own. One indexed lookup; sub-ms in
      // practice.
      const shop = await prisma.shop.findUnique({
        where: { ownerYeboidSub: auth.userId },
        select: { id: true, ownerPhone: true, ownerEmail: true },
      });

      if (!shop) {
        // Valid YeboID token but no Shop yet. Caller hasn't completed signup.
        ApiResponse.unauthorized(
          res,
          'No shop found for this YeboID account. Complete signup via POST /api/auth/yeboid/exchange.',
        );
        return;
      }

      req.user = {
        id: shop.id,
        shopId: shop.id,
        phone: shop.ownerPhone,
        email: shop.ownerEmail ?? undefined,
        role: 'OWNER' as UserRole,
        type: 'shop',
      };
      next();
      return;
    } catch {
      // Not a valid YeboID token — try staff HS256 below.
    }

    const decoded = JWTUtil.verifyAccessToken(token);
    if (!decoded) {
      ApiResponse.unauthorized(res, 'Invalid or expired token');
      return;
    }
    req.user = decoded;
    next();
  } catch (error) {
    ApiResponse.unauthorized(res, 'Authentication failed');
  }
};

/**
 * Require specific roles. Wraps authMiddleware then role-checks.
 */
export const requireRole = (...roles: UserRole[]) => {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    await authMiddleware(req, res, () => {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Authentication required');
        return;
      }
      if (!roles.includes(req.user.role)) {
        ApiResponse.forbidden(res, `Required role: ${roles.join(' or ')}`);
        return;
      }
      next();
    });
  };
};

export const ownerAuth = requireRole('OWNER');
export const managerAuth = requireRole('OWNER', 'MANAGER');
export const staffAuth = requireRole('OWNER', 'MANAGER', 'CASHIER');

/**
 * Optional auth — populates req.user if a valid token is provided, but
 * doesn't reject if missing. Used by /api/billing/plans-style public-ish
 * endpoints that personalize when authed.
 */
export const optionalAuth = async (req: AuthRequest, _res: Response, next: NextFunction): Promise<void> => {
  try {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      next();
      return;
    }
    try {
      const auth = await getJwksValidator().verify(token);
      const shop = await prisma.shop.findUnique({
        where: { ownerYeboidSub: auth.userId },
        select: { id: true, ownerPhone: true, ownerEmail: true },
      });
      if (shop) {
        req.yeboidUserId = auth.userId;
        req.user = {
          id: shop.id,
          shopId: shop.id,
          phone: shop.ownerPhone,
          email: shop.ownerEmail ?? undefined,
          role: 'OWNER' as UserRole,
          type: 'shop',
        };
      }
    } catch {
      const decoded = JWTUtil.verifyAccessToken(token);
      if (decoded) req.user = decoded;
    }
  } catch {
    // Optional — never throw to next().
  }
  next();
};

/**
 * Admin dashboard authentication — separate from shop auth. Yebomart-signed
 * HS256, admin scope. For internal Omevision staff using the admin dashboard
 * (NOT shop owners or shop staff).
 */
export const authenticateAdmin = (req: AuthRequest, res: Response, next: NextFunction): void => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      ApiResponse.unauthorized(res, 'No token provided');
      return;
    }
    const token = authHeader.substring(7);
    const decoded = JWTUtil.verifyAccessToken(token);
    if (!decoded || decoded.type !== 'admin') {
      ApiResponse.unauthorized(res, 'Admin access required');
      return;
    }
    req.user = decoded;
    next();
  } catch {
    ApiResponse.unauthorized(res, 'Authentication failed');
  }
};

/**
 * Require the authenticated admin to hold one of the given AdminRoles.
 * MUST be chained AFTER `authenticateAdmin` (which sets `req.user.id` from the
 * verified admin token).
 *
 * The role is re-read from the Admin record on every call rather than trusted
 * from the JWT. Admin tokens live 24h (admin.controller.ts), so a token minted
 * before a demotion or deactivation would otherwise keep its stale privileges
 * until expiry. Reading from the DB also enforces `isActive` — a deactivated
 * admin's still-valid token is rejected immediately.
 */
export const requireAdminRole = (...roles: AdminRole[]) => {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const adminId = req.user?.id;
      if (!adminId || req.user?.type !== 'admin') {
        ApiResponse.unauthorized(res, 'Admin access required');
        return;
      }

      const admin = await prisma.admin.findUnique({
        where: { id: adminId },
        select: { role: true, isActive: true },
      });

      if (!admin || !admin.isActive) {
        ApiResponse.unauthorized(res, 'Admin account not found or inactive');
        return;
      }

      if (!roles.includes(admin.role)) {
        ApiResponse.forbidden(res, `Required admin role: ${roles.join(' or ')}`);
        return;
      }

      next();
    } catch (error) {
      console.error('Admin role check error:', error);
      ApiResponse.error(res, 'Authorization check failed');
    }
  };
};

/** Only SUPER_ADMIN — for destructive cross-tenant actions (delete/suspend). */
export const requireSuperAdmin = requireAdminRole('SUPER_ADMIN');

/** ADMIN or SUPER_ADMIN — for non-destructive write actions (SUPPORT excluded). */
export const requireAdminWrite = requireAdminRole('SUPER_ADMIN', 'ADMIN');
