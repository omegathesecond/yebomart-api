import { Router, Request, Response } from 'express';
import express from 'express';
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

// POST /checkout — authenticated
router.post('/checkout', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { tier, successUrl, cancelUrl } = req.body;

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
      successUrl: successUrl || `https://app.yebomart.com/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: cancelUrl || `https://app.yebomart.com/billing`,
    });

    return ApiResponse.success(res, result);
  } catch (error) {
    console.error('[Billing] Checkout error:', error);
    return ApiResponse.serverError(res, 'Failed to create checkout session');
  }
});

// POST /webhook — Stripe webhook (raw body)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  try {
    const signature = req.headers['stripe-signature'] as string;
    if (!signature) {
      return res.status(400).json({ error: 'Missing stripe-signature header' });
    }

    const result = await BillingService.handleWebhookEvent(req.body, signature);
    return res.json(result);
  } catch (error: any) {
    console.error('[Billing] Webhook error:', error.message);
    return res.status(400).json({ error: 'Webhook verification failed' });
  }
});

export default router;
