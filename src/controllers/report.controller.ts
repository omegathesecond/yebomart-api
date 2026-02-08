import { Response } from 'express';
import Joi from 'joi';
import { ReportService } from '@services/report.service';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';

export const dateQuerySchema = Joi.object({
  date: Joi.date().optional(),
});

export const dateRangeSchema = Joi.object({
  startDate: Joi.date().required(),
  endDate: Joi.date().required(),
});

export class ReportController {
  /**
   * Get daily report
   */
  static async getDailyReport(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const date = req.query.date ? new Date(req.query.date as string) : undefined;
      const report = await ReportService.getDailyReport(req.user.shopId, date);
      ApiResponse.success(res, report);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Get weekly report
   */
  static async getWeeklyReport(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const weekStart = req.query.weekStart ? new Date(req.query.weekStart as string) : undefined;
      const report = await ReportService.getWeeklyReport(req.user.shopId, weekStart);
      ApiResponse.success(res, report);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Get product performance report
   */
  static async getProductReport(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const startDate = req.query.startDate ? new Date(req.query.startDate as string) : new Date();
      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : new Date();

      // Default to last 30 days if no dates provided
      if (!req.query.startDate) {
        startDate.setDate(startDate.getDate() - 30);
      }

      const report = await ReportService.getProductReport(req.user.shopId, { startDate, endDate });
      ApiResponse.success(res, report);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Get staff performance report
   */
  static async getStaffReport(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const startDate = req.query.startDate ? new Date(req.query.startDate as string) : new Date();
      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : new Date();

      // Default to current month if no dates provided
      if (!req.query.startDate) {
        startDate.setDate(1);
        startDate.setHours(0, 0, 0, 0);
      }

      const report = await ReportService.getStaffReport(req.user.shopId, { startDate, endDate });
      ApiResponse.success(res, report);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Get summary report (today + week + month)
   */
  static async getSummary(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const today = await ReportService.getDailyReport(req.user.shopId);
      const thisWeek = await ReportService.getWeeklyReport(req.user.shopId);
      
      // Get this month
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const monthEnd = new Date();
      
      const thisMonth = await ReportService.getProductReport(req.user.shopId, {
        startDate: monthStart,
        endDate: monthEnd,
      });

      ApiResponse.success(res, {
        today: {
          date: new Date().toISOString().split('T')[0],
          totalSales: today.summary?.totalSales || 0,
          totalTransactions: today.summary?.totalTransactions || 0,
          averageTransaction: today.summary?.averageBasket || 0,
          topProducts: today.topProducts || [],
        },
        thisWeek: {
          sales: thisWeek.summary?.totalSales || 0,
          transactions: thisWeek.summary?.totalTransactions || 0,
          growth: 0,
        },
        thisMonth: {
          sales: thisMonth.products?.reduce((sum: number, p: any) => sum + p.revenue, 0) || 0,
          transactions: thisMonth.products?.reduce((sum: number, p: any) => sum + p.quantitySold, 0) || 0,
          growth: 0,
        },
      });
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }
}
