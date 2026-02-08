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
  iat: number;
  exp: number;
}

const JWT_SECRET = process.env.JWT_SECRET || 'yebomart-secret-key';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'yebomart-refresh-secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '30d';

export class JWTUtil {
  static generateAccessToken(payload: ITokenPayload): string {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
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
