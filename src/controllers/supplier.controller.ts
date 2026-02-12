import { Response } from 'express';
import Joi from 'joi';
import { PrismaClient } from '@prisma/client';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';

const prisma = new PrismaClient();

export const createSupplierSchema = Joi.object({
  name: Joi.string().required().min(2).max(200),
  contactName: Joi.string().optional().max(100),
  phone: Joi.string().optional().max(20),
  email: Joi.string().optional().email(),
  address: Joi.string().optional().max(500),
  taxId: Joi.string().optional().max(50),
  paymentTerms: Joi.string().optional().max(50),
  notes: Joi.string().optional().max(1000),
});

export const updateSupplierSchema = Joi.object({
  name: Joi.string().optional().min(2).max(200),
  contactName: Joi.string().optional().max(100),
  phone: Joi.string().optional().max(20),
  email: Joi.string().optional().email(),
  address: Joi.string().optional().max(500),
  taxId: Joi.string().optional().max(50),
  paymentTerms: Joi.string().optional().max(50),
  notes: Joi.string().optional().max(1000),
  isActive: Joi.boolean().optional(),
});

export const listSuppliersSchema = Joi.object({
  page: Joi.number().optional().integer().min(1).default(1),
  limit: Joi.number().optional().integer().min(1).max(100).default(50),
  search: Joi.string().optional(),
  isActive: Joi.boolean().optional(),
});

export const supplierProductSchema = Joi.object({
  productId: Joi.string().required(),
  costPrice: Joi.number().required().min(0),
  minOrder: Joi.number().optional().integer().min(1).default(1),
  leadDays: Joi.number().optional().integer().min(0),
  sku: Joi.string().optional().max(50),
  isPreferred: Joi.boolean().optional().default(false),
});

export class SupplierController {
  /**
   * Create a new supplier
   */
  static async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const supplier = await prisma.supplier.create({
        data: {
          shopId: req.user.shopId,
          ...req.body,
        },
      });

      ApiResponse.created(res, supplier, 'Supplier created successfully');
    } catch (error: any) {
      if (error.code === 'P2002') {
        ApiResponse.badRequest(res, 'Supplier with this phone already exists');
      } else {
        ApiResponse.serverError(res, error.message, error);
      }
    }
  }

  /**
   * List suppliers
   */
  static async list(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { page = 1, limit = 50, search, isActive } = req.query as any;
      const skip = (page - 1) * limit;

      const where: any = { shopId: req.user.shopId };
      if (isActive !== undefined) where.isActive = isActive === 'true';
      if (search) {
        where.OR = [
          { name: { contains: search, mode: 'insensitive' } },
          { contactName: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search } },
        ];
      }

      const [suppliers, total] = await Promise.all([
        prisma.supplier.findMany({
          where,
          skip,
          take: parseInt(limit),
          orderBy: { name: 'asc' },
          include: {
            _count: {
              select: { products: true, orders: true },
            },
          },
        }),
        prisma.supplier.count({ where }),
      ]);

      ApiResponse.success(res, suppliers, undefined, 200, {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        hasNext: skip + suppliers.length < total,
        hasPrev: page > 1,
      });
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Get supplier by ID
   */
  static async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const supplier = await prisma.supplier.findFirst({
        where: {
          id: req.params.id,
          shopId: req.user.shopId,
        },
        include: {
          products: true,
          orders: {
            take: 10,
            orderBy: { createdAt: 'desc' },
          },
        },
      });

      if (!supplier) {
        ApiResponse.notFound(res, 'Supplier not found');
        return;
      }

      ApiResponse.success(res, supplier);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Update supplier
   */
  static async update(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const existing = await prisma.supplier.findFirst({
        where: {
          id: req.params.id,
          shopId: req.user.shopId,
        },
      });

      if (!existing) {
        ApiResponse.notFound(res, 'Supplier not found');
        return;
      }

      const supplier = await prisma.supplier.update({
        where: { id: req.params.id },
        data: req.body,
      });

      ApiResponse.success(res, supplier, 'Supplier updated successfully');
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Delete supplier
   */
  static async delete(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const existing = await prisma.supplier.findFirst({
        where: {
          id: req.params.id,
          shopId: req.user.shopId,
        },
      });

      if (!existing) {
        ApiResponse.notFound(res, 'Supplier not found');
        return;
      }

      await prisma.supplier.delete({
        where: { id: req.params.id },
      });

      ApiResponse.success(res, null, 'Supplier deleted successfully');
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Add product to supplier
   */
  static async addProduct(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const supplierId = req.params.id;
      const { productId, costPrice, minOrder, leadDays, sku, isPreferred } = req.body;

      // Verify supplier belongs to shop
      const supplier = await prisma.supplier.findFirst({
        where: { id: supplierId, shopId: req.user.shopId },
      });

      if (!supplier) {
        ApiResponse.notFound(res, 'Supplier not found');
        return;
      }

      // Verify product belongs to shop
      const product = await prisma.product.findFirst({
        where: { id: productId, shopId: req.user.shopId },
      });

      if (!product) {
        ApiResponse.notFound(res, 'Product not found');
        return;
      }

      const supplierProduct = await prisma.supplierProduct.upsert({
        where: {
          supplierId_productId: { supplierId, productId },
        },
        update: { costPrice, minOrder, leadDays, sku, isPreferred },
        create: {
          supplierId,
          productId,
          costPrice,
          minOrder: minOrder || 1,
          leadDays,
          sku,
          isPreferred: isPreferred || false,
        },
      });

      ApiResponse.success(res, supplierProduct, 'Product linked to supplier');
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Remove product from supplier
   */
  static async removeProduct(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { id: supplierId, productId } = req.params;

      await prisma.supplierProduct.delete({
        where: {
          supplierId_productId: { supplierId, productId },
        },
      });

      ApiResponse.success(res, null, 'Product removed from supplier');
    } catch (error: any) {
      if (error.code === 'P2025') {
        ApiResponse.notFound(res, 'Product not linked to this supplier');
      } else {
        ApiResponse.serverError(res, error.message, error);
      }
    }
  }
}
