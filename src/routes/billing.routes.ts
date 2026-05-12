import { Router, Response } from 'express';
import { BillingService } from '@services/billing.service';
import { authMiddleware, AuthRequest } from '@middleware/auth.middleware';
import { ApiResponse } from '@utils/ApiResponse';
import { prisma } from '@config/prisma';

const router = Router();

// GET /api/billing/credit-packs — public. Returns available credit packs for
// the top-up UI. No subscription tiers anymore.
router.get('/credit-packs', async (_req, res: Response) => {
  return ApiResponse.success(res, { packs: BillingService.getCreditPacks() });
});

// GET /api/billing/balance — authenticated. Returns the shop's current
// credit balance from yebopay.
router.get('/balance', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const shopId = req.user!.shopId;
    const balance = await BillingService.getShopBalance(shopId);
    return ApiResponse.success(res, balance);
  } catch (error: any) {
    console.error('[Billing] Balance lookup failed:', error?.message || error);
    return ApiResponse.serverError(res, 'Failed to fetch balance');
  }
});

// POST /api/billing/checkout — authenticated. Initiates a credit-pack top-up.
// Body: { packId?: 'STARTER'|'STANDARD'|'BULK', amount?: number, successUrl?, cancelUrl? }
// Either packId or amount (custom SZL, >=10) is required.
// Returns the hosted Stripe Checkout URL.
router.post('/checkout', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { packId, amount, successUrl, cancelUrl } = req.body ?? {};
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    if (!packId && (typeof amount !== 'number' || amount < 10)) {
      return ApiResponse.badRequest(res, 'Either packId or amount (>=10 SZL) is required');
    }

    const shop = await prisma.shop.findUnique({
      where: { id: req.user!.shopId },
      select: { ownerEmail: true },
    });

    const result = await BillingService.createTopUpCheckout({
      shopId: req.user!.shopId,
      shopEmail: shop?.ownerEmail || undefined,
      packId,
      customAmountSzl: typeof amount === 'number' ? amount : undefined,
      successUrl: successUrl || `https://app.yebomart.com/billing/success`,
      cancelUrl: cancelUrl || `https://app.yebomart.com/billing/cancel`,
      idempotencyKey,
    });

    return ApiResponse.success(res, result);
  } catch (error: any) {
    console.error('[Billing] Top-up checkout failed:', error?.message || error);
    return ApiResponse.serverError(res, error?.message || 'Failed to create top-up checkout');
  }
});

// POST /api/billing/checkout/confirm — authenticated. Frontend posts the
// checkoutId from the success page; returns the latest balance so the UI
// can render "+N credits, new balance X".
router.post('/checkout/confirm', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { checkoutId } = req.body ?? {};
    if (typeof checkoutId !== 'string' || !checkoutId.trim()) {
      return ApiResponse.badRequest(res, 'Missing checkoutId');
    }
    const result = await BillingService.confirmTopUp({
      shopId: req.user!.shopId,
      checkoutId,
    });
    return ApiResponse.success(res, result);
  } catch (error: any) {
    console.error('[Billing] Top-up confirm failed:', error?.message || error);
    return ApiResponse.serverError(res, 'Failed to confirm top-up');
  }
});

// Legacy /plans endpoint kept for backwards-compatibility — surface a "moved"
// pointer so any cached frontend doesn't 404. New callers should hit
// /credit-packs.
router.get('/plans', async (_req, res: Response) => {
  return ApiResponse.success(res, {
    deprecated: true,
    message: 'Subscription tiers are deprecated. YeboMart is now pay-as-you-go credits. See GET /api/billing/credit-packs.',
    packs: BillingService.getCreditPacks(),
  });
});

export default router;
