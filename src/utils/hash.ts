import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

/**
 * bcrypt cost factor for every secret yebomart stores. 12 matches the admin
 * password hashes already in the database (admin.controller.ts, prisma/seed.ts)
 * so one constant now covers both and a future change moves them together.
 */
export const BCRYPT_ROUNDS = 12;

/**
 * Hash a staff PIN for storage.
 *
 * A 4-digit PIN has only 10,000 possible values, so the cost factor is doing
 * nearly all of the work: at rounds 12 an attacker holding the hash needs on
 * the order of an hour of compute to exhaust the space, versus *zero* when
 * PINs were stored as plaintext — which is what this replaces. A PIN stays a
 * device-convenience credential behind the shop boundary, not a strong secret;
 * the online guessing rate is bounded by `authLimiter`, and per-account
 * lockout is still a gap worth closing separately.
 */
export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, BCRYPT_ROUNDS);
}

/** Verify a PIN against a stored hash. bcrypt.compare is itself constant-time. */
export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pin, hash);
}

let dummyHash: string | null = null;

/**
 * A valid bcrypt hash of a value nobody knows, so a login attempt for a phone
 * that doesn't exist burns the same CPU as one that does. Without it, "no such
 * phone" returns in about a millisecond while "wrong PIN" takes ~300ms, which
 * hands an attacker a free oracle for which staff numbers are registered.
 *
 * Computed on first use rather than at import so it doesn't add ~300ms to every
 * Cloud Run cold start, including the many that never serve a PIN login.
 */
export async function dummyPinHash(): Promise<string> {
  if (!dummyHash) {
    dummyHash = await bcrypt.hash(randomBytes(16).toString('hex'), BCRYPT_ROUNDS);
  }
  return dummyHash;
}
