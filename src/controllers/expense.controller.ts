import { Response } from 'express';
import Joi from 'joi';
import { prisma } from '@config/prisma';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';
import { AuditService, auditContext } from '@services/audit.service';

export const createExpenseSchema = Joi.object({
  category: Joi.string().required().valid('RENT', 'UTILITIES', 'SUPPLIES', 'WAGES', 'TRANSPORT', 'MARKETING', 'REPAIRS', 'OTHER'),
  amount: Joi.number().required().min(0),
  description: Joi.string().optional().max(500),
  date: Joi.date().optional().default(() => new Date()),
  receiptUrl: Joi.string().optional().uri(),
});

export const listExpensesSchema = Joi.object({
  page: Joi.number().optional().integer().min(1).default(1),
  limit: Joi.number().optional().integer().min(1).max(100).default(20),
  category: Joi.string().optional(),
  startDate: Joi.date().optional(),
  endDate: Joi.date().optional(),
});

export class ExpenseController {
  /**
   * Create expense
   */
  static async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const expense = await prisma.expense.create({
        data: {
          shopId: req.user.shopId,
          ...req.body,
        },
      });

      const actor = auditContext(req);
      if (actor) {
        await AuditService.log({
          ...actor,
          action: 'EXPENSE_CREATE',
          entityType: 'expense',
          entityId: expense.id,
          details: { category: expense.category, amount: expense.amount, description: expense.description },
        });
      }

      ApiResponse.created(res, expense, 'Expense recorded');
    } catch (error: any) {
      ApiResponse.badRequest(res, error.message);
    }
  }

  /**
   * List expenses
   */
  static async list(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { page = 1, limit = 20, category, startDate, endDate } = req.query as any;
      const skip = (page - 1) * limit;

      const where: any = { shopId: req.user.shopId };
      if (category) where.category = category;
      if (startDate || endDate) {
        where.date = {};
        if (startDate) where.date.gte = new Date(startDate);
        if (endDate) where.date.lte = new Date(endDate);
      }

      const [expenses, total] = await Promise.all([
        prisma.expense.findMany({
          where,
          skip,
          take: limit,
          orderBy: { date: 'desc' },
        }),
        prisma.expense.count({ where }),
      ]);

      // Calculate totals by category
      const totals = await prisma.expense.groupBy({
        by: ['category'],
        where: { shopId: req.user.shopId },
        _sum: { amount: true },
      });

      ApiResponse.success(res, {
        expenses,
        totals: totals.reduce((acc, t) => ({ ...acc, [t.category]: t._sum.amount }), {}),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    } catch (error: any) {
      ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Get expense summary
   */
  static async getSummary(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

      const [thisMonth, lastMonth, byCategory] = await Promise.all([
        prisma.expense.aggregate({
          where: {
            shopId: req.user.shopId,
            date: { gte: startOfMonth },
          },
          _sum: { amount: true },
          _count: true,
        }),
        prisma.expense.aggregate({
          where: {
            shopId: req.user.shopId,
            date: { gte: startOfLastMonth, lte: endOfLastMonth },
          },
          _sum: { amount: true },
        }),
        prisma.expense.groupBy({
          by: ['category'],
          where: {
            shopId: req.user.shopId,
            date: { gte: startOfMonth },
          },
          _sum: { amount: true },
        }),
      ]);

      ApiResponse.success(res, {
        thisMonth: thisMonth._sum.amount || 0,
        lastMonth: lastMonth._sum.amount || 0,
        count: thisMonth._count,
        byCategory: byCategory.reduce((acc, c) => ({ ...acc, [c.category]: c._sum.amount }), {}),
      });
    } catch (error: any) {
      ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Delete expense
   */
  static async delete(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { id } = req.params;
      const before = await prisma.expense.findFirst({ where: { id, shopId: req.user.shopId } });
      const deleted = await prisma.expense.deleteMany({
        where: { id, shopId: req.user.shopId },
      });

      const actor = auditContext(req);
      if (actor && deleted.count > 0) {
        await AuditService.log({
          ...actor,
          action: 'EXPENSE_DELETE',
          entityType: 'expense',
          entityId: id,
          details: before
            ? { category: before.category, amount: before.amount, description: before.description }
            : undefined,
        });
      }

      ApiResponse.success(res, null, 'Expense deleted');
    } catch (error: any) {
      ApiResponse.serverError(res, error.message);
    }
  }
}
