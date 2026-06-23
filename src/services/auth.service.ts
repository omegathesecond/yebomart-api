import { prisma } from '@config/prisma';
import { JWTUtil, ITokenPayload } from '@utils/jwt';
import { UserRole } from '@prisma/client';
import { getCountryMetadata } from '@config/countries';
import { hashPin, verifyPin } from '@utils/pin';
import { YeboIDClient, type YeboIDUserInfo } from './yeboid.client';

// PIN brute-force policy. After MAX_PIN_ATTEMPTS consecutive failures a staff
// account is locked for PIN_LOCK_MS; a successful login resets the counter.
// Tuned for a shared POS device: forgiving enough for honest typos, tight
// enough that brute-forcing 10k combinations is infeasible.
export const MAX_PIN_ATTEMPTS = 5;
export const PIN_LOCK_MS = 15 * 60 * 1000; // 15 minutes

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

interface LoginResult {
  shop: {
    id: string;
    name: string;
    ownerName: string;
    businessType: string;
    assistantName: string;
  };
  user?: {
    id: string;
    name: string;
    role: UserRole;
  };
  accessToken: string;
  refreshToken?: string;
}

interface YeboIDSignInResult {
  shop: LoginResult['shop'];
  isNewShop: boolean;
}

export class AuthService {
  /**
   * Sign in / sign up a shop OWNER via YeboID. Called from
   * POST /api/auth/yeboid/exchange after the frontend completes the OAuth
   * flow. The yeboidUserId is the verified `sub` from the access token; the
   * accessToken itself is passed through to /oauth/userinfo for profile
   * sync on first signup.
   *
   * If a Shop already exists for this yeboid_sub → return it (sign-in).
   * If not → create a new Shop using YeboID profile data (sign-up).
   *
   * Optional `signupOverrides` lets the frontend pass a custom shop name +
   * business type that YeboID doesn't know about (shop branding). Owner
   * identity fields (name/phone/email) ALWAYS come from YeboID.
   */
  static async signInWithYeboID(
    yeboidUserId: string,
    accessToken: string,
    signupOverrides?: { shopName?: string; businessType?: string; assistantName?: string },
  ): Promise<YeboIDSignInResult> {
    const existing = await prisma.shop.findUnique({ where: { ownerYeboidSub: yeboidUserId } });

    if (existing) {
      return {
        shop: {
          id: existing.id,
          name: existing.name,
          ownerName: existing.ownerName,
          businessType: existing.businessType,
          assistantName: existing.assistantName,
        },
        isNewShop: false,
      };
    }

    // First-time signup: fetch profile from YeboID, create Shop.
    let profile: YeboIDUserInfo;
    try {
      profile = await YeboIDClient.getUserInfo(accessToken);
    } catch (err) {
      throw new Error(
        `Failed to fetch YeboID profile for signup: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (profile.sub !== yeboidUserId) {
      throw new Error('YeboID profile sub does not match the validated token sub');
    }
    if (!profile.phone_number) {
      throw new Error('YeboID profile missing phone_number — cannot create shop without owner phone');
    }

    const ownerPhone = profile.phone_number;
    const resolvedCountry = getCountryFromPhone(ownerPhone) ?? profile.country ?? 'SZ';
    const country = getCountryMetadata(resolvedCountry);

    const shop = await prisma.shop.create({
      data: {
        ownerYeboidSub: yeboidUserId,
        name: signupOverrides?.shopName ?? `${profile.name ?? 'New'}'s Shop`,
        ownerName: profile.name ?? 'Owner',
        ownerPhone,
        ownerEmail: profile.email ?? null,
        businessType: signupOverrides?.businessType ?? 'general',
        assistantName: signupOverrides?.assistantName ?? 'Yebo',
        countryCode: resolvedCountry,
        phoneCountryCode: country.phoneCode,
        currencySymbol: country.currencySymbol,
        currency: country.currency,
        timezone: country.timezone,
      },
    });

