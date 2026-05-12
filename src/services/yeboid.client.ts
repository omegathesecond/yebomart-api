/**
 * Thin client for YeboID's OAuth endpoints.
 *
 * Used by /api/auth/yeboid/exchange to fetch the user's profile (name, phone,
 * email) at first sign-up, so we can populate Shop.ownerName / ownerPhone /
 * ownerEmail without making the user re-enter what YeboID already knows.
 *
 * Per the yeboid-implementation skill: profile claims are NOT in the access
 * token. We must call /oauth/userinfo once at signup to get them.
 */

const YEBOID_BASE_URL = process.env.YEBOID_BASE_URL ?? 'https://api.yeboid.com';

export interface YeboIDUserInfo {
  sub: string;
  // profile scope
  name?: string;
  picture?: string;
  // phone scope
  phone_number?: string;
  phone_number_verified?: boolean;
  // email scope
  email?: string;
  email_verified?: boolean;
  // kyc scope (if requested)
  country?: string;
  currency?: string;
  currency_symbol?: string;
  kyc_status?: string;
}

export class YeboIDClient {
  /**
   * Fetch the user's profile from YeboID. Requires a valid access_token with
   * `profile phone email` scopes (request these at OAuth authorize time).
   *
   * Caller passes the raw bearer token (the same one yebomart validated).
   * Throws on non-2xx.
   */
  static async getUserInfo(accessToken: string): Promise<YeboIDUserInfo> {
    const res = await fetch(`${YEBOID_BASE_URL}/oauth/userinfo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`YeboID /oauth/userinfo ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as YeboIDUserInfo;
  }
}
