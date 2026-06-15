import { Router } from 'express';
import { AdminController, adminLoginSchema } from '@controllers/admin.controller';
import { validateRequest } from '@middleware/validation.middleware';
import { authenticateAdmin } from '@middleware/auth.middleware';

const router = Router();

// Public routes
router.post('/login', validateRequest(adminLoginSchema), AdminController.login);

// Protected routes (require admin auth)
router.use(authenticateAdmin);

router.get('/dashboard', AdminController.getDashboard);
router.get('/shops', AdminController.getShops);
router.get('/shops/:id', AdminController.getShop);
router.patch('/shops/:id/status', AdminController.updateShopStatus);
router.delete('/shops/:id', AdminController.deleteShop);
router.get('/users', AdminController.getUsers);
router.get('/users/:id', AdminController.getUserDetail);
// Backwards-compat alias: this used to return tier breakdown; now returns
// shop-status breakdown. Same shape (groupBy + _count) so dashboards keep
// working.
router.get('/subscriptions', AdminController.getSubscriptions);
// Cross-shop audit log (voids, deletes, status changes across all shops).
router.get('/audit', AdminController.getAuditLogs);

export default router;
