/**
 * Test data factories — create real rows in the test DB via the same Prisma
 * client the services use. Each helper fills sensible, valid defaults so a test
 * only has to specify the fields it actually cares about.
 *
 * Uniqueness: Shop.ownerYeboidSub (@db.Uuid, @unique) and Shop.ownerPhone /
 * User.phone (@unique-ish) must not collide across rows created within a single
 * test, so we mint them from a monotonic counter. (`resetDb()` truncates between
 * tests; the counter simply never repeats within a run.)
 */
import { randomUUID } from 'crypto';
import { Prisma, UserRole } from '@prisma/client';
import { prisma } from './db';

let seq = 0;
const nextSeq = () => ++seq;

/** A deterministic-length E.164 phone unique per call. */
function uniquePhone(): string {
  return `+2687${String(nextSeq()).padStart(7, '0')}`;
}

export async function seedShop(over: Partial<Prisma.ShopUncheckedCreateInput> = {}) {
  return prisma.shop.create({
    data: {
      name: 'Test Shop',
      ownerYeboidSub: randomUUID(),
      ownerName: 'Test Owner',
      ownerPhone: uniquePhone(),
      // Money tests assume no VAT unless a test opts in.
      taxRate: 0,
      taxInclusive: false,
      ...over,
    },
  });
}

export async function seedUser(
  shopId: string,
  over: Partial<Prisma.UserUncheckedCreateInput> = {},
) {
  return prisma.user.create({
    data: {
      shopId,
      name: 'Cashier',
      phone: uniquePhone(),
      role: UserRole.CASHIER,
      ...over,
    },
  });
}

export async function seedProduct(
  shopId: string,
  over: Partial<Prisma.ProductUncheckedCreateInput> = {},
) {
  return prisma.product.create({
    data: {
      shopId,
      name: `Product ${nextSeq()}`,
      costPrice: 5,
      sellPrice: 10,
      quantity: 100,
      reorderAt: 10,
      trackStock: true,
      isActive: true,
      ...over,
    },
  });
}
