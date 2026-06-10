import { Router } from 'express';
import {
  CashSessionController,
  openCashSessionSchema,
  closeCashSessionSchema,
} from '@controllers/cashSession.controller';
import { validateRequest } from '@middleware/validation.middleware';
import { authMiddleware } from '@middleware/auth.middleware';

const router = Router();

// All routes require authentication (shop owner or staff).
router.use(authMiddleware);

// Open a till with a starting float (409 if one is already open).
router.post('/open', validateRequest(openCashSessionSchema), CashSessionController.open);

// The currently open session + live cash tally (or null).
router.get('/current', CashSessionController.current);

// Cash up — close the session and record the variance.
router.post('/:id/close', validateRequest(closeCashSessionSchema), CashSessionController.close);

// Z-report for a session.
router.get('/:id/zreport', CashSessionController.zReport);

export default router;
