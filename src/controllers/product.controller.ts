import { Response } from 'express';
import Joi from 'joi';
import { ProductService } from '@services/product.service';
import { ApiResponse } from '@utils/ApiResponse';
import { AuthRequest } from '@middleware/auth.middleware';

// Optional rules are replaced as a pair; null/null clears them. Omission retains them.
const optionalProductFields = {
  attributes: Joi.object().unknown(true).max(50).allow(null).custom((value, helpers) => {
    for (const [key, entry] of Object.entries(value)) {
      if (!key.trim() || key.length > 80 || ['__proto__', 'constructor', 'prototype'].includes(key) ||
          !(typeof entry === 'string' && entry.length <= 500 || typeof entry === 'number' && Number.isFinite(entry))) {
        return helpers.error('any.invalid');
      }
    }
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= 16384 ? value : helpers.error('any.invalid');
  }),
  wholesalePrice: Joi.number().strict().min(0).allow(null),
  wholesaleMinQty: Joi.number().strict().integer().min(1).max(2147483647).allow(null),
  packPrice: Joi.number().strict().min(0).allow(null),
  packSize: Joi.number().strict().integer().min(1).max(2147483647).allow(null),
};

function validatePricingPairs(value: Record<string, unknown>, helpers: Joi.CustomHelpers) {
  for (const [price, quantity] of [['wholesalePrice', 'wholesaleMinQty'], ['packPrice', 'packSize']]) {
    const p = value[price];
    const q = value[quantity];
    if ((p === undefined) !== (q === undefined) || (p === null) !== (q === null)) {
      return helpers.message({ 'custom': `${price} and ${quantity} must both be supplied, or both be null to clear` });
    }
  }
  return value;
}

export const createProductSchema = Joi.object({
  ...optionalProductFields,
  barcode: Joi.string().optional().trim(),
  sku: Joi.string().optional().trim(),
  name: Joi.string().required().trim().min(1).max(200),
  description: Joi.string().optional().max(1000),
  category: Joi.string().optional().trim(),
  costPrice: Joi.number().required().min(0),
  sellPrice: Joi.number().required().min(0),
  quantity: Joi.number().optional().integer().min(0).default(0),
  reorderAt: Joi.number().optional().integer().min(0).default(10),
  unit: Joi.string().optional().valid('each', 'kg', 'litre', 'pack', 'box').default('each'),
  imageUrl: Joi.string().optional().uri(),
  localId: Joi.string().optional(), // For offline sync
}).custom(validatePricingPairs);

export const updateProductSchema = Joi.object({
  ...optionalProductFields,
  barcode: Joi.string().optional().trim().allow(''),
  sku: Joi.string().optional().trim().allow(''),
  name: Joi.string().optional().trim().min(1).max(200),
  description: Joi.string().optional().max(1000).allow(''),
  category: Joi.string().optional().trim().allow(''),
  costPrice: Joi.number().optional().min(0),
  sellPrice: Joi.number().optional().min(0),
  quantity: Joi.number().optional().integer().min(0),
  reorderAt: Joi.number().optional().integer().min(0),
  unit: Joi.string().optional().valid('each', 'kg', 'litre', 'pack', 'box'),
  imageUrl: Joi.string().optional().uri().allow(''),
  isActive: Joi.boolean().optional(),
  trackStock: Joi.boolean().optional(),
}).custom(validatePricingPairs);

export const listProductsSchema = Joi.object({
  page: Joi.number().optional().integer().min(1).default(1),
  limit: Joi.number().optional().integer().min(1).max(100).default(20),
  search: Joi.string().optional().trim(),
  category: Joi.string().optional().trim(),
  lowStock: Joi.boolean().optional(),
  isActive: Joi.boolean().optional(),
});

// Bulk import schema
export const bulkImportSchema = Joi.object({
  products: Joi.array().items(
    Joi.object({
      barcode: Joi.string().optional().trim().allow(''),
      name: Joi.string().required().trim().min(1).max(200),
      category: Joi.string().optional().trim(),
      costPrice: Joi.number().required().min(0),
      sellPrice: Joi.number().required().min(0),
      quantity: Joi.number().optional().integer().min(0).default(0),
      reorderAt: Joi.number().optional().integer().min(0).default(10),
      unit: Joi.string().optional().valid('each', 'kg', 'litre', 'pack', 'box').default('each'),
    })
  ).min(1).max(500).required(),
  updateExisting: Joi.boolean().optional().default(false),
});

