import { prisma } from '@config/prisma';
import { Prisma } from '@prisma/client';
import { paginate, paginationMeta } from '@utils/pagination';

interface CreateProductInput {
  shopId: string;
  barcode?: string;
  sku?: string;
  name: string;
  description?: string;
  category?: string;
  costPrice: number;
  sellPrice: number;
  quantity?: number;
  reorderAt?: number;
  unit?: string;
  imageUrl?: string;
  localId?: string;
}

interface UpdateProductInput {
  barcode?: string;
  sku?: string;
  name?: string;
  description?: string;
  category?: string;
  costPrice?: number;
  sellPrice?: number;
  quantity?: number;
  reorderAt?: number;
  unit?: string;
  imageUrl?: string;
  isActive?: boolean;
  trackStock?: boolean;
}

interface ListProductsParams {
  shopId: string;
  page?: number;
  limit?: number;
  search?: string;
  category?: string;
  lowStock?: boolean;
  isActive?: boolean;
}

export class ProductService {
  /**
   * Create a new product
   */
  static async create(input: CreateProductInput) {
    // Check for duplicate barcode
    if (input.barcode) {
      const existing = await prisma.product.findFirst({
        where: {
          shopId: input.shopId,
          barcode: input.barcode,
        },
      });

      if (existing) {
        throw new Error('A product with this barcode already exists');
      }
    }

    const product = await prisma.product.create({
      data: {
        shopId: input.shopId,
        barcode: input.barcode,
        sku: input.sku,
        name: input.name,
        description: input.description,
        category: input.category,
        costPrice: input.costPrice,
        sellPrice: input.sellPrice,
        quantity: input.quantity || 0,
        reorderAt: input.reorderAt || 10,
        unit: input.unit || 'each',
        imageUrl: input.imageUrl,
        localId: input.localId,
        syncedAt: new Date(),
      },
    });

    // Create initial stock log if quantity > 0
    if (input.quantity && input.quantity > 0) {
      await prisma.stockLog.create({
        data: {
          shopId: input.shopId,
          productId: product.id,
          type: 'INITIAL',
          quantity: input.quantity,
          previousQty: 0,
          newQty: input.quantity,
          note: 'Initial stock',
        },
      });
    }

    return product;
  }

  /**
   * List products with filtering and pagination
   */
  static async list(params: ListProductsParams) {
    const { skip, take, page, limit } = paginate(params);

    const where: Prisma.ProductWhereInput = {
      shopId: params.shopId,
    };

    if (params.search) {
      where.OR = [
        { name: { contains: params.search, mode: 'insensitive' } },
        { barcode: { contains: params.search, mode: 'insensitive' } },
        { sku: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    if (params.category) {
      where.category = params.category;
    }

    if (params.isActive !== undefined) {
      where.isActive = params.isActive;
    } else {
      where.isActive = true; // Default to active only
    }

    if (params.lowStock) {
      where.trackStock = true;
      // This raw query approach works better for comparing columns
      where.quantity = { lte: 10 }; // We'll filter more precisely after
    }

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        skip,
        take,
        orderBy: { name: 'asc' },
      }),
      prisma.product.count({ where }),
    ]);

    // Filter for actual low stock if needed
    const filteredProducts = params.lowStock
      ? products.filter(p => p.quantity <= p.reorderAt)
      : products;

