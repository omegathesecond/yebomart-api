import { Router } from 'express';
import {
  AdminController,
  adminLoginSchema,
  adminUpdateProfileSchema,
  adminChangePasswordSchema,
} from '@controllers/admin.controller';
import {
  AdminBillingController,
  adjustCreditsSchema,
  billingQuerySchema,
} from '@controllers/adminBilling.controller';
import { validateRequest, validateQuery } from '@middleware/validation.middleware';
import { authenticateAdmin, requireSuperAdmin, requireAdminWrite } from '@middleware/auth.middleware';

const router = Router();

// Public routes
router.post('/login', validateRequest(adminLoginSchema), AdminController.login);

// Protected routes (require admin auth)
router.use(authenticateAdmin);

// Authenticated admin's own account (Settings page)
router.get('/profile', AdminController.getProfile);
router.patch('/profile', validateRequest(adminUpdateProfileSchema), AdminController.updateProfile);
router.post('/change-password', validateRequest(adminChangePasswordSchema), AdminController.changePassword);

router.get('/dashboard', AdminController.getDashboard);
router.get('/shops', AdminController.getShops);
router.get('/shops/:id', AdminController.getShop);
// Destructive cross-tenant actions — SUPER_ADMIN only. Suspending or deleting a
// shop cascades into all of that tenant's sales/products/users/customers, so a
// SUPPORT/ADMIN token must not be able to trigger it.
router.patch('/shops/:id/status', requireSuperAdmin, AdminController.updateShopStatus);
router.delete('/shops/:id', requireSuperAdmin, AdminController.deleteShop);

// Billing — a shop's credit wallet (balance + yebopay ledger + local audit).
// READ is open to every admin role, SUPPORT included: making billing tickets
// actionable is the entire point, and support staff are the ones fielding them.
router.get('/shops/:id/billing', validateQuery(billingQuerySchema), AdminBillingController.getShopBilling);
// WRITE moves real money, so SUPPORT is excluded (requireAdminWrite =
// SUPER_ADMIN or ADMIN). Not requireSuperAdmin: a goodwill credit is routine
// operational work, not a destructive cross-tenant action like delete/suspend.
router.post(
  '/shops/:id/billing/adjust',
  requireAdminWrite,
  validateRequest(adjustCreditsSchema),
  AdminBillingController.adjustShopCredits
);
router.get('/users', AdminController.getUsers);
router.get('/users/:id', AdminController.getUserDetail);
// Backwards-compat alias: this used to return tier breakdown; now returns
// shop-status breakdown. Same shape (groupBy + _count) so dashboards keep
// working.
router.get('/subscriptions', AdminController.getSubscriptions);

export default router;
