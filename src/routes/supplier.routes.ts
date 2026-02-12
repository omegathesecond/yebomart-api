import { Router } from 'express';
import {
  SupplierController,
  createSupplierSchema,
  updateSupplierSchema,
  listSuppliersSchema,
  supplierProductSchema,
} from '@controllers/supplier.controller';
import { validateRequest, validateQuery } from '@middleware/validation.middleware';
import { authMiddleware, managerAuth } from '@middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// List and get
router.get('/', validateQuery(listSuppliersSchema), SupplierController.list);
router.get('/:id', SupplierController.getById);

// Create supplier (managers only)
router.post('/', managerAuth, validateRequest(createSupplierSchema), SupplierController.create);

// Update supplier (managers only)
router.put('/:id', managerAuth, validateRequest(updateSupplierSchema), SupplierController.update);
router.patch('/:id', managerAuth, validateRequest(updateSupplierSchema), SupplierController.update);

// Delete supplier (managers only)
router.delete('/:id', managerAuth, SupplierController.delete);

// Supplier products
router.post('/:id/products', managerAuth, validateRequest(supplierProductSchema), SupplierController.addProduct);
router.delete('/:id/products/:productId', managerAuth, SupplierController.removeProduct);

export default router;
