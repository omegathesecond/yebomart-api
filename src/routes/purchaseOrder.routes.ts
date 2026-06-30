import { Router } from 'express';
import {
  PurchaseOrderController,
  createPurchaseOrderSchema,
  listPurchaseOrdersSchema,
  receivePurchaseOrderSchema,
  recordPaymentSchema,
} from '@controllers/purchaseOrder.controller';
import { validateRequest, validateQuery } from '@middleware/validation.middleware';
import { authMiddleware, managerAuth } from '@middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// List and detail
router.get('/', validateQuery(listPurchaseOrdersSchema), PurchaseOrderController.list);
router.get('/:id', PurchaseOrderController.getById);

// Raise a purchase order (managers only)
router.post('/', managerAuth, validateRequest(createPurchaseOrderSchema), PurchaseOrderController.create);

// Receive stock against a PO — full or partial (managers only)
router.post(
  '/:id/receive',
  managerAuth,
  validateRequest(receivePurchaseOrderSchema),
  PurchaseOrderController.receive
);

// Record a payment to the supplier against a PO (managers only). Supports
// partial payments until the PO's balance due is settled.
router.post(
  '/:id/payments',
  managerAuth,
  validateRequest(recordPaymentSchema),
  PurchaseOrderController.recordPayment
);

export default router;
