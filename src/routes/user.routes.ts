import { Router } from 'express';
import {
  UserController,
  createUserSchema,
  updateUserSchema,
} from '@controllers/user.controller';
import { validateRequest } from '@middleware/validation.middleware';
import { authMiddleware, ownerAuth } from '@middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// List users
router.get('/', UserController.list);

// Create user (owner only) — no tier-based user-count cap; pay-as-you-go.
router.post('/', ownerAuth, validateRequest(createUserSchema), UserController.create);

// Get, update, delete specific user
router.get('/:id', UserController.getById);
router.get('/:id/stats', UserController.getStats);
router.get('/:id/detail', UserController.getDetail);
router.patch('/:id', validateRequest(updateUserSchema), UserController.update);
router.delete('/:id', ownerAuth, UserController.delete);

export default router;
