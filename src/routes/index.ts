import { Router } from 'express';
import authRoutes from '@routes/auth.routes';
import shopRoutes from '@routes/shop.routes';
import productRoutes from '@routes/product.routes';
import saleRoutes from '@routes/sale.routes';
import stockRoutes from '@routes/stock.routes';
import userRoutes from '@routes/user.routes';
import reportRoutes from '@routes/report.routes';
import aiRoutes from '@routes/ai.routes';
import licenseRoutes from '@routes/license.routes';
import expenseRoutes from '@routes/expense.routes';
import customerRoutes from '@routes/customer.routes';
import auditRoutes from '@routes/audit.routes';
import adminRoutes from '@routes/admin.routes';

const router = Router();

// Auth routes
router.use('/auth', authRoutes);

// Shop management
router.use('/shops', shopRoutes);

// Products
router.use('/products', productRoutes);

// Sales/Transactions
router.use('/sales', saleRoutes);

// Stock management
router.use('/stock', stockRoutes);

// Users/Staff
router.use('/users', userRoutes);

// Reports
router.use('/reports', reportRoutes);

// AI Assistant
router.use('/ai', aiRoutes);

// License/Subscription
router.use('/license', licenseRoutes);

// Expenses
router.use('/expenses', expenseRoutes);

// Customers (credit management)
router.use('/customers', customerRoutes);

// Audit logs
router.use('/audit', auditRoutes);

// Admin dashboard
router.use('/admin', adminRoutes);

export default router;
