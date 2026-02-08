import { Request, Response, NextFunction } from 'express';
import { JWTUtil, IDecodedToken } from '@utils/jwt';
import { ApiResponse } from '@utils/ApiResponse';
import { UserRole } from '@prisma/client';

export interface AuthRequest extends Request {
  user?: IDecodedToken;
}

/**
 * Require authentication
 */
export const authMiddleware = (req: AuthRequest, res: Response, next: NextFunction): void => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      ApiResponse.unauthorized(res, 'No token provided');
      return;
    }

    const token = authHeader.substring(7);
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
 * Require specific roles
 */
export const requireRole = (...roles: UserRole[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    authMiddleware(req, res, () => {
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

/**
 * Owner only
 */
export const ownerAuth = requireRole('OWNER');

/**
 * Owner or Manager
 */
export const managerAuth = requireRole('OWNER', 'MANAGER');

/**
 * Any authenticated user
 */
export const staffAuth = requireRole('OWNER', 'MANAGER', 'CASHIER');

/**
 * Optional auth - sets user if token is valid, but doesn't require it
 */
export const optionalAuth = (req: AuthRequest, res: Response, next: NextFunction): void => {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const decoded = JWTUtil.verifyAccessToken(token);
      if (decoded) {
        req.user = decoded;
      }
    }

    next();
  } catch {
    // Token invalid, but that's okay for optional auth
    next();
  }
};
