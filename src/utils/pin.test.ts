import { describe, it, expect } from 'vitest';
import bcrypt from 'bcrypt';
import { hashPin, verifyPin, isPinHashed, PIN_BCRYPT_ROUNDS } from './pin';

describe('pin util', () => {
  it('hashPin produces a bcrypt hash that is not the plaintext', async () => {
    const hash = await hashPin('1234');
    expect(hash).not.toBe('1234');
    expect(isPinHashed(hash)).toBe(true);
    // The cost factor we asked for is encoded in the hash ($2b$12$...).
    expect(hash).toMatch(new RegExp(`^\\$2[aby]\\$${PIN_BCRYPT_ROUNDS}\\$`));
  });

  it('isPinHashed distinguishes a hash from a plaintext PIN', () => {
    expect(isPinHashed('1234')).toBe(false);
    expect(isPinHashed('0000')).toBe(false);
    expect(isPinHashed('$2b$12$abcdefghijklmnopqrstuv')).toBe(true);
  });

  it('verifyPin matches a correct PIN against a bcrypt hash', async () => {
    const hash = await hashPin('4271');
    await expect(verifyPin('4271', hash)).resolves.toEqual({ valid: true, needsUpgrade: false });
    await expect(verifyPin('0000', hash)).resolves.toEqual({ valid: false, needsUpgrade: false });
  });

  it('verifyPin accepts a legacy plaintext PIN and flags it for upgrade', async () => {
    await expect(verifyPin('4271', '4271')).resolves.toEqual({ valid: true, needsUpgrade: true });
    await expect(verifyPin('9999', '4271')).resolves.toEqual({ valid: false, needsUpgrade: false });
  });

  it('a freshly hashed legacy PIN verifies with bcrypt', async () => {
    // Mirrors the lazy upgrade: plaintext verified, then rehashed.
    const upgraded = await hashPin('4271');
    await expect(bcrypt.compare('4271', upgraded)).resolves.toBe(true);
  });
});
