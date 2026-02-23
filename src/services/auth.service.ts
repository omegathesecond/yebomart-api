import bcrypt from 'bcrypt';
import { prisma } from '@config/prisma';
import { JWTUtil, ITokenPayload } from '@utils/jwt';
import { UserRole } from '@prisma/client';
import { COUNTRY_PRICING } from '@config/pricing';

const SALT_ROUNDS = 12;

// Map phone prefixes to country codes (ordered longest first for accurate matching)
const PHONE_TO_COUNTRY: [string, string][] = [
  ['+268', 'SZ'],   // Eswatini
  ['+27', 'ZA'],    // South Africa
  ['+254', 'KE'],   // Kenya
  ['+234', 'NG'],   // Nigeria
  ['+233', 'GH'],   // Ghana
  ['+255', 'TZ'],   // Tanzania
  ['+256', 'UG'],   // Uganda
  ['+250', 'RW'],   // Rwanda
  ['+251', 'ET'],   // Ethiopia
  ['+225', 'CI'],   // Ivory Coast
  ['+221', 'SN'],   // Senegal
  ['+260', 'ZM'],   // Zambia
  ['+263', 'ZW'],   // Zimbabwe
  ['+267', 'BW'],   // Botswana
  ['+258', 'MZ'],   // Mozambique
  ['+237', 'CM'],   // Cameroon
  ['+243', 'CD'],   // DR Congo
  ['+265', 'MW'],   // Malawi
  ['+266', 'LS'],   // Lesotho
  ['+264', 'NA'],   // Namibia
];

function getCountryFromPhone(phone: string): string | null {
  for (const [prefix, code] of PHONE_TO_COUNTRY) {
    if (phone.startsWith(prefix)) return code;
  }
  return null;
}

interface RegisterShopInput {
  name: string;
  ownerName: string;
  ownerPhone: string;
  ownerEmail?: string;
  password: string;
  assistantName?: string;
  businessType?: string;
  // Country & Localization
  countryCode?: string;
  phoneCountryCode?: string;
  currencySymbol?: string;
}

interface LoginResult {
  shop: {
    id: string;
    name: string;
    ownerName: string;
    businessType: string;
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

    // Derive country from phone number (most reliable)
    const phoneCountry = getCountryFromPhone(input.ownerPhone);
    const resolvedCountry = phoneCountry || input.countryCode || 'SZ';
    const countryData = COUNTRY_PRICING[resolvedCountry];

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
        // Country & Localization — derive all fields from countryCode
        countryCode: resolvedCountry,
        phoneCountryCode: input.phoneCountryCode || countryData?.phoneCode || '+268',
        currencySymbol: countryData?.currencySymbol || input.currencySymbol || 'E',
        currency: countryData?.currency || 'SZL',
        timezone: countryData?.timezone || 'Africa/Mbabane',
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
        businessType: shop.businessType,
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
        businessType: shop.businessType,
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
        businessType: user.shop.businessType,
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
          businessType: true,
          assistantName: true,
          currency: true,
          timezone: true,
          address: true,
          logoUrl: true,
          tier: true,
          licenseExpiry: true,
          createdAt: true,
          // Country & Localization
          countryCode: true,
          phoneCountryCode: true,
          currencySymbol: true,
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
            businessType: true,
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
