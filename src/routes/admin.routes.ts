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
router.put('/subscriptions/:id', AdminController.updateSubscription);
router.get('/users', AdminController.getUsers);
router.get('/subscriptions', AdminController.getSubscriptions);

export default router;