// Bulk update schema (for price changes, etc.)
export const bulkUpdateSchema = Joi.object({
  updates: Joi.array().items(
    Joi.object({
      id: Joi.string().optional(),
      barcode: Joi.string().optional(),
      costPrice: Joi.number().optional().min(0),
      sellPrice: Joi.number().optional().min(0),
      quantity: Joi.number().optional().integer().min(0),
      isActive: Joi.boolean().optional(),
    }).or('id', 'barcode') // Must have either id or barcode
  ).min(1).max(500).required(),
});

export class ProductController {
  /**
   * Create a new product
   */
  static async create(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const product = await ProductService.create({
        ...req.body,
        shopId: req.user.shopId,
      });

      ApiResponse.created(res, product, 'Product created successfully');
    } catch (error: any) {
      if (error.message.includes('already exists')) {
        ApiResponse.conflict(res, error.message);
      } else {
        ApiResponse.badRequest(res, error.message, error);
      }
    }
  }

  /**
   * List products
   */
  static async list(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const result = await ProductService.list({
        shopId: req.user.shopId,
        ...req.query,
      });

      ApiResponse.success(res, result.products, undefined, 200, {
        total: result.total,
        page: result.page,
        limit: result.limit,
        hasNext: result.hasNext,
        hasPrev: result.hasPrev,
      });
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Get product by ID
   */
  static async getById(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { id } = req.params;
      const product = await ProductService.getById(id, req.user.shopId);
      ApiResponse.success(res, product);
    } catch (error: any) {
      if (error.message.includes('not found')) {
        ApiResponse.notFound(res, error.message);
      } else {
        ApiResponse.serverError(res, error.message, error);
      }
    }
  }

  /**
   * Get product by barcode
   */
  static async getByBarcode(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { barcode } = req.params;
      const product = await ProductService.getByBarcode(barcode, req.user.shopId);
      ApiResponse.success(res, product);
    } catch (error: any) {
      if (error.message.includes('not found')) {
        ApiResponse.notFound(res, error.message);
      } else {
        ApiResponse.serverError(res, error.message, error);
      }
    }
  }

  /**
   * Update product
   */
  static async update(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { id } = req.params;
      const product = await ProductService.update(id, req.user.shopId, req.body);
      ApiResponse.success(res, product, 'Product updated successfully');
    } catch (error: any) {
      if (error.message.includes('not found')) {
        ApiResponse.notFound(res, error.message);
      } else if (error.message.includes('already exists')) {
        ApiResponse.conflict(res, error.message);
      } else {
        ApiResponse.badRequest(res, error.message, error);
      }
    }
  }

  /**
   * Delete product
   */
  static async delete(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { id } = req.params;
      await ProductService.delete(id, req.user.shopId);
      ApiResponse.success(res, null, 'Product deleted successfully');
    } catch (error: any) {
      if (error.message.includes('not found')) {
        ApiResponse.notFound(res, error.message);
      } else {
        ApiResponse.serverError(res, error.message, error);
      }
    }
  }

  /**
   * Get categories
   */
  static async getCategories(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const categories = await ProductService.getCategories(req.user.shopId);
      ApiResponse.success(res, categories);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }

  /**
   * Bulk import products
   */
  static async bulkImport(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { products, updateExisting } = req.body;
      const result = await ProductService.bulkImport(
        req.user.shopId,
        products,
        updateExisting
      );

      ApiResponse.success(res, result, `Imported ${result.created} products, updated ${result.updated}, skipped ${result.skipped}`);
    } catch (error: any) {
      ApiResponse.badRequest(res, error.message, error);
    }
  }

  /**
   * Bulk update products (prices, quantities, status)
   */
  static async bulkUpdate(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const { updates } = req.body;
      const result = await ProductService.bulkUpdate(req.user.shopId, updates);

      ApiResponse.success(res, result, `Updated ${result.updated} products, failed ${result.failed}`);
    } catch (error: any) {
      ApiResponse.badRequest(res, error.message, error);
    }
  }

  /**
   * Export products as CSV
   */
  static async exportCSV(req: AuthRequest, res: Response): Promise<void> {
    try {
      if (!req.user) {
        ApiResponse.unauthorized(res, 'Unauthorized');
        return;
      }

      const csv = await ProductService.exportCSV(req.user.shopId);
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=products.csv');
      res.send(csv);
    } catch (error: any) {
      ApiResponse.serverError(res, error.message, error);
    }
  }
}
