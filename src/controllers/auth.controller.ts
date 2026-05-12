import { Request, Response } from 'express';
import Joi from 'joi';
import { AuthService } from '@services/auth.service';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';
import { JwksValidator } from '@yebo/mcp-server';

// Shop OWNER sign-in via YeboID. Frontend completes OAuth on YeboID's hosted
// UI, then POSTs the access_token here. We validate the token via JWKS and
// look up (or create) the Shop.
export const yeboidExchangeSchema = Joi.object({
  accessToken: Joi.string().required(),
  shopName: Joi.string().optional(),       // optional override for first signup
  businessType: Joi.string().optional(),
  assistantName: Joi.string().optional(),
});

// Staff PIN login (cashier/manager logging into a shop's device).
export const userLoginSchema = Joi.object({
  phone: Joi.string().required(),
  pin: Joi.string().length(4).pattern(/^\d{4}$/).required(),
});

const YEBOID_JWKS_URI = process.env.YEBOID_JWKS_URI ?? 'https://api.yeboid.com/.well-known/jwks.json';
const YEBOID_ISSUER = process.env.YEBOID_ISSUER ?? 'https://api.yeboid.com';
let cachedValidator: JwksValidator | null = null;
function getValidator(): JwksValidator {
  if (cachedValidator) return cachedValidator;
  cachedValidator = new JwksValidator({ jwksUri: YEBOID_JWKS_URI, issuer: YEBOID_ISSUER });
  return cachedValidator;
}

export class AuthController {
  /**
   * POST /api/auth/yeboid/exchange — shop owner sign-in / sign-up.
   *
   * Body: { accessToken, shopName?, businessType?, assistantName? }
   * Returns: { shop, isNewShop }
   *
   * No yebomart token is issued — future requests use the same YeboID
   * access_token directly (yebomart validates each request via JWKS).
   */
  static async yeboidExchange(req: Request, res: Response): Promise<void> {
    try {
      const { accessToken, shopName, businessType, assistantName } = req.body;

      let yeboidUserId: string;
      try {
        const auth = await getValidator().verify(accessToken);
        yeboidUserId = auth.userId;
      } catch {
        ApiResponse.unauthorized(res, 'Invalid or expired YeboID access token');
        return;
      }

      const result = await AuthService.signInWithYeboID(yeboidUserId, accessToken, {
        shopName,
        businessType,
        assistantName,
      });

      ApiResponse.success(
        res,
        result,
        result.isNewShop ? 'Shop created' : 'Signed in',
      );
    } catch (error: any) {
      console.error('[AuthController] yeboid/exchange error:', error?.message ?? error);
      ApiResponse.serverError(res, error?.message ?? 'Sign-in failed');
    }
  }

  /** POST /api/auth/login/user — staff PIN login (yebomart-internal). */
  static async userLogin(req: Request, res: Response): Promise<void> {
    try {
      const { phone, pin } = req.body;
      const result = await AuthService.loginUser(phone, pin);
      ApiResponse.success(res, result, 'Staff login successful');
    } catch (error: any) {
      if (error.message?.includes('Invalid')) {
        ApiResponse.unauthorized(res, error.message);
      } else {
        ApiResponse.serverError(res, error.message);
      }
    }
  }

  /** GET /api/auth/me — works for both YeboID-authed owners and PIN-authed staff. */
  static async getMe(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Not authenticated');
        return;
      }
      if (req.yeboidUserId) {
        const result = await AuthService.getMeByYeboID(req.yeboidUserId);
        ApiResponse.success(res, result);
        return;
      }
      const result = await AuthService.getMeByStaffToken(req.user.id);
      ApiResponse.success(res, result);
    } catch (error: any) {
      ApiResponse.notFound(res, error?.message ?? 'Profile not found');
    }
  }
}
