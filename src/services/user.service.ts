import bcrypt from 'bcrypt';
import { prisma } from '@config/prisma';
import { Prisma, UserRole } from '@prisma/client';

const SALT_ROUNDS = 12;

interface CreateUserInput {
  shopId: string;
  name: string;
  phone: string;
  email?: string;
  password: string;
  pin?: string;
  role: UserRole;
  canDiscount?: boolean;
  canVoid?: boolean;
  canViewReports?: boolean;
  canManageStock?: boolean;
}

interface UpdateUserInput {
  name?: string;
  phone?: string;
  email?: string;
  password?: string;
  pin?: string;
  role?: UserRole;
  isActive?: boolean;
  canDiscount?: boolean;
  canVoid?: boolean;
  canViewReports?: boolean;
  canManageStock?: boolean;
}

export class UserService {
  /**
   * Create a new staff user
   */
  static async create(input: CreateUserInput) {
    // Check for duplicate phone in shop
    const existing = await prisma.user.findFirst({
      where: {
        shopId: input.shopId,
        phone: input.phone,
      },
    });

    if (existing) {
      throw new Error('A user with this phone number already exists');
    }

    // Hash password if provided (staff can use PIN only)
    const hashedPassword = input.password 
      ? await bcrypt.hash(input.password, SALT_ROUNDS)
      : undefined;

    const user = await prisma.user.create({
      data: {
        shopId: input.shopId,
        name: input.name,
        phone: input.phone,
        email: input.email,
        password: hashedPassword,
        pin: input.pin,
        role: input.role,
        canDiscount: input.canDiscount ?? false,
        canVoid: input.canVoid ?? false,
        canViewReports: input.canViewReports ?? false,
        canManageStock: input.canManageStock ?? false,
      },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        role: true,
        isActive: true,
        canDiscount: true,
        canVoid: true,
        canViewReports: true,
        canManageStock: true,
        createdAt: true,
      },
    });

    return user;
  }

  /**
   * List users for a shop
   */
  static async list(shopId: string, includeInactive = false) {
    const where: Prisma.UserWhereInput = { shopId };

    if (!includeInactive) {
      where.isActive = true;
    }

    const users = await prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        role: true,
        isActive: true,
        canDiscount: true,
        canVoid: true,
        canViewReports: true,
        canManageStock: true,
        lastLoginAt: true,
        createdAt: true,
      },
      orderBy: { name: 'asc' },
    });

    return users;
  }

  /**
   * Get user by ID
   */
  static async getById(userId: string, shopId: string) {
    const user = await prisma.user.findFirst({
      where: {
        id: userId,
        shopId,
      },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        role: true,
        isActive: true,
        canDiscount: true,
        canVoid: true,
        canViewReports: true,
        canManageStock: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: { sales: true },
        },
      },
    });

    if (!user) {
      throw new Error('User not found');
    }

    return user;
  }

  /**
   * Update user
   */
  static async update(userId: string, shopId: string, data: UpdateUserInput) {
    const existing = await prisma.user.findFirst({
      where: { id: userId, shopId },
    });

    if (!existing) {
      throw new Error('User not found');
    }

    // Check for duplicate phone
    if (data.phone && data.phone !== existing.phone) {
      const duplicate = await prisma.user.findFirst({
        where: {
          shopId,
          phone: data.phone,
          id: { not: userId },
        },
      });

      if (duplicate) {
        throw new Error('A user with this phone number already exists');
      }
    }

    // Hash password if being updated
    const updateData: Prisma.UserUpdateInput = { ...data };
    if (data.password) {
      updateData.password = await bcrypt.hash(data.password, SALT_ROUNDS);
    }
    
    // Remove empty pin (don't overwrite existing)
    if (!data.pin) {
      delete updateData.pin;
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        role: true,
        isActive: true,
        canDiscount: true,
        canVoid: true,
        canViewReports: true,
        canManageStock: true,
        updatedAt: true,
      },
    });

    return user;
  }

  /**
   * Delete user (soft delete)
   */
  static async delete(userId: string, shopId: string) {
    const existing = await prisma.user.findFirst({
      where: { id: userId, shopId },
    });

    if (!existing) {
      throw new Error('User not found');
    }

    // Don't allow deleting the last active user
    const activeUsers = await prisma.user.count({
      where: { shopId, isActive: true },
    });

    if (activeUsers <= 1 && existing.isActive) {
      throw new Error('Cannot delete the last active user');
    }

    await prisma.user.update({
      where: { id: userId },
      data: { isActive: false },
    });

    return { message: 'User deleted' };
  }

  /**
   * Get user performance stats
   */
  static async getStats(userId: string, shopId: string, startDate?: Date, endDate?: Date) {
    const now = new Date();
    const start = startDate || new Date(now.getFullYear(), now.getMonth(), 1);
    const end = endDate || now;

    const [sales, voids] = await Promise.all([
      prisma.sale.aggregate({
        where: {
          shopId,
          userId,
          status: 'COMPLETED',
          createdAt: { gte: start, lte: end },
        },
        _sum: { totalAmount: true },
        _count: true,
        _avg: { totalAmount: true },
      }),
      prisma.sale.count({
        where: {
          shopId,
          userId,
          status: 'VOIDED',
          createdAt: { gte: start, lte: end },
        },
      }),
    ]);

    return {
      period: { start, end },
      totalSales: sales._sum.totalAmount || 0,
      transactionCount: sales._count,
      averageTransaction: sales._avg.totalAmount || 0,
      voidCount: voids,
    };
  }
}
