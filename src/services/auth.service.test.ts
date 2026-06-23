import { describe, it, expect, beforeEach } from 'vitest';
import { AuthService, MAX_PIN_ATTEMPTS } from './auth.service';
import { resetDb, seedShop, seedUser, table } from '../test/prismaFake';
import { hashPin, isPinHashed } from '../utils/pin';

const PHONE = '+26878422613';

beforeEach(() => {
  resetDb();
});

async function seedStaff(pin: string, partial: Record<string, any> = {}) {
  seedShop(); // shop_1
  return seedUser({ phone: PHONE, pin, isActive: true, ...partial });
}

describe('AuthService.loginUser — hashing', () => {
  it('authenticates a correct PIN against a bcrypt hash and resets counters', async () => {
    const user = await seedStaff(await hashPin('4271'), { failedPinAttempts: 3 });

    const result = await AuthService.loginUser(PHONE, '4271');

    expect(result.accessToken).toBeTruthy();
    expect(result.user?.id).toBe(user.id);
    const row = table('user').find((u) => u.id === user.id)!;
    expect(row.failedPinAttempts).toBe(0);
    expect(row.pinLockedUntil).toBeNull();
    expect(row.lastLoginAt).toBeInstanceOf(Date);
  });

  it('rejects a wrong PIN and never matches the plaintext of a hash', async () => {
    await seedStaff(await hashPin('4271'));
    await expect(AuthService.loginUser(PHONE, '0000')).rejects.toThrow('Invalid phone or PIN');
  });

  it('rejects unknown phone with a generic error', async () => {
    await seedStaff(await hashPin('4271'));
    await expect(AuthService.loginUser('+26800000000', '4271')).rejects.toThrow('Invalid phone or PIN');
  });
});

describe('AuthService.loginUser — lockout', () => {
  it('counts failed attempts and locks the account after the threshold', async () => {
    const user = await seedStaff(await hashPin('4271'));

    for (let i = 1; i <= MAX_PIN_ATTEMPTS; i++) {
      const attempt = AuthService.loginUser(PHONE, '0000');
      if (i < MAX_PIN_ATTEMPTS) {
        await expect(attempt).rejects.toThrow('Invalid phone or PIN');
        const row = table('user').find((u) => u.id === user.id)!;
        expect(row.failedPinAttempts).toBe(i);
        expect(row.pinLockedUntil).toBeNull();
      } else {
        await expect(attempt).rejects.toThrow(/Account locked/);
        const row = table('user').find((u) => u.id === user.id)!;
        expect(row.pinLockedUntil).toBeInstanceOf(Date);
        expect(row.pinLockedUntil.getTime()).toBeGreaterThan(Date.now());
      }
    }
  });

  it('refuses even a CORRECT PIN while the account is locked', async () => {
    const user = await seedStaff(await hashPin('4271'), {
      pinLockedUntil: new Date(Date.now() + 5 * 60 * 1000),
    });
    await expect(AuthService.loginUser(PHONE, '4271')).rejects.toThrow(/Account locked/);
    // No login was stamped.
    const row = table('user').find((u) => u.id === user.id)!;
    expect(row.lastLoginAt).toBeUndefined();
  });

  it('allows login once a stale lock has expired and then clears it', async () => {
    const user = await seedStaff(await hashPin('4271'), {
      failedPinAttempts: MAX_PIN_ATTEMPTS,
      pinLockedUntil: new Date(Date.now() - 1000), // already expired
    });
    const result = await AuthService.loginUser(PHONE, '4271');
    expect(result.accessToken).toBeTruthy();
    const row = table('user').find((u) => u.id === user.id)!;
    expect(row.failedPinAttempts).toBe(0);
    expect(row.pinLockedUntil).toBeNull();
  });
});

describe('AuthService.loginUser — legacy plaintext upgrade', () => {
  it('authenticates a legacy plaintext PIN and rehashes it to bcrypt', async () => {
    const user = await seedStaff('4271'); // stored in plaintext (pre-migration)
    expect(isPinHashed(table('user').find((u) => u.id === user.id)!.pin)).toBe(false);

    const result = await AuthService.loginUser(PHONE, '4271');
    expect(result.accessToken).toBeTruthy();

    const row = table('user').find((u) => u.id === user.id)!;
    expect(isPinHashed(row.pin)).toBe(true); // upgraded on success
    expect(row.pin).not.toBe('4271');
  });

  it('does not upgrade or stamp anything when a legacy plaintext PIN is wrong', async () => {
    const user = await seedStaff('4271');
    await expect(AuthService.loginUser(PHONE, '9999')).rejects.toThrow('Invalid phone or PIN');
    const row = table('user').find((u) => u.id === user.id)!;
    expect(row.pin).toBe('4271'); // untouched
    expect(row.failedPinAttempts).toBe(1);
  });
});
