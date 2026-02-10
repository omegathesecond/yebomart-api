import bcrypt from 'bcrypt';
import { prisma } from '@config/prisma';
import { JWTUtil, ITokenPayload } from '@utils/jwt';
import { UserRole } from '@prisma/client';

const SALT_ROUNDS = 12;

interface RegisterShopInput {
  name: string;
  ownerName: string;
  ownerPhone: string;
  ownerEmail?: string;
  password: string;
  assistantName?: string;
  businessType?: string;
}

interface LoginResult {
  shop: {
    id: string;
    name: string;
    ownerName: string;
    assistantName: string;
    tier: string;
  };
  user?: {
    id: string;
    name: string;
    role: UserRole;
  };
  accessToken: string;
  refreshToken: string;
}

export class AuthService {
  /**
   * Register a new shop (owner signup)
   */
  static async registerShop(input: RegisterShopInput): Promise<LoginResult> {
    // Check if phone already exists
    const existing = await prisma.shop.findUnique({
      where: { ownerPhone: input.ownerPhone },
    });

    if (existing) {
      throw new Error('Phone number already registered');
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(input.password, SALT_ROUNDS);

    // Create shop
    const shop = await prisma.shop.create({
      data: {
        name: input.name,
        ownerName: input.ownerName,
        ownerPhone: input.ownerPhone,
        ownerEmail: input.ownerEmail,
        password: hashedPassword,
        assistantName: input.assistantName || 'Yebo',
        businessType: input.businessType || 'general',
      },
    });

    // Generate tokens
    const payload: ITokenPayload = {
      id: shop.id,
      shopId: shop.id,
      phone: shop.ownerPhone,
      email: shop.ownerEmail || undefined,
      role: 'OWNER',
      type: 'shop',
    };

    const accessToken = JWTUtil.generateAccessToken(payload);
    const refreshToken = JWTUtil.generateRefreshToken(payload);

    return {
      shop: {
        id: shop.id,
        name: shop.name,
        ownerName: shop.ownerName,
        assistantName: shop.assistantName,
        tier: shop.tier,
      },
      accessToken,
      refreshToken,
    };
  }

  /**
   * Login with phone + password (shop owner)
   */
  static async loginShop(phone: string, password: string): Promise<LoginResult> {
    // Normalize phone to E.164 format
    let normalizedPhone = phone.replace(/\D/g, '');
    if (normalizedPhone.startsWith('0')) {
      normalizedPhone = '268' + normalizedPhone.slice(1);
    }
    if (!normalizedPhone.startsWith('268')) {
      normalizedPhone = '268' + normalizedPhone;
    }
    normalizedPhone = '+' + normalizedPhone;

    const shop = await prisma.shop.findUnique({
      where: { ownerPhone: normalizedPhone },
    });

    if (!shop) {
      throw new Error('Invalid phone or password');
    }

    const isValidPassword = await bcrypt.compare(password, shop.password);
    if (!isValidPassword) {
      throw new Error('Invalid phone or password');
    }

    const payload: ITokenPayload = {
      id: shop.id,
      shopId: shop.id,
      phone: shop.ownerPhone,
      email: shop.ownerEmail || undefined,
      role: 'OWNER',
      type: 'shop',
    };

    const accessToken = JWTUtil.generateAccessToken(payload);
    const refreshToken = JWTUtil.generateRefreshToken(payload);

    return {
      shop: {
        id: shop.id,
        name: shop.name,
        ownerName: shop.ownerName,
        assistantName: shop.assistantName,
        tier: shop.tier,
      },
      accessToken,
      refreshToken,
    };
  }

  /**
   * Login as staff user with phone + PIN
   */
  static async loginUser(phone: string, pin: string): Promise<LoginResult> {
    // Normalize phone
    let normalizedPhone = phone.replace(/\D/g, '');
    if (normalizedPhone.startsWith('0')) {
      normalizedPhone = '268' + normalizedPhone.slice(1);
    }
    if (!normalizedPhone.startsWith('268')) {
      normalizedPhone = '268' + normalizedPhone;
    }
    normalizedPhone = '+' + normalizedPhone;

    // Find user by phone
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { phone: normalizedPhone },
          { phone: phone }, // Try original format too
        ],
        isActive: true,
      },
      include: {
        shop: true,
      },
    });

    if (!user || !user.pin) {
      throw new Error('Invalid phone or PIN');
    }

    if (user.pin !== pin) {
      throw new Error('Invalid phone or PIN');
    }

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const payload: ITokenPayload = {
      id: user.id,
      shopId: user.shopId,
      phone: user.phone,
      role: user.role,
      type: 'user',
    };

    const accessToken = JWTUtil.generateAccessToken(payload);
    const refreshToken = JWTUtil.generateRefreshToken(payload);

    // Store refresh token
    await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken },
    });

    return {
      shop: {
        id: user.shop.id,
        name: user.shop.name,
        ownerName: user.shop.ownerName,
        assistantName: user.shop.assistantName,
        tier: user.shop.tier,
      },
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
      },
      accessToken,
      refreshToken,
    };
  }

  /**
   * Refresh access token
   */
  static async refreshToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const decoded = JWTUtil.verifyRefreshToken(refreshToken);

    if (!decoded) {
      throw new Error('Invalid refresh token');
    }

    const payload: ITokenPayload = {
      id: decoded.id,
      shopId: decoded.shopId,
      phone: decoded.phone,
      email: decoded.email,
      role: decoded.role,
      type: decoded.type,
    };

    const newAccessToken = JWTUtil.generateAccessToken(payload);
    const newRefreshToken = JWTUtil.generateRefreshToken(payload);

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    };
  }

  /**
   * Get current user/shop info
   */
  static async getMe(userId: string, type: 'shop' | 'user' | 'admin') {
    if (type === 'admin') {
      // Admin users are handled separately
      return { admin: true };
    }
    if (type === 'shop') {
      const shop = await prisma.shop.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          ownerName: true,
          ownerPhone: true,
          ownerEmail: true,
          assistantName: true,
          currency: true,
          timezone: true,
          address: true,
          logoUrl: true,
          tier: true,
          licenseExpiry: true,
          createdAt: true,
        },
      });

      if (!shop) {
        throw new Error('Shop not found');
      }

      return { shop, role: 'OWNER' };
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        shop: {
          select: {
            id: true,
            name: true,
            ownerName: true,
            assistantName: true,
            currency: true,
            timezone: true,
            tier: true,
          },
        },
      },
    });

    if (!user) {
      throw new Error('User not found');
    }

    return {
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        role: user.role,
        canDiscount: user.canDiscount,
        canVoid: user.canVoid,
        canViewReports: user.canViewReports,
        canManageStock: user.canManageStock,
      },
      shop: user.shop,
    };
  }
}
