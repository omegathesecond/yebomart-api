import { Router } from 'express';
import {
  CustomerController,
  createCustomerSchema,
  addCreditSchema,
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

// Credit management
router.post('/:id/credit', validateRequest(addCreditSchema), CustomerController.addCredit);

export default router;
