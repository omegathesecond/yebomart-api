import { Router } from 'express';
import {
  SaleController,
  createSaleSchema,
  listSalesSchema,
  voidSaleSchema,
  smsReceiptSchema,
} from '@controllers/sale.controller';
import { validateRequest, validateQuery } from '@middleware/validation.middleware';
import { authMiddleware, managerAuth } from '@middleware/auth.middleware';
import { posLimiter } from '@middleware/rateLimit.middleware';
import { trackUsage, requireCreditBalance } from '@middleware/billing.middleware';
import { CREDIT_COSTS } from '@config/creditPacks';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// List and get
router.get('/', validateQuery(listSalesSchema), SaleController.list);
router.get('/daily-summary', SaleController.getDailySummary);
router.get('/search/receipt', SaleController.searchByReceipt);
router.post('/email-receipt', SaleController.emailReceipt);
// An SMS costs us ~E10/segment to the home market, so it must be charged.
router.post(
  '/sms-receipt',
  requireCreditBalance(CREDIT_COSTS.SMS, 'SMS receipt'),
  validateRequest(smsReceiptSchema),
  SaleController.smsReceipt,
);
router.get('/:id', SaleController.getById);

// Create sale (with POS rate limiting and usage tracking)
router.post('/', posLimiter, trackUsage('transaction'), validateRequest(createSaleSchema), SaleController.create);

// Void sale (managers only)
router.post('/:id/void', managerAuth, validateRequest(voidSaleSchema), SaleController.voidSale);

export default router;
