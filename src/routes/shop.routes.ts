import { Router } from 'express';
import {
  ShopController,
  updateShopSchema,
  updateNotificationSettingsSchema,
  updateTaxSettingsSchema,
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

// Notification prefs for the authed shop. Declared BEFORE the `/:id` routes so
// `notifications` isn't swallowed as a shop id. No id in the path — always
// scoped to req.user.shopId. PATCH is owner-only.
router.get('/notifications', ShopController.getNotificationSettings);
router.patch(
  '/notifications',
  ownerAuth,
  validateRequest(updateNotificationSettingsSchema),
  ShopController.updateNotificationSettings,
);

// Tax / VAT config for the authed shop. Declared BEFORE `/:id` so `tax` isn't
// swallowed as a shop id. Scoped to req.user.shopId; PATCH is owner-only.
router.get('/tax', ShopController.getTaxSettings);
router.patch(
  '/tax',
  ownerAuth,
  validateRequest(updateTaxSettingsSchema),
  ShopController.updateTaxSettings,
);

router.get('/:id', ShopController.getById);
router.patch('/:id', ownerAuth, validateRequest(updateShopSchema), ShopController.update);
router.get('/:id/stats', ShopController.getStats);

export default router;
