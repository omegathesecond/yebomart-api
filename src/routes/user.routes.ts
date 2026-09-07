import { Router, Response, NextFunction } from 'express';
import {
  UserController,
  createUserSchema,
  updateUserSchema,
  hasPrivilegedFields,
} from '@controllers/user.controller';
import { validateRequest } from '@middleware/validation.middleware';
import { authMiddleware, ownerAuth, AuthRequest } from '@middleware/auth.middleware';
import { ApiResponse } from '@utils/ApiResponse';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

/**
 * Route-level guard for PATCH /:id. Only an OWNER may change authority-granting
 * fields (role / isActive / permission flags). Defense in depth — the
 * controller enforces the same rule, but gating at the route stops a privileged
 * payload before it reaches any handler. Non-owners keep a narrow self-edit of
 * profile fields only (name/phone/email/PIN/password).
 */
const blockPrivilegeEscalation = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (req.user?.role !== 'OWNER' && hasPrivilegedFields(req.body)) {
    ApiResponse.forbidden(res, 'Only owners can change role, active status, or permission flags');
    return;
  }
  next();
};

// List users
router.get('/', UserController.list);

// Create user (owner only) — no tier-based user-count cap; pay-as-you-go.
router.post('/', ownerAuth, validateRequest(createUserSchema), UserController.create);

// Get, update, delete specific user
router.get('/:id', UserController.getById);
router.get('/:id/stats', UserController.getStats);
router.get('/:id/detail', UserController.getDetail);
router.patch('/:id', validateRequest(updateUserSchema), blockPrivilegeEscalation, UserController.update);
router.delete('/:id', ownerAuth, UserController.delete);

export default router;
