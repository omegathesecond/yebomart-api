import { Router } from 'express';
import {
  LicenseController,
  validateLicenseSchema,
} from '@controllers/license.controller';
import { validateRequest } from '@middleware/validation.middleware';
import { authMiddleware, ownerAuth } from '@middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

router.get('/status', LicenseController.getStatus);
router.post('/validate', ownerAuth, validateRequest(validateLicenseSchema), LicenseController.validate);
router.post('/trial', ownerAuth, LicenseController.startTrial);

export default router;
