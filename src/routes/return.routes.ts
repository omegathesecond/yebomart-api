import { Router } from 'express';
import {
  ReturnController,
  createReturnSchema,
  listReturnsSchema,
  processReturnSchema,
} from '@controllers/return.controller';
import { validateRequest, validateQuery } from '@middleware/validation.middleware';
import { authMiddleware, managerAuth } from '@middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// List and get
router.get('/', validateQuery(listReturnsSchema), ReturnController.list);
router.get('/:id', ReturnController.getById);

// Create return
router.post('/', validateRequest(createReturnSchema), ReturnController.create);

// Process return (approve/reject/complete) - managers only
router.post('/:id/process', managerAuth, validateRequest(processReturnSchema), ReturnController.process);

export default router;
