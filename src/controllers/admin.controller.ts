import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { ApiResponse } from '@utils/ApiResponse';
import Joi from 'joi';

const prisma = new PrismaClient();

const JWT_SECRET = process.env.JWT_SECRET || 'yebomart-jwt-secret';

export const adminLoginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
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
        prisma.shop.count({ where: { tier: { not: 'FREE' } } }), // Paid shops
        prisma.shop.count({
          where: {
            createdAt: {
              gte: new Date(new Date().setHours(0, 0, 0, 0)),
            },
          },
        }),
      ]);

      // Get total revenue (sum of all sales)
      const revenueResult = await prisma.sale.aggregate({
        _sum: { totalAmount: true },
      });

      ApiResponse.success(res, {
        totalShops,
        activeShops,
        newShopsToday,
        totalRevenue: revenueResult._sum?.totalAmount || 0,
      });
    } catch (error) {
      console.error('Dashboard error:', error);
      ApiResponse.error(res, 'Failed to fetch dashboard data');
    }
  }

  // List all shops
  static async getShops(req: Request, res: Response): Promise<void> {
    try {
      const { page = 1, limit = 20, search } = req.query;
      const skip = (Number(page) - 1) * Number(limit);

      const where = search
        ? {
            OR: [
              { name: { contains: String(search), mode: 'insensitive' as const } },
              { ownerName: { contains: String(search), mode: 'insensitive' as const } },
            ],
          }
        : {};

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

  // Update shop subscription
  static async updateSubscription(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { tier } = req.body;

      const shop = await prisma.shop.update({
        where: { id },
        data: { tier },
      });

      ApiResponse.success(res, shop, 'Subscription updated');
    } catch (error) {
      console.error('Update subscription error:', error);
      ApiResponse.error(res, 'Failed to update subscription');
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
      const { page = 1, limit = 20 } = req.query;
      const skip = (Number(page) - 1) * Number(limit);

      const [users, total] = await Promise.all([
        prisma.user.findMany({
          skip,
          take: Number(limit),
          orderBy: { createdAt: 'desc' },
          include: { shop: { select: { id: true, name: true } } },
        }),
        prisma.user.count(),
      ]);

      ApiResponse.success(res, { users, total, page: Number(page), limit: Number(limit) });
    } catch (error) {
      console.error('Get users error:', error);
      ApiResponse.error(res, 'Failed to fetch users');
    }
  }

  // Get subscriptions overview
  static async getSubscriptions(req: Request, res: Response): Promise<void> {
    try {
      const subscriptions = await prisma.shop.groupBy({
        by: ['tier'],
        _count: true,
      });

      ApiResponse.success(res, subscriptions);
    } catch (error) {
      console.error('Get subscriptions error:', error);
      ApiResponse.error(res, 'Failed to fetch subscriptions');
    }
  }
}
