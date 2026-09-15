import { prisma } from '@config/prisma';
import { JWTUtil, ITokenPayload } from '@utils/jwt';
import { UserRole } from '@prisma/client';
import { getCountryMetadata } from '@config/countries';
import { verifyPin, dummyPinHash } from '@utils/hash';
import { phoneCandidates } from '@utils/phone';

/**
 * Consecutive wrong PINs before a staff row is locked, and for how long.
 *
 * Five is forgiving enough for a mistyped PIN on a till keypad; fifteen minutes
 * is long enough to matter to a script and short enough that a cashier isn't
 * stranded for a shift. Together they cut the reachable guess rate from roughly
 * 9,600/day (the IP rate limiter alone) to about 480 — the difference between
 * walking a 4-digit space in a day and in three weeks.
 */
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_MINUTES = 15;
import { YeboIDClient, type YeboIDUserInfo } from './yeboid.client';

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

export interface ShopSummary {
  id: string;
  name: string;
  ownerName: string;
  businessType: string;
  assistantName: string;
  countryCode: string;
  currencySymbol: string;
}

export class AuthService {
  /**
   * Sign in / sign up a shop OWNER via YeboID. Called from
   * POST /api/auth/yeboid/exchange after the frontend completes the OAuth
   * flow. The yeboidUserId is the verified `sub` from the access token; the
   * accessToken itself is passed through to /oauth/userinfo for profile
   * sync on first signup.
   *
   * If a Shop already exists for this yeboid_sub → return it (sign-in). An
   * owner can have several shops (multi-shop) — exchange always resolves to
   * the OLDEST one, the same default auth.middleware.ts uses when no
   * X-Shop-Id header is sent, so this stays a stable "your primary shop"
   * result. Use GET /api/shops to list all of them and switch.
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
    const existing = await prisma.shop.findFirst({
      where: { ownerYeboidSub: yeboidUserId },
      orderBy: { createdAt: 'asc' },
    });

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
   * Count a failed PIN attempt against every row that was actually checked,
   * locking any that cross the threshold.
   *
   * Rows are counted together because the attacker is attacking the *number*,
   * not one shop's row — and in practice the candidate set is a single row, so
   * this is one UPDATE. A failure here must never block the login response:
   * the caller is already on its way to throwing "Invalid phone or PIN", and a
   * database hiccup while recording a throttle counter is not a reason to
   * change what the user is told.
   */
  private static async recordFailedPinAttempts(
    candidates: { id: string; failedPinAttempts: number }[],
    now: Date,
  ): Promise<void> {
    try {
      await Promise.all(
        candidates.map((candidate) => {
          const attempts = candidate.failedPinAttempts + 1;
          const locked = attempts >= MAX_PIN_ATTEMPTS;
          return prisma.user.update({
            where: { id: candidate.id },
            data: {
              // Reset the counter as the lock is applied, so the next window
              // starts from zero rather than locking again on the first miss.
              failedPinAttempts: locked ? 0 : attempts,
              pinLockedUntil: locked
                ? new Date(now.getTime() + PIN_LOCKOUT_MINUTES * 60_000)
                : undefined,
            },
          });
        }),
      );
    } catch (err) {
      console.error('[AuthService] could not record failed PIN attempt:', err);
    }
  }