    return {
      shop: {
        id: shop.id,
        name: shop.name,
        ownerName: shop.ownerName,
        businessType: shop.businessType,
        assistantName: shop.assistantName,
      },
      isNewShop: true,
    };
  }

  /**
   * Staff (cashier / manager) login with PIN. yebomart-internal — issues a
   * yebomart-signed JWT scoped to the staff member's shop. The shop OWNER
   * identity lives separately on YeboID.
   */
  static async loginUser(phone: string, pin: string): Promise<LoginResult> {
    // Normalize phone (default to Eswatini if no country prefix).
    let normalizedPhone = phone.replace(/\D/g, '');
    if (normalizedPhone.startsWith('0')) {
      normalizedPhone = '268' + normalizedPhone.slice(1);
    }
    if (!normalizedPhone.startsWith('268')) {
      normalizedPhone = '268' + normalizedPhone;
    }
    normalizedPhone = '+' + normalizedPhone;

    const user = await prisma.user.findFirst({
      where: {
        OR: [{ phone: normalizedPhone }, { phone }],
        isActive: true,
      },
      include: { shop: true },
    });

    // Unknown phone / no PIN set → generic failure (don't reveal which).
    if (!user || !user.pin) {
      throw new Error('Invalid phone or PIN');
    }

    // Temporary lockout after too many failed attempts. Checked before the PIN
    // is even verified so a locked account can't be probed further.
    if (user.pinLockedUntil && user.pinLockedUntil.getTime() > Date.now()) {
      const minutes = Math.ceil((user.pinLockedUntil.getTime() - Date.now()) / 60000);
      throw new Error(
        `Account locked due to too many failed PIN attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      );
    }

    const { valid, needsUpgrade } = await verifyPin(pin, user.pin);

    if (!valid) {
      // Count the failure and lock the account if it crosses the threshold.
      const attempts = (user.failedPinAttempts ?? 0) + 1;
      const locked = attempts >= MAX_PIN_ATTEMPTS;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedPinAttempts: locked ? 0 : attempts,
          pinLockedUntil: locked ? new Date(Date.now() + PIN_LOCK_MS) : null,
        },
      });
      if (locked) {
        throw new Error(
          `Account locked due to too many failed PIN attempts. Try again in ${Math.ceil(PIN_LOCK_MS / 60000)} minutes.`,
        );
      }
      throw new Error('Invalid phone or PIN');
    }

    // Success: reset the brute-force counters, stamp the login, and — for a
    // legacy plaintext PIN — upgrade it to a bcrypt hash so it is never stored
    // in plaintext again.
    await prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        failedPinAttempts: 0,
        pinLockedUntil: null,
        ...(needsUpgrade ? { pin: await hashPin(pin) } : {}),
      },
    });

    const payload: ITokenPayload = {
      id: user.id,
      shopId: user.shopId,
      phone: user.phone,
      role: user.role,
      type: 'user',
    };

    return {
      shop: {
        id: user.shop.id,
        name: user.shop.name,
        ownerName: user.shop.ownerName,
        businessType: user.shop.businessType,
        assistantName: user.shop.assistantName,
      },
      user: { id: user.id, name: user.name, role: user.role },
      accessToken: JWTUtil.generateAccessToken(payload),
    };
  }

  /**
   * Fetch the current authenticated entity's profile. Called by GET /api/auth/me.
   * Two paths:
   *   - YeboID-authed (shop owner): yeboidUserId is the lookup key.
   *   - Staff PIN (yebomart JWT): userId/shopId came from req.user.
   */
  static async getMeByYeboID(yeboidUserId: string) {
    const shop = await prisma.shop.findUnique({
      where: { ownerYeboidSub: yeboidUserId },
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
        countryCode: true,
        phoneCountryCode: true,
        currencySymbol: true,
        // Tax / VAT — needed by the POS to show/charge tax and print the VAT number.
        taxRate: true,
        taxInclusive: true,
        taxNumber: true,
        createdAt: true,
      },
    });
    if (!shop) throw new Error('Shop not found for this YeboID user');
    return { shop, role: 'OWNER' as const };
  }

  static async getMeByStaffToken(userId: string) {
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
          },
        },
      },
    });
    if (!user) throw new Error('Staff user not found');
    return {
      shop: user.shop,
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        canDiscount: user.canDiscount,
        canVoid: user.canVoid,
        canViewReports: user.canViewReports,
        canManageStock: user.canManageStock,
      },
    };
  }
}
