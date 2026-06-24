import { Router } from 'express';
import {
  CustomerController,
  createCustomerSchema,
  addCreditSchema,
  sendStatementSchema,
} from '@controllers/customer.controller';
import { validateRequest } from '@middleware/validation.middleware';
import { authMiddleware, managerAuth } from '@middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

// List and get
router.get('/', CustomerController.list);
router.get('/:id', CustomerController.getById);

// CRUD
router.post('/', validateRequest(createCustomerSchema), CustomerController.create);
router.patch('/:id', managerAuth, CustomerController.update);

// Credit management (manager-gated — credit-ledger writes can wipe out customer debt)
router.post('/:id/credit', managerAuth, validateRequest(addCreditSchema), CustomerController.addCredit);

// Send the customer their statement / payment reminder via YeboLink (manager-gated)
router.post(
  '/:id/send-statement',
  managerAuth,
  validateRequest(sendStatementSchema),
  CustomerController.sendStatement,
);

export default router;
