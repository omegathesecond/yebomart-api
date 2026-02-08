import { Router } from 'express';
import {
  ShopController,
  updateShopSchema,
} from '@controllers/shop.controller';
import { validateRequest } from '@middleware/validation.middleware';
import { authMiddleware, ownerAuth } from '@middleware/auth.middleware';

const router = Router();

// Public: get business types (for registration)
router.get('/types', ShopController.getBusinessTypes);

// All other routes require authentication
router.use(authMiddleware);

// Get shop config (units, categories based on business type)
router.get('/config', ShopController.getConfig);

router.get('/:id', ShopController.getById);
router.patch('/:id', ownerAuth, validateRequest(updateShopSchema), ShopController.update);
router.get('/:id/stats', ShopController.getStats);

export default router;
