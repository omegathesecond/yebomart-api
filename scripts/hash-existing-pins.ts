/**
 * One-time data migration: bcrypt-hash any staff PINs still stored in
 * plaintext (User.pin). Run AFTER deploying the PIN-security changes and
 * applying the 20260623000000_add_pin_security schema migration.
 *
 * Usage:
 *   DATABASE_URL=... DIRECT_URL=... npx tsx scripts/hash-existing-pins.ts
 *
 * IDEMPOTENT: a PIN that is already a bcrypt hash is skipped, so re-running is
 * safe. (Login also lazily upgrades a plaintext PIN to a hash on first
 * successful sign-in, so this script is belt-and-suspenders, not the only path
 * off plaintext.)
 */

import { PrismaClient } from '@prisma/client';
import { hashPin, isPinHashed } from '../src/utils/pin';

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    where: { pin: { not: null } },
    select: { id: true, pin: true },
  });

  let hashed = 0;
  let skipped = 0;

  for (const user of users) {
    if (!user.pin || isPinHashed(user.pin)) {
      skipped++;
      continue;
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { pin: await hashPin(user.pin) },
    });
    hashed++;
  }

  console.log(
    `[hash-existing-pins] done — ${hashed} plaintext PIN(s) hashed, ${skipped} already hashed/skipped, ${users.length} total with a PIN.`,
  );
}

main()
  .catch((err) => {
    console.error('[hash-existing-pins] FAILED:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
