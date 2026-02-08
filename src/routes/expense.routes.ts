import { Router } from 'express';
import {
  ExpenseController,
  createExpenseSchema,
  listExpensesSchema,
} from '@controllers/expense.controller';
import { validateRequest, validateQuery } from '@middleware/validation.middleware';
import { authMiddleware, managerAuth } from '@middleware/auth.middleware';

const router = Router();

router.use(authMiddleware);

// List and summary
router.get('/', validateQuery(listExpensesSchema), ExpenseController.list);
router.get('/summary', ExpenseController.getSummary);

// CRUD
router.post('/', managerAuth, validateRequest(createExpenseSchema), ExpenseController.create);
router.delete('/:id', managerAuth, ExpenseController.delete);

export default router;
