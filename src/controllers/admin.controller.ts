import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { PrismaClient, Prisma, UserRole, ShopStatus } from '@prisma/client';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';
import Joi from 'joi';

const prisma = new PrismaClient();

const JWT_SECRET = process.env.JWT_SECRET || 'yebomart-jwt-secret';

// bcrypt cost factor — matches the admin seed (prisma/seed.ts) so a rehashed
// password is consistent with seeded ones.
const BCRYPT_ROUNDS = 12;

export const adminLoginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
});

export const adminUpdateProfileSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120),
  email: Joi.string().email(),
}).min(1); // at least one field required

export const adminChangePasswordSchema = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: Joi.string().min(8).max(128).required(),
});

export class AdminController {
  // Admin login
  static async login(req: Request, res: Response): Promise<void> {
    try {
      const { email, password } = req.body;

      const admin = await prisma.admin.findUnique({
        where: { email: email.toLowerCase() },
      });

      if (!admin || !admin.isActive) {
        ApiResponse.unauthorized(res, 'Invalid credentials');
        return;
      }

      const isValidPassword = await bcrypt.compare(password, admin.password);
      if (!isValidPassword) {
        ApiResponse.unauthorized(res, 'Invalid credentials');
        return;
      }

      const token = jwt.sign(
        { id: admin.id, email: admin.email, role: admin.role, type: 'admin' },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      ApiResponse.success(res, {
        admin: {
          id: admin.id,
          email: admin.email,
          name: admin.name,
          role: admin.role,
        },
        accessToken: token,
      });
    } catch (error) {
      console.error('Admin login error:', error);
      ApiResponse.error(res, 'Login failed');
    }
  }

  // Get dashboard stats
  static async getDashboard(req: Request, res: Response): Promise<void> {
    try {
      const [totalShops, activeShops, newShopsToday] = await Promise.all([
        prisma.shop.count(),
        prisma.shop.count({ where: { status: 'ACTIVE' } }),
        prisma.shop.count({
          where: {
            createdAt: {
              gte: new Date(new Date().setHours(0, 0, 0, 0)),
            },
          },
        }),
      ]);

      // Get total revenue (sum of all completed sales)
      const revenueResult = await prisma.sale.aggregate({
        where: { status: 'COMPLETED' },
        _sum: { totalAmount: true },
      });

      // Monthly time-series for the last 6 months (new shops + revenue).
      // Returns one row per month that actually has data; months with no
      // activity are zero-filled below so the chart shows real zeros, not
      // fabricated trend lines.
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
      sixMonthsAgo.setDate(1);
      sixMonthsAgo.setHours(0, 0, 0, 0);

      const [shopsByMonth, revenueByMonth] = await Promise.all([
        prisma.$queryRaw`
          SELECT date_trunc('month', "createdAt") AS month, COUNT(*)::int AS shops
          FROM "Shop"
          WHERE "createdAt" >= ${sixMonthsAgo}
          GROUP BY month
          ORDER BY month ASC
        ` as Promise<Array<{ month: Date; shops: number }>>,
        prisma.$queryRaw`
          SELECT date_trunc('month', "createdAt") AS month, COALESCE(SUM("totalAmount"), 0)::float AS revenue
          FROM "Sale"
          WHERE status = 'COMPLETED' AND "createdAt" >= ${sixMonthsAgo}
          GROUP BY month
          ORDER BY month ASC
        ` as Promise<Array<{ month: Date; revenue: number }>>,
      ]);

      const monthKey = (d: Date) => `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
      const shopsMap = new Map(shopsByMonth.map((r) => [monthKey(new Date(r.month)), r.shops]));
      const revenueMap = new Map(revenueByMonth.map((r) => [monthKey(new Date(r.month)), r.revenue]));
      const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

      const chartData = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date();
        d.setMonth(d.getMonth() - i);
        const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
        chartData.push({
          name: MONTH_NAMES[d.getMonth()],
          shops: shopsMap.get(key) ?? 0,
          revenue: revenueMap.get(key) ?? 0,
        });
      }

      // Recent activity = the latest shop signups (real rows, newest first).
      const recentShops = await prisma.shop.findMany({
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, name: true, createdAt: true },
      });
      const recentActivity = recentShops.map((shop) => ({
        id: shop.id,
        type: 'signup',
        message: 'New shop registered',
        shopName: shop.name,
        timestamp: shop.createdAt,
      }));

      ApiResponse.success(res, {
        totalShops,
        activeShops,
        newShopsToday,
        totalRevenue: revenueResult._sum?.totalAmount || 0,
        chartData,
        recentActivity,
      });
    } catch (error) {
      console.error('Dashboard error:', error);
      ApiResponse.error(res, 'Failed to fetch dashboard data');
    }
  }

  // List all shops
  static async getShops(req: Request, res: Response): Promise<void> {
    try {
      const { page = 1, limit = 20, search, status } = req.query;
      const skip = (Number(page) - 1) * Number(limit);

      // Build the filter once and feed it to BOTH findMany and count so the
      // returned total matches the filtered rows (pagination stays correct).
      const where: Prisma.ShopWhereInput = {};

      if (search) {
        const term = String(search);
        where.OR = [
          { name: { contains: term, mode: 'insensitive' } },
          { ownerName: { contains: term, mode: 'insensitive' } },
          { ownerPhone: { contains: term, mode: 'insensitive' } },
        ];
      }

      // Status filter — only accept real enum values; ignore "all"/garbage.
      if (status && String(status).toLowerCase() !== 'all') {
        const statusUpper = String(status).toUpperCase();
        if ((Object.values(ShopStatus) as string[]).includes(statusUpper)) {
          where.status = statusUpper as ShopStatus;
        } else {
          // A filter the DB can't satisfy must return nothing, not everything.
          ApiResponse.success(res, { shops: [], total: 0, page: Number(page), limit: Number(limit) });
          return;
        }
      }

      const [shops, total] = await Promise.all([
        prisma.shop.findMany({
          where,
          skip,
          take: Number(limit),
          orderBy: { createdAt: 'desc' },
          include: {
            _count: {
              select: { products: true, sales: true, users: true },
            },
          },
        }),
        prisma.shop.count({ where }),
      ]);

      ApiResponse.success(res, { shops, total, page: Number(page), limit: Number(limit) });
    } catch (error) {
      console.error('Get shops error:', error);
      ApiResponse.error(res, 'Failed to fetch shops');
    }
  }

  // Get single shop
  static async getShop(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const shop = await prisma.shop.findUnique({
        where: { id },
        include: {
          users: true,
          _count: {
            select: { products: true, sales: true, users: true },
          },
        },
      });

      if (!shop) {
        ApiResponse.notFound(res, 'Shop not found');
        return;
      }

      ApiResponse.success(res, shop);
    } catch (error) {
      console.error('Get shop error:', error);
      ApiResponse.error(res, 'Failed to fetch shop');
    }
  }

  // Suspend or reactivate shop
  static async updateShopStatus(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { status } = req.body;

      const statusUpper = status?.toUpperCase();
      if (!['ACTIVE', 'SUSPENDED'].includes(statusUpper)) {
        ApiResponse.badRequest(res, 'Invalid status. Must be "active" or "suspended"');
        return;
      }

      const shop = await prisma.shop.update({
        where: { id },
        data: { status: statusUpper },
      });

      ApiResponse.success(res, shop, `Shop ${statusUpper === 'SUSPENDED' ? 'suspended' : 'reactivated'}`);
    } catch (error) {
      console.error('Update shop status error:', error);
      ApiResponse.error(res, 'Failed to update shop status');
    }
  }

  // Delete shop and all related data
  static async deleteShop(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // Delete in order due to foreign key constraints
      await prisma.$transaction(async (tx) => {
        // Delete sale items first
        await tx.saleItem.deleteMany({
          where: { sale: { shopId: id } },
        });
        // Delete sales
        await tx.sale.deleteMany({ where: { shopId: id } });
        // Delete stock logs
        await tx.stockLog.deleteMany({ where: { shopId: id } });
        // Delete products
        await tx.product.deleteMany({ where: { shopId: id } });
        // Delete users
        await tx.user.deleteMany({ where: { shopId: id } });
        // Delete expenses
        await tx.expense.deleteMany({ where: { shopId: id } });
        // Delete customers
        await tx.customer.deleteMany({ where: { shopId: id } });
        // Finally delete the shop
        await tx.shop.delete({ where: { id } });
      });

      ApiResponse.success(res, null, 'Shop deleted successfully');
    } catch (error) {
      console.error('Delete shop error:', error);
      ApiResponse.error(res, 'Failed to delete shop');
    }
  }

  // List all users across shops
  static async getUsers(req: Request, res: Response): Promise<void> {
    try {
      const { page = 1, limit = 20, search, role } = req.query;
      const skip = (Number(page) - 1) * Number(limit);

      // Build the filter once and feed it to BOTH findMany and count so the
      // returned total matches the filtered rows (pagination stays correct).
      const where: Prisma.UserWhereInput = {};

      if (search) {
        const term = String(search);
        where.OR = [
          { name: { contains: term, mode: 'insensitive' } },
          { email: { contains: term, mode: 'insensitive' } },
          { phone: { contains: term, mode: 'insensitive' } },
          { shop: { is: { name: { contains: term, mode: 'insensitive' } } } },
        ];
      }

      // Role filter — only accept real enum values; ignore "all"/garbage.
      if (role && String(role).toLowerCase() !== 'all') {
        const roleUpper = String(role).toUpperCase();
        if ((Object.values(UserRole) as string[]).includes(roleUpper)) {
          where.role = roleUpper as UserRole;
        } else {
          // A filter the DB can't satisfy must return nothing, not everything.
          ApiResponse.success(res, { users: [], total: 0, page: Number(page), limit: Number(limit) });
          return;
        }
      }

      const [users, total] = await Promise.all([
        prisma.user.findMany({
          where,
          skip,
          take: Number(limit),
          orderBy: { createdAt: 'desc' },
          include: { shop: { select: { id: true, name: true } } },
        }),
        prisma.user.count({ where }),
      ]);

      ApiResponse.success(res, { users, total, page: Number(page), limit: Number(limit) });
    } catch (error) {
      console.error('Get users error:', error);
      ApiResponse.error(res, 'Failed to fetch users');
    }
  }

  // Get shop status breakdown (replaces the old "subscriptions overview" — no
  // tiers anymore; pay-as-you-go credits flow through yebopay).
  static async getSubscriptions(req: Request, res: Response): Promise<void> {
    try {
      const breakdown = await prisma.shop.groupBy({
        by: ['status'],
        _count: true,
      });

      ApiResponse.success(res, breakdown);
    } catch (error) {
      console.error('Get shop status breakdown error:', error);
      ApiResponse.error(res, 'Failed to fetch shop status breakdown');
    }
  }

  // Get user detail with stats, sales history, and insights
  static async getUserDetail(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { days = 30 } = req.query;

      const startDate = new Date();
      startDate.setDate(startDate.getDate() - Number(days));

      // Get user with shop info
      const user = await prisma.user.findUnique({
        where: { id },
        include: {
          shop: { select: { id: true, name: true, ownerName: true } }
        },
      });

      if (!user) {
        ApiResponse.notFound(res, 'User not found');
        return;
      }

      // Get aggregated stats
      const [salesStats, voidCount, recentSales, dailySales] = await Promise.all([
        // Overall sales stats
        prisma.sale.aggregate({
          where: {
            userId: id,
            status: 'COMPLETED',
            createdAt: { gte: startDate },
          },
          _sum: { totalAmount: true },
          _count: true,
          _avg: { totalAmount: true },
          _max: { totalAmount: true },
        }),
        // Void count
        prisma.sale.count({
          where: {
            userId: id,
            status: 'VOIDED',
            createdAt: { gte: startDate },
          },
        }),
        // Recent transactions
        prisma.sale.findMany({
          where: { userId: id },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            totalAmount: true,
            status: true,
            paymentMethod: true,
            createdAt: true,
            _count: { select: { items: true } },
          },
        }),
        // Daily sales for chart
        prisma.$queryRaw`
          SELECT 
            DATE("createdAt") as date,
            COUNT(*)::int as transactions,
            COALESCE(SUM("totalAmount"), 0)::float as revenue
          FROM "Sale"
          WHERE "userId" = ${id}
            AND status = 'COMPLETED'
            AND "createdAt" >= ${startDate}
          GROUP BY DATE("createdAt")
          ORDER BY date ASC
        ` as Promise<Array<{ date: Date; transactions: number; revenue: number }>>,
      ]);

      // Generate AI insights
      const insights = [];
      const totalSales = salesStats._sum.totalAmount || 0;
      const avgTransaction = salesStats._avg.totalAmount || 0;
      const transactionCount = salesStats._count || 0;
      const voidRate = transactionCount > 0 ? (voidCount / (transactionCount + voidCount)) * 100 : 0;

      if (transactionCount > 0) {
        if (avgTransaction > 500) {
          insights.push({
            type: 'positive',
            text: `High average transaction value of E${avgTransaction.toFixed(0)} indicates strong upselling skills.`
          });
        }
        if (voidRate > 5) {
          insights.push({
            type: 'warning',
            text: `Void rate of ${voidRate.toFixed(1)}% is above average. Consider additional training.`
          });
        } else if (voidRate < 1) {
          insights.push({
            type: 'positive',
            text: `Excellent accuracy with only ${voidRate.toFixed(1)}% void rate.`
          });
        }
        if (transactionCount > 100) {
          insights.push({
            type: 'positive',
            text: `Processed ${transactionCount} transactions - high activity level.`
          });
        }
      } else {
        insights.push({
          type: 'info',
          text: 'No completed sales in the selected period.'
        });
      }

      ApiResponse.success(res, {
        user: {
          id: user.id,
          name: user.name,
          phone: user.phone,
          email: user.email,
          role: user.role,
          isActive: user.isActive,
          createdAt: user.createdAt,
          lastLoginAt: user.lastLoginAt,
          shop: user.shop,
        },
        stats: {
          period: { start: startDate, end: new Date() },
          totalRevenue: totalSales,
          transactionCount,
          averageTransaction: avgTransaction,
          largestTransaction: salesStats._max.totalAmount || 0,
          voidCount,
          voidRate,
        },
        dailySales,
        recentSales,
        insights,
      });
    } catch (error) {
      console.error('Get user detail error:', error);
      ApiResponse.error(res, 'Failed to fetch user details');
    }
  }

  // Get the currently authenticated admin's own profile.
  static async getProfile(req: AuthRequest, res: Response): Promise<void> {
    try {
      const adminId = req.user?.id;
      if (!adminId) {
        ApiResponse.unauthorized(res, 'Admin access required');
        return;
      }

      const admin = await prisma.admin.findUnique({
        where: { id: adminId },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      if (!admin) {
        ApiResponse.notFound(res, 'Admin not found');
        return;
      }

      ApiResponse.success(res, admin);
    } catch (error) {
      console.error('Get admin profile error:', error);
      ApiResponse.error(res, 'Failed to fetch profile');
    }
  }

  // Update the authenticated admin's own name and/or email.
  static async updateProfile(req: AuthRequest, res: Response): Promise<void> {
    try {
      const adminId = req.user?.id;
      if (!adminId) {
        ApiResponse.unauthorized(res, 'Admin access required');
        return;
      }

      const { name, email } = req.body as { name?: string; email?: string };
      const data: Prisma.AdminUpdateInput = {};
      if (name !== undefined) data.name = name;
      if (email !== undefined) data.email = email.toLowerCase();

      const admin = await prisma.admin.update({
        where: { id: adminId },
        data,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      ApiResponse.success(res, admin, 'Profile updated');
    } catch (error) {
      // Unique constraint (email already in use) → 409, not a generic 500.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        ApiResponse.conflict(res, 'That email address is already in use');
        return;
      }
      console.error('Update admin profile error:', error);
      ApiResponse.error(res, 'Failed to update profile');
    }
  }

  // Change the authenticated admin's password (requires the current password).
  static async changePassword(req: AuthRequest, res: Response): Promise<void> {
    try {
      const adminId = req.user?.id;
      if (!adminId) {
        ApiResponse.unauthorized(res, 'Admin access required');
        return;
      }

      const { currentPassword, newPassword } = req.body as {
        currentPassword: string;
        newPassword: string;
      };

      const admin = await prisma.admin.findUnique({ where: { id: adminId } });
      if (!admin) {
        ApiResponse.notFound(res, 'Admin not found');
        return;
      }

      const isValid = await bcrypt.compare(currentPassword, admin.password);
      if (!isValid) {
        ApiResponse.badRequest(res, 'Current password is incorrect');
        return;
      }

      const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      await prisma.admin.update({
        where: { id: adminId },
        data: { password: hashed },
      });

      ApiResponse.success(res, null, 'Password changed');
    } catch (error) {
      console.error('Change admin password error:', error);
      ApiResponse.error(res, 'Failed to change password');
    }
  }
}
