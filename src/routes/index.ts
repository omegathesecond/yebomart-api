import { Router } from 'express';
import authRoutes from '@routes/auth.routes';
import shopRoutes from '@routes/shop.routes';
import productRoutes from '@routes/product.routes';
import saleRoutes from '@routes/sale.routes';
import stockRoutes from '@routes/stock.routes';
import userRoutes from '@routes/user.routes';
import reportRoutes from '@routes/report.routes';
import aiRoutes from '@routes/ai.routes';
import expenseRoutes from '@routes/expense.routes';
import customerRoutes from '@routes/customer.routes';
import auditRoutes from '@routes/audit.routes';
import adminRoutes from '@routes/admin.routes';
import uploadRoutes from '@routes/upload.routes';
import returnRoutes from '@routes/return.routes';
import supplierRoutes from '@routes/supplier.routes';
import purchaseOrderRoutes from '@routes/purchaseOrder.routes';
import billingRoutes from '@routes/billing.routes';
import internalRoutes from '@routes/internal.routes';

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
router.use('/staff', userRoutes); // Alias for frontend

// Reports
router.use('/reports', reportRoutes);

// AI Assistant
router.use('/ai', aiRoutes);

// Expenses
router.use('/expenses', expenseRoutes);

// Customers (credit management)
router.use('/customers', customerRoutes);

// Audit logs
router.use('/audit', auditRoutes);

// Admin dashboard
router.use('/admin', adminRoutes);

// File upload (R2)
router.use('/upload', uploadRoutes);

// Returns (refunds & exchanges)
router.use('/returns', returnRoutes);

// Suppliers
router.use('/suppliers', supplierRoutes);

// Purchase orders (raise PO + receive stock)
router.use('/purchase-orders', purchaseOrderRoutes);

// Billing (pay-as-you-go credits via YeboPay; replaces legacy /pricing + /license surfaces)
router.use('/billing', billingRoutes);

// Internal machine-only routes (Cloud Scheduler → daily notification run).
// Shared-secret gated, not user-auth.
router.use('/internal', internalRoutes);

export default router;