    return {
      products: filteredProducts,
      ...paginationMeta(total, page, limit),
    };
  }

  /**
   * Get product by ID
   */
  static async getById(productId: string, shopId: string) {
    const product = await prisma.product.findFirst({
      where: {
        id: productId,
        shopId,
      },
    });

    if (!product) {
      throw new Error('Product not found');
    }

    return product;
  }

  /**
   * Get product by barcode
   */
  static async getByBarcode(barcode: string, shopId: string) {
    const product = await prisma.product.findFirst({
      where: {
        barcode,
        shopId,
        isActive: true,
      },
    });

    if (!product) {
      throw new Error('Product not found');
    }

    return product;
  }

  /**
   * Update product
   */
  static async update(productId: string, shopId: string, data: UpdateProductInput) {
    // Verify product belongs to shop
    const existing = await prisma.product.findFirst({
      where: { id: productId, shopId },
    });

    if (!existing) {
      throw new Error('Product not found');
    }

    // Check for duplicate barcode
    if (data.barcode && data.barcode !== existing.barcode) {
      const duplicate = await prisma.product.findFirst({
        where: {
          shopId,
          barcode: data.barcode,
          id: { not: productId },
        },
      });

      if (duplicate) {
        throw new Error('A product with this barcode already exists');
      }
    }

    const product = await prisma.product.update({
      where: { id: productId },
      data: {
        ...data,
        syncedAt: new Date(),
      },
    });

    return product;
  }

  /**
   * Delete product (soft delete by setting isActive = false)
   */
  static async delete(productId: string, shopId: string) {
    const existing = await prisma.product.findFirst({
      where: { id: productId, shopId },
    });

    if (!existing) {
      throw new Error('Product not found');
    }

    await prisma.product.update({
      where: { id: productId },
      data: { isActive: false },
    });

    return { message: 'Product deleted' };
  }

  /**
   * Get categories for a shop
   */
  static async getCategories(shopId: string) {
    const categories = await prisma.product.findMany({
      where: {
        shopId,
        isActive: true,
        category: { not: null },
      },
      select: { category: true },
      distinct: ['category'],
    });

    return categories
      .map(c => c.category)
      .filter((c): c is string => c !== null)
      .sort();
  }

  /**
   * Bulk import products
   */
  static async bulkImport(
    shopId: string,
    products: Array<{
      barcode?: string;
      name: string;
      category?: string;
      costPrice: number;
      sellPrice: number;
      quantity?: number;
      reorderAt?: number;
      unit?: string;
    }>,
    updateExisting = false
  ) {
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors: Array<{ row: number; error: string }> = [];

    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      try {
        // Check if product exists by barcode
        let existing = null;
        if (product.barcode) {
          existing = await prisma.product.findFirst({
            where: { shopId, barcode: product.barcode },
          });
        }

        if (existing) {
          if (updateExisting) {
            await prisma.product.update({
              where: { id: existing.id },
              data: {
                name: product.name,
                category: product.category,
                costPrice: product.costPrice,
                sellPrice: product.sellPrice,
                quantity: product.quantity ?? existing.quantity,
                reorderAt: product.reorderAt ?? existing.reorderAt,
                unit: product.unit ?? existing.unit,
                syncedAt: new Date(),
              },
            });
            updated++;
          } else {
            skipped++;
          }
        } else {
          await prisma.product.create({
            data: {
              shopId,
              barcode: product.barcode || null,
              name: product.name,
              category: product.category,
              costPrice: product.costPrice,
              sellPrice: product.sellPrice,
              quantity: product.quantity || 0,
              reorderAt: product.reorderAt || 10,
              unit: product.unit || 'each',
              syncedAt: new Date(),
            },
          });
          created++;
        }
      } catch (error: any) {
        errors.push({ row: i + 1, error: error.message });
        skipped++;
      }
    }

    return { created, updated, skipped, errors };
  }

  /**
   * Bulk update products
   */
  static async bulkUpdate(
    shopId: string,
    updates: Array<{
      id?: string;
      barcode?: string;
      costPrice?: number;
      sellPrice?: number;
      quantity?: number;
      isActive?: boolean;
    }>
  ) {
    let updated = 0;
    let failed = 0;
    const errors: Array<{ identifier: string; error: string }> = [];

    for (const update of updates) {
      try {
        let product = null;

        if (update.id) {
          product = await prisma.product.findFirst({
            where: { id: update.id, shopId },
          });
        } else if (update.barcode) {
          product = await prisma.product.findFirst({
            where: { barcode: update.barcode, shopId },
          });
        }

        if (!product) {
          errors.push({
            identifier: update.id || update.barcode || 'unknown',
            error: 'Product not found',
          });
          failed++;
          continue;
        }

        const updateData: any = { syncedAt: new Date() };
        if (update.costPrice !== undefined) updateData.costPrice = update.costPrice;
        if (update.sellPrice !== undefined) updateData.sellPrice = update.sellPrice;
        if (update.quantity !== undefined) updateData.quantity = update.quantity;
        if (update.isActive !== undefined) updateData.isActive = update.isActive;

        await prisma.product.update({
          where: { id: product.id },
          data: updateData,
        });
        updated++;
      } catch (error: any) {
        errors.push({
          identifier: update.id || update.barcode || 'unknown',
          error: error.message,
        });
        failed++;
      }
    }

    return { updated, failed, errors };
  }

  /**
   * Export products as CSV
   */
  static async exportCSV(shopId: string) {
    const products = await prisma.product.findMany({
      where: { shopId, isActive: true },
      orderBy: { name: 'asc' },
    });

    const headers = [
      'barcode',
      'name',
      'category',
      'costPrice',
      'sellPrice',
      'quantity',
      'reorderAt',
      'unit',
    ];

    const rows = products.map(p => [
      p.barcode || '',
      `"${p.name.replace(/"/g, '""')}"`,
      p.category || '',
      p.costPrice.toString(),
      p.sellPrice.toString(),
      p.quantity.toString(),
      p.reorderAt.toString(),
      p.unit,
    ]);

    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }
}