  /**
   * Staff (cashier / manager) login with PIN. yebomart-internal — issues a
   * yebomart-signed JWT scoped to the staff member's shop. The shop OWNER
   * identity lives separately on YeboID.
   */
  static async loginUser(phone: string, pin: string): Promise<LoginResult> {
    // Every stored form the typed number could have. The login screen has no
    // shop selected, so the country is unknown at this point — see
    // utils/phone.ts for why offering all of them is safe.
    const candidatePhones = phoneCandidates(phone);

    // Every active staff row matching the phone, not just the first one.
    // `User` is unique on [shopId, phone], so the SAME phone legitimately
    // exists in several shops — a cashier who works two jobs. `findFirst`
    // returned an arbitrary one of those rows, which meant the login either
    // signed the person into the wrong tenant or refused them because the
    // arbitrary row's PIN wasn't theirs. Which row you got was up to the
    // query planner.
    const allCandidates = await prisma.user.findMany({
      where: {
        phone: { in: candidatePhones },
        isActive: true,
      },
      include: { shop: true },
    });

    // Rows still inside their lockout window are not checked at all — that is
    // the point of the throttle. An expired lockout is simply ignored; the
    // counter is cleared on the next write rather than in a read path.
    const now = new Date();
    const lockedOut = allCandidates.filter(
      (c) => c.pinLockedUntil !== null && c.pinLockedUntil > now,
    );
    const candidates = allCandidates.filter((c) => !lockedOut.includes(c));

    if (allCandidates.length > 0 && candidates.length === 0) {
      // Every row for this number is locked. Say so plainly: a cashier who
      // fat-fingered their PIN five times needs to know why the till won't let
      // them in, and "Invalid phone or PIN" would send them to the owner with
      // a working PIN and no explanation. This does confirm the number is
      // registered — an accepted trade, because the alternative strands staff
      // mid-shift with a misleading error.
      const until = lockedOut.reduce<Date>(
        (soonest, c) => (c.pinLockedUntil! < soonest ? c.pinLockedUntil! : soonest),
        lockedOut[0].pinLockedUntil!,
      );
      const minutes = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60000));
      throw new Error(
        `Too many incorrect PIN attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      );
    }

    // Check the PIN against every candidate. The PIN is what disambiguates
    // the shop: two rows share a phone but normally not a PIN, so exactly one
    // matches and that is the shop the person meant.
    const matches = [];
    for (const candidate of candidates) {
      // Always run a compare, even for a row with no PIN set, so the work done
      // doesn't reveal how many rows exist or which of them are usable.
      const hash = candidate.pin ?? (await dummyPinHash());
      const ok = await verifyPin(pin, hash);
      if (ok && candidate.pin) matches.push(candidate);
    }

    if (matches.length === 0) {
      // Burn the same CPU for an unknown phone as for a known one — otherwise
      // "no such phone" returns in ~1ms and "wrong PIN" in ~300ms, which is a
      // free oracle for which staff numbers are registered.
      if (candidates.length === 0) await verifyPin(pin, await dummyPinHash());
      await AuthService.recordFailedPinAttempts(candidates, now);
      throw new Error('Invalid phone or PIN');
    }

    if (matches.length > 1) {
      // Same phone AND same PIN in more than one shop. There is no way to tell
      // which shop was intended, and picking one would silently sign the person
      // into another tenant's data. Refuse and make a human break the tie.
      throw new Error(
        'This phone and PIN match more than one shop. Ask the shop owner to change one of the PINs.',
      );
    }

    const user = matches[0];

    // Success clears the throttle for this row — the counter tracks
    // *consecutive* failures, so one correct PIN resets it.
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: now, failedPinAttempts: 0, pinLockedUntil: null },
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
   * List every shop the given YeboID owner has, oldest first (the same order
   * auth.middleware.ts uses to pick the default active shop). Backs
   * GET /api/shops — the ShopSwitcher's source of truth.
   */
  static async listShopsForOwner(yeboidUserId: string): Promise<ShopSummary[]> {
    const shops = await prisma.shop.findMany({
      where: { ownerYeboidSub: yeboidUserId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        ownerName: true,
        businessType: true,
        assistantName: true,
        countryCode: true,
        currencySymbol: true,
      },
    });
    if (shops.length === 0) throw new Error('No shop found for this YeboID account');
    return shops;
  }

  /**
   * Create an ADDITIONAL shop under an owner's existing YeboID identity.
   * Requires the owner to already have at least one shop — this is not a
   * signup path (that's signInWithYeboID's create branch). Identity fields
   * (owner name/phone/email) are carried over from the existing shop rather
   * than re-fetched, since they mirror the same YeboID profile either way.
   */
  static async createAdditionalShop(
    yeboidUserId: string,
    overrides: { shopName: string; businessType?: string; assistantName?: string },
  ): Promise<ShopSummary> {
    const existing = await prisma.shop.findFirst({
      where: { ownerYeboidSub: yeboidUserId },
      orderBy: { createdAt: 'asc' },
    });
    if (!existing) {
      throw new Error(
        'No existing shop found for this YeboID account. Sign up first via POST /api/auth/yeboid/exchange.',
      );
    }

    const shop = await prisma.shop.create({
      data: {
        ownerYeboidSub: yeboidUserId,
        name: overrides.shopName,
        ownerName: existing.ownerName,
        ownerPhone: existing.ownerPhone,
        ownerEmail: existing.ownerEmail,
        businessType: overrides.businessType ?? 'general',
        assistantName: overrides.assistantName ?? 'Yebo',
        countryCode: existing.countryCode,
        phoneCountryCode: existing.phoneCountryCode,
        currencySymbol: existing.currencySymbol,
        currency: existing.currency,
        timezone: existing.timezone,
      },
    });

    return {
      id: shop.id,
      name: shop.name,
      ownerName: shop.ownerName,
      businessType: shop.businessType,
      assistantName: shop.assistantName,
      countryCode: shop.countryCode,
      currencySymbol: shop.currencySymbol,
    };
  }

  /**
   * Fetch the ACTIVE shop's profile for GET /api/auth/me. Two paths:
   *   - YeboID-authed (shop owner): shopId is auth.middleware.ts's resolved
   *     active shop (X-Shop-Id header, or the owner's oldest shop).
   *   - Staff PIN (yebomart JWT): userId/shopId came from req.user.
   */
  static async getMeByYeboID(shopId: string) {
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
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
