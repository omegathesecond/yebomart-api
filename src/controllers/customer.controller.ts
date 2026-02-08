import { Response } from 'express';
import Joi from 'joi';
import { prisma } from '@config/prisma';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';

export const createCustomerSchema = Joi.object({
  name: Joi.string().required().trim().min(2).max(100),
  phone: Joi.string().optional().trim(),
  email: Joi.string().optional().email(),
  address: Joi.string().optional().max(500),
  creditLimit: Joi.number().optional().min(0).default(0),
});

export const addCreditSchema = Joi.object({
  type: Joi.string().required().valid('PURCHASE', 'PAYMENT', 'ADJUSTMENT', 'REFUND'),
  amount: Joi.number().required().min(0),
  note: Joi.string().optional().max(500),
  saleId: Joi.string().optional(),
});

export class CustomerController {
  /**
   * Create customer
   */
  static async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const customer = await prisma.customer.create({
        data: {
          shopId: req.user.shopId,
          ...req.body,
        },
      });

      ApiResponse.created(res, customer, 'Customer created');
    } catch (error: any) {
      if (error.code === 'P2002') {
        ApiResponse.conflict(res, 'Customer with this phone already exists');
      } else {
        ApiResponse.badRequest(res, error.message);
      }
    }
  }

  /**
   * List customers
   */
  static async list(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { search, hasBalance } = req.query;

      const where: any = { shopId: req.user.shopId, isActive: true };
      if (search) {
        where.OR = [
          { name: { contains: search as string, mode: 'insensitive' } },
          { phone: { contains: search as string } },
        ];
      }
      if (hasBalance === 'true') {
        where.balance = { gt: 0 };
      }

      const customers = await prisma.customer.findMany({
        where,
        orderBy: { name: 'asc' },
        include: {
          _count: { select: { sales: true, credits: true } },
        },
      });

      // Calculate total owed
      const totalOwed = customers.reduce((sum, c) => sum + (c.balance > 0 ? c.balance : 0), 0);

      ApiResponse.success(res, { customers, totalOwed });
    } catch (error: any) {
      ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Get customer details
   */
  static async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const customer = await prisma.customer.findFirst({
        where: { id: req.params.id, shopId: req.user.shopId },
        include: {
          credits: {
            orderBy: { createdAt: 'desc' },
            take: 50,
          },
          sales: {
            orderBy: { createdAt: 'desc' },
            take: 20,
            include: { items: true },
          },
        },
      });

      if (!customer) {
        ApiResponse.notFound(res, 'Customer not found');
        return;
      }

      ApiResponse.success(res, customer);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Add credit entry (payment or purchase)
   */
  static async addCredit(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { id } = req.params;
      const { type, amount, note, saleId } = req.body;

      const customer = await prisma.customer.findFirst({
        where: { id, shopId: req.user.shopId },
      });

      if (!customer) {
        ApiResponse.notFound(res, 'Customer not found');
        return;
      }

      // Calculate balance change
      let balanceChange = 0;
      if (type === 'PURCHASE') {
        balanceChange = amount; // They owe more
      } else if (type === 'PAYMENT') {
        balanceChange = -amount; // They paid
      } else if (type === 'REFUND') {
        balanceChange = -amount; // We owe them
      }
      // ADJUSTMENT can be positive or negative based on amount sign

      const [credit, updatedCustomer] = await prisma.$transaction([
        prisma.customerCredit.create({
          data: {
            shopId: req.user.shopId,
            customerId: id,
            type,
            amount,
            note,
            saleId,
            userId: req.user.id,
          },
        }),
        prisma.customer.update({
          where: { id },
          data: { balance: { increment: balanceChange } },
        }),
      ]);

      ApiResponse.success(res, { credit, newBalance: updatedCustomer.balance }, 'Credit entry added');
    } catch (error: any) {
      ApiResponse.badRequest(res, error.message);
    }
  }

  /**
   * Update customer
   */
  static async update(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const customer = await prisma.customer.updateMany({
        where: { id: req.params.id, shopId: req.user.shopId },
        data: req.body,
      });

      if (customer.count === 0) {
        ApiResponse.notFound(res, 'Customer not found');
        return;
      }

      ApiResponse.success(res, null, 'Customer updated');
    } catch (error: any) {
      ApiResponse.badRequest(res, error.message);
    }
  }
}
