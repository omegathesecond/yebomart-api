import bcrypt from 'bcrypt';

/**
 * Staff PIN hashing. Staff (cashier/manager) authenticate with a 4-digit PIN
 * (see User.pin). PINs are bcrypt-hashed at set-time and verified via
 * bcrypt.compare — never stored or compared in plaintext, so a DB leak does
 * not expose every till PIN.
 *
 * Shared by auth.service (verify on login) and user.service (set on
 * create/update) so there is exactly one hashing path and no code can
 * accidentally persist a raw PIN.
 *
 * Cost factor matches the admin password hashing (admin.controller.ts) for
 * consistency across the codebase.
 */
export const PIN_BCRYPT_ROUNDS = 12;

// bcrypt hashes always start with $2a$ / $2b$ / $2y$ followed by the cost and
// a 22-char salt. Used to tell an already-hashed PIN from a legacy plaintext
// one during the lazy upgrade-on-login migration.
const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$/;

/** True if `value` is already a bcrypt hash (vs. a legacy plaintext PIN). */
export function isPinHashed(value: string): boolean {
  return BCRYPT_HASH_RE.test(value);
}

/** Hash a raw PIN for storage. */
export function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, PIN_BCRYPT_ROUNDS);
}

/**
 * Verify a raw PIN against a stored value. Handles both hashed PINs
 * (bcrypt.compare) and legacy plaintext PINs (constant-string compare) so a
 * user whose PIN hasn't been backfilled yet can still authenticate. The caller
 * (auth.service) is responsible for upgrading a verified plaintext PIN to a
 * hash. Returns whether the PIN matched and whether the stored value was a
 * legacy plaintext that should be rehashed.
 */
export async function verifyPin(
  pin: string,
  stored: string,
): Promise<{ valid: boolean; needsUpgrade: boolean }> {
  if (isPinHashed(stored)) {
    return { valid: await bcrypt.compare(pin, stored), needsUpgrade: false };
  }
  // Legacy plaintext PIN — compare directly. If it matches the caller upgrades
  // it to a hash so it is never stored in plaintext again.
  const valid = stored === pin;
  return { valid, needsUpgrade: valid };
}
