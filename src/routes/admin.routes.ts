import { Router } from 'express';
import {
  AdminController,
  adminLoginSchema,
  adminUpdateProfileSchema,
  adminChangePasswordSchema,
} from '@controllers/admin.controller';
import { validateRequest } from '@middleware/validation.middleware';
import { authenticateAdmin, requireSuperAdmin } from '@middleware/auth.middleware';

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
router.get('/users', AdminController.getUsers);
router.get('/users/:id', AdminController.getUserDetail);
// Backwards-compat alias: this used to return tier breakdown; now returns
// shop-status breakdown. Same shape (groupBy + _count) so dashboards keep
// working.
router.get('/subscriptions', AdminController.getSubscriptions);

export default router;
