import jwt from 'jsonwebtoken';
import { UserRole } from '@prisma/client';

export interface ITokenPayload {
  id: string;
  shopId: string;
  phone?: string;
  email?: string;
  role: UserRole;
  type: 'shop' | 'user' | 'admin';
}

export interface IDecodedToken extends ITokenPayload {
  // Optional — YeboID-authed requests synthesize the decoded shape in
  // middleware after JWKS validation; no iat/exp because the source token
  // is RS256 from YeboID and yebomart doesn't decode the timestamps itself.
  iat?: number;
  exp?: number;
}

/** Shortest secret we accept. 32 chars ≈ the 64-hex-char secrets we issue. */
const MIN_SECRET_LENGTH = 32;

/**
 * Read a required signing secret at module load. There is deliberately NO
 * default value.
 *
 * A fallback secret is not a convenience here, it is a forge-token hole: these
 * HS256 tokens are accepted by `authMiddleware` alongside YeboID's RS256 ones,
 * so anyone who can guess the secret can mint a staff token for any shop and
 * walk straight past auth. A literal committed to the repo is, by definition,
 * guessed. Throwing kills the container at boot — loud and immediate — instead
 * of silently signing with a public string.
 *
 * The length floor exists because a short secret is brute-forceable offline
 * from a single captured token, which puts it in the same class as a default.
 */
function requireSecret(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Refusing to start: a JWT signing secret must never ` +
        'fall back to a default, because a known secret forges any staff session.',
    );
  }
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${name} is only ${value.length} chars; minimum is ${MIN_SECRET_LENGTH}. ` +
        'Generate one with: openssl rand -hex 32 | tr -d "\\n"',
    );
  }
  return value;
}

const JWT_SECRET = requireSecret('JWT_SECRET');
const JWT_REFRESH_SECRET = requireSecret('JWT_REFRESH_SECRET');
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';  // Extended for POS use
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '90d';

/** Admin dashboard tokens are short-lived — internal staff, not POS devices. */
const ADMIN_EXPIRES_IN = process.env.ADMIN_JWT_EXPIRES_IN || '24h';

/** Payload for an admin-dashboard token. No shopId — admins are cross-tenant. */
export interface IAdminTokenPayload {
  id: string;
  email: string;
  role: string;
  type: 'admin';
}

export class JWTUtil {
  static generateAccessToken(payload: ITokenPayload): string {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  }

  /**
   * Sign an admin-dashboard token. Lives here rather than in admin.controller
   * so there is exactly ONE module that knows the signing secret. When the
   * controller read `process.env.JWT_SECRET` itself it carried a *different*
   * fallback than this file, so a missing env var would have had admin login
   * sign with one secret and `authenticateAdmin` verify with another — every
   * admin locked out, with nothing in the logs to say why.
   */
  static generateAdminToken(payload: IAdminTokenPayload): string {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: ADMIN_EXPIRES_IN });
  }

  static generateRefreshToken(payload: ITokenPayload): string {
    return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: JWT_REFRESH_EXPIRES_IN });
  }

  static verifyAccessToken(token: string): IDecodedToken | null {
    try {
      return jwt.verify(token, JWT_SECRET) as IDecodedToken;
    } catch (error) {
      return null;
    }
  }

  static verifyRefreshToken(token: string): IDecodedToken | null {
    try {
      return jwt.verify(token, JWT_REFRESH_SECRET) as IDecodedToken;
    } catch (error) {
      return null;
    }
  }

  static decode(token: string): IDecodedToken | null {
    try {
      return jwt.decode(token) as IDecodedToken;
    } catch (error) {
      return null;
    }
  }
}
