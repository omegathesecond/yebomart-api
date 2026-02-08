import crypto from 'crypto';
import { prisma } from '@config/prisma';
import { ShopTier } from '@prisma/client';

const LICENSE_SECRET = process.env.LICENSE_SECRET || 'yebomart-license-secret';

interface LicenseData {
  shopId: string;
  tier: ShopTier;
  expiresAt: Date;
  features: string[];
}

export class LicenseService {
  /**
   * Generate a license key
   */
  static generateLicenseKey(data: LicenseData): string {
    const payload = {
      shopId: data.shopId,
      tier: data.tier,
      expiresAt: data.expiresAt.toISOString(),
      features: data.features,
      issuedAt: new Date().toISOString(),
    };

    const jsonPayload = JSON.stringify(payload);
    const base64Payload = Buffer.from(jsonPayload).toString('base64url');
    
    // Create signature
    const signature = crypto
      .createHmac('sha256', LICENSE_SECRET)
      .update(base64Payload)
      .digest('base64url');

    return `YM${base64Payload}.${signature}`;
  }

  /**
   * Validate a license key
   */
  static validateLicenseKey(licenseKey: string): LicenseData | null {
    try {
      if (!licenseKey.startsWith('YM')) {
        return null;
      }

      const parts = licenseKey.substring(2).split('.');
      if (parts.length !== 2) {
        return null;
      }

      const [payload, signature] = parts;

      // Verify signature
      const expectedSignature = crypto
        .createHmac('sha256', LICENSE_SECRET)
        .update(payload)
        .digest('base64url');

      if (signature !== expectedSignature) {
        return null;
      }

      // Decode payload
      const jsonPayload = Buffer.from(payload, 'base64url').toString();
      const data = JSON.parse(jsonPayload);

      return {
        shopId: data.shopId,
        tier: data.tier as ShopTier,
        expiresAt: new Date(data.expiresAt),
        features: data.features,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get license status for a shop
   */
  static async getStatus(shopId: string) {
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: {
        id: true,
        tier: true,
        licenseKey: true,
        licenseExpiry: true,
        monthlyTransactions: true,
        monthlyStockMoves: true,
        _count: {
          select: { products: true, users: true },
        },
      },
    });

    if (!shop) {
      throw new Error('Shop not found');
    }

    const now = new Date();
    const isExpired = shop.licenseExpiry ? shop.licenseExpiry < now : false;
    const daysRemaining = shop.licenseExpiry
      ? Math.ceil((shop.licenseExpiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      : null;

    // Tier limits
    const limits = this.getTierLimits(shop.tier);
    const isWithinLimits = shop._count.products <= limits.maxProducts;

    return {
      tier: shop.tier,
      isActive: !isExpired && isWithinLimits,
      isExpired,
      expiresAt: shop.licenseExpiry,
      daysRemaining,
      usage: {
        products: shop._count.products,
        users: shop._count.users,
        monthlyTransactions: shop.monthlyTransactions,
        monthlyStockMoves: shop.monthlyStockMoves,
      },
      limits,
      features: this.getTierFeatures(shop.tier),
    };
  }

  /**
   * Validate and apply a license key
   */
  static async validateAndApply(shopId: string, licenseKey: string) {
    const licenseData = this.validateLicenseKey(licenseKey);

    if (!licenseData) {
      throw new Error('Invalid license key');
    }

    if (licenseData.shopId !== shopId) {
      throw new Error('License key is not valid for this shop');
    }

    if (licenseData.expiresAt < new Date()) {
      throw new Error('License key has expired');
    }

    // Apply license
    const shop = await prisma.shop.update({
      where: { id: shopId },
      data: {
        tier: licenseData.tier,
        licenseKey,
        licenseExpiry: licenseData.expiresAt,
      },
      select: {
        id: true,
        tier: true,
        licenseExpiry: true,
      },
    });

    return {
      success: true,
      tier: shop.tier,
      expiresAt: shop.licenseExpiry,
      features: this.getTierFeatures(shop.tier),
    };
  }

  /**
   * Get tier limits
   */
  static getTierLimits(tier: ShopTier) {
    switch (tier) {
      case 'FREE':
        return {
          maxProducts: 50,
          maxUsers: 1,
          aiQueriesPerMonth: 20,
          whatsappReports: false,
          advancedAnalytics: false,
        };
      case 'PRO':
        return {
          maxProducts: Infinity,
          maxUsers: 3,
          aiQueriesPerMonth: 500,
          whatsappReports: true,
          advancedAnalytics: false,
        };
      case 'BUSINESS':
        return {
          maxProducts: Infinity,
          maxUsers: Infinity,
          aiQueriesPerMonth: Infinity,
          whatsappReports: true,
          advancedAnalytics: true,
        };
    }
  }

  /**
   * Get tier features
   */
  static getTierFeatures(tier: ShopTier) {
    const features = ['basic_pos', 'stock_tracking', 'basic_reports'];

    if (tier === 'PRO' || tier === 'BUSINESS') {
      features.push('unlimited_products', 'ai_assistant', 'whatsapp_reports');
    }

    if (tier === 'BUSINESS') {
      features.push('multi_user', 'advanced_analytics', 'priority_support', 'custom_branding');
    }

    return features;
  }

  /**
   * Check if a feature is available for a tier
   */
  static hasFeature(tier: ShopTier, feature: string): boolean {
    return this.getTierFeatures(tier).includes(feature);
  }

  /**
   * Create a trial license (30 days PRO)
   */
  static async createTrialLicense(shopId: string) {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const licenseKey = this.generateLicenseKey({
      shopId,
      tier: 'PRO',
      expiresAt,
      features: this.getTierFeatures('PRO'),
    });

    return this.validateAndApply(shopId, licenseKey);
  }
}
