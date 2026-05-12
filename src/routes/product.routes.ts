import { Router } from 'express';
import {
  ProductController,
  createProductSchema,
  updateProductSchema,
  listProductsSchema,
  bulkImportSchema,
  bulkUpdateSchema,
} from '@controllers/product.controller';
import { validateRequest, validateQuery } from '@middleware/validation.middleware';
import { authMiddleware, managerAuth } from '@middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// List and search
router.get('/', validateQuery(listProductsSchema), ProductController.list);
router.get('/categories', ProductController.getCategories);
router.get('/export', managerAuth, ProductController.exportCSV);

// Bulk operations (owner/manager only)
router.post('/bulk/import', managerAuth, validateRequest(bulkImportSchema), ProductController.bulkImport);
router.post('/bulk/update', managerAuth, validateRequest(bulkUpdateSchema), ProductController.bulkUpdate);

// CRUD operations — no product-count cap (pay-as-you-go; unlimited products).
router.post('/', managerAuth, validateRequest(createProductSchema), ProductController.create);
router.get('/barcode/:barcode', ProductController.getByBarcode);
router.get('/:id', ProductController.getById);
router.patch('/:id', managerAuth, validateRequest(updateProductSchema), ProductController.update);
router.delete('/:id', managerAuth, ProductController.delete);

export default router;
