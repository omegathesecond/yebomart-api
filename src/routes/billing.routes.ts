import { Router, Response } from 'express';
import { BillingService } from '@services/billing.service';
import { authMiddleware, optionalAuth, AuthRequest } from '@middleware/auth.middleware';
import { ApiResponse } from '@utils/ApiResponse';
import { ShopTier } from '@prisma/client';
import { prisma } from '@config/prisma';

const router = Router();

const VALID_TIERS: ShopTier[] = ['LITE', 'STARTER', 'BUSINESS', 'PRO', 'ENTERPRISE'];

// GET /plans — public, returns localised plans
router.get('/plans', optionalAuth, async (req: AuthRequest, res: Response) => {
  try {
    let countryCode = (req.query.country as string)?.toUpperCase();

    if (!countryCode && req.user?.shopId) {
      const shop = await prisma.shop.findUnique({
        where: { id: req.user.shopId },
        select: { countryCode: true },
      });
      countryCode = shop?.countryCode || 'SZ';
    }

    countryCode = countryCode || 'SZ';

    const plans = BillingService.getPlans(countryCode);
    return ApiResponse.success(res, { ...plans, mode: BillingService.getMode() });
  } catch (error) {
    console.error('[Billing] Plans error:', error);
    return ApiResponse.serverError(res, 'Failed to fetch plans');
  }
});

// POST /checkout — authenticated. Returns { checkoutId, url }; frontend stashes
// checkoutId in sessionStorage before redirecting to url, then POSTs
// /checkout/confirm after Stripe's success redirect (which can't carry
// yebopay's id natively).
router.post('/checkout', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { tier, successUrl, cancelUrl } = req.body;
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    if (!tier || !VALID_TIERS.includes(tier)) {
      return ApiResponse.badRequest(res, `Invalid tier. Must be one of: ${VALID_TIERS.join(', ')}`);
    }

    const shop = await prisma.shop.findUnique({
      where: { id: req.user!.shopId },
      select: { countryCode: true, ownerEmail: true },
    });

    if (!shop) {
      return ApiResponse.notFound(res, 'Shop not found');
    }

    const result = await BillingService.createCheckout({
      shopId: req.user!.shopId,
      shopEmail: shop.ownerEmail || undefined,
      countryCode: shop.countryCode,
      tier: tier as ShopTier,
      successUrl: successUrl || `https://app.yebomart.com/billing/success?tier=${tier}`,
      cancelUrl: cancelUrl || `https://app.yebomart.com/billing/cancel`,
      idempotencyKey,
    });

    return ApiResponse.success(res, result);
  } catch (error: any) {
    console.error('[Billing] Checkout error:', error?.message || error);
    return ApiResponse.serverError(res, 'Failed to create checkout session');
  }
});

// POST /checkout/confirm — authenticated. Frontend posts the checkoutId it
// stashed before redirect, after Stripe's success redirect. Returns
// { activated: true, tier, licenseExpiry } if YeboPay reports COMPLETED;
// { activated: false, status } otherwise. Phase 3 yebopay→yebomart webhook
// will replace this polling path with real-time activation.
router.post('/checkout/confirm', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { checkoutId, tier } = req.body;

    if (typeof checkoutId !== 'string' || !checkoutId.trim()) {
      return ApiResponse.badRequest(res, 'Missing checkoutId');
    }
    if (!tier || !VALID_TIERS.includes(tier)) {
      return ApiResponse.badRequest(res, `Invalid tier. Must be one of: ${VALID_TIERS.join(', ')}`);
    }

    const result = await BillingService.confirmCheckout({
      shopId: req.user!.shopId,
      checkoutId,
      tier: tier as ShopTier,
    });

    return ApiResponse.success(res, result);
  } catch (error: any) {
    console.error('[Billing] Confirm error:', error?.message || error);
    return ApiResponse.serverError(res, 'Failed to confirm checkout');
  }
});

export default router;
