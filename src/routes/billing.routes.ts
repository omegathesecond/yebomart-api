import { Router, Response } from 'express';
import { BillingService } from '@services/billing.service';
import { authMiddleware, managerAuth, AuthRequest } from '@middleware/auth.middleware';
import { ApiResponse } from '@utils/ApiResponse';
import { prisma } from '@config/prisma';
import { PLANS, PAID_PLAN_CODES, planToDto, type PlanCode } from '@config/plans';
import { usageSummary } from '@services/entitlement.service';
import { subscribe, cancel, SubscriptionError } from '@services/subscription.service';

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
// Returns the yebopay-hosted checkout URL.
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

// GET /api/billing/plans — public. The three plans and what each includes.
// Credits still exist for overage; the plan covers what it covers first.
router.get('/plans', async (_req, res: Response) => {
  return ApiResponse.success(res, {
    plans: (Object.keys(PLANS) as PlanCode[]).map((c) => planToDto(PLANS[c])),
  });
});

// GET /api/billing/subscription — authenticated. The shop's plan, the current
// period, and how much of each allowance it has used.
router.get('/subscription', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const shopId = req.user!.shopId;
    const [sub, usage] = await Promise.all([
      prisma.shopSubscription.findUnique({ where: { shopId } }),
      usageSummary(shopId),
    ]);

    return ApiResponse.success(res, {
      subscription: sub
        ? {
            plan_code: sub.planCode,
            status: sub.status,
            current_period_start: sub.currentPeriodStart.toISOString(),
            current_period_end: sub.currentPeriodEnd.toISOString(),
            cancel_at_period_end: sub.cancelAtPeriodEnd,
            // Present while a cycle is unpaid so the UI can show "Pay now".
            invoice_number: sub.status === 'ACTIVE' ? null : sub.invoiceNumber,
            pay_url: sub.status === 'ACTIVE' ? null : sub.invoicePayUrl,
          }
        : null,
      // What the shop is ENTITLED to right now, which is Till unless a cycle
      // has actually been paid for.
      usage,
    });
  } catch (error: any) {
    console.error('[Billing] subscription lookup failed:', error?.message || error);
    return ApiResponse.serverError(res, 'Failed to fetch subscription');
  }
});

// POST /api/billing/subscribe — owner-only. Raises the first cycle's invoice
// and returns its pay link. The plan does NOT take effect until it is paid.
router.post('/subscribe', authMiddleware, managerAuth, async (req: AuthRequest, res: Response) => {
  try {
    const planCode = String(req.body?.plan_code ?? '').toUpperCase();
    if (!PAID_PLAN_CODES.includes(planCode as (typeof PAID_PLAN_CODES)[number])) {
      return ApiResponse.badRequest(res, `plan_code must be one of ${PAID_PLAN_CODES.join(', ')}`);
    }

    const { payUrl, subscription } = await subscribe(req.user!.shopId, planCode as PlanCode);
    return ApiResponse.success(
      res,
      {
        pay_url: payUrl,
        plan_code: planCode,
        status: subscription?.status,
        invoice_number: subscription?.invoiceNumber,
      },
      'Invoice sent. The plan starts once it is paid.',
    );
  } catch (error: any) {
    if (error instanceof SubscriptionError) {
      return ApiResponse.badRequest(res, error.message);
    }
    console.error('[Billing] subscribe failed:', error?.message || error);
    return ApiResponse.serverError(res, error?.message || 'Failed to start the plan');
  }
});

// POST /api/billing/subscription/cancel — owner-only. Runs to the end of the
// paid period, then stops. No mid-cycle downgrade, no refund maths.
router.post('/subscription/cancel', authMiddleware, managerAuth, async (req: AuthRequest, res: Response) => {
  try {
    const sub = await cancel(req.user!.shopId);
    return ApiResponse.success(
      res,
      { plan_code: sub.planCode, ends_at: sub.currentPeriodEnd.toISOString() },
      'Your plan will run until the end of the period you have paid for.',
    );
  } catch (error: any) {
    if (error instanceof SubscriptionError) {
      return ApiResponse.badRequest(res, error.message);
    }
    console.error('[Billing] cancel failed:', error?.message || error);
    return ApiResponse.serverError(res, 'Failed to cancel the plan');
  }
});

export default router;
