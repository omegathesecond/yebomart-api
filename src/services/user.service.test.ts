import { describe, it, expect, beforeEach } from 'vitest';
import { UserService } from './user.service';
import { resetDb, seedUser, table } from '../test/prismaFake';
import { isPinHashed, hashPin } from '../utils/pin';
import bcrypt from 'bcrypt';

beforeEach(() => {
  resetDb();
});

describe('UserService.create — PIN hashing', () => {
  it('stores the PIN as a bcrypt hash, never plaintext', async () => {
    await UserService.create({
      shopId: 'shop_1',
      name: 'Cashier',
      phone: '+26871111111',
      pin: '4271',
      role: 'CASHIER',
    });

    const row = table('user').find((u) => u.phone === '+26871111111')!;
    expect(row.pin).toBeTruthy();
    expect(row.pin).not.toBe('4271');
    expect(isPinHashed(row.pin)).toBe(true);
    await expect(bcrypt.compare('4271', row.pin)).resolves.toBe(true);
  });
});

describe('UserService.update — PIN hashing', () => {
  it('hashes a changed PIN before storing', async () => {
    const user = seedUser({ phone: '+26872222222', pin: await hashPin('0000') });

    await UserService.update(user.id, 'shop_1', { pin: '4271' });

    const row = table('user').find((u) => u.id === user.id)!;
    expect(isPinHashed(row.pin)).toBe(true);
    await expect(bcrypt.compare('4271', row.pin)).resolves.toBe(true);
    await expect(bcrypt.compare('0000', row.pin)).resolves.toBe(false);
  });

  it('leaves the existing PIN untouched when no new PIN is supplied', async () => {
    const original = await hashPin('4271');
    const user = seedUser({ phone: '+26873333333', pin: original });

    await UserService.update(user.id, 'shop_1', { name: 'Renamed' });

    const row = table('user').find((u) => u.id === user.id)!;
    expect(row.pin).toBe(original); // unchanged
    expect(row.name).toBe('Renamed');
  });
});
