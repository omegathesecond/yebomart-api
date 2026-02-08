import { Router } from 'express';
import { ReportController } from '@controllers/report.controller';
import { authMiddleware, managerAuth } from '@middleware/auth.middleware';

const router = Router();

// All routes require authentication and manager access
router.use(authMiddleware);
router.use(managerAuth);

router.get('/summary', ReportController.getSummary);
router.get('/daily', ReportController.getDailyReport);
router.get('/weekly', ReportController.getWeeklyReport);
router.get('/products', ReportController.getProductReport);
router.get('/staff', ReportController.getStaffReport);

export default router;
