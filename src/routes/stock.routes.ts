import { Router } from 'express';
import {
  StockController,
  adjustStockSchema,
  receiveStockSchema,
  listMovementsSchema,
} from '@controllers/stock.controller';
import { validateRequest, validateQuery } from '@middleware/validation.middleware';
import { authMiddleware, managerAuth } from '@middleware/auth.middleware';
import { trackUsage } from '@middleware/license.middleware';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// Get stock levels
router.get('/', StockController.getStock);

// Low stock alerts
router.get('/alerts', StockController.getAlerts);

// Stock movements history
router.get('/movements', validateQuery(listMovementsSchema), StockController.getMovements);

// Stock adjustments (managers only, track usage)
router.post('/adjust', managerAuth, trackUsage('stockMove'), validateRequest(adjustStockSchema), StockController.adjust);
router.post('/receive', managerAuth, trackUsage('stockMove'), validateRequest(receiveStockSchema), StockController.receive);

export default router;
