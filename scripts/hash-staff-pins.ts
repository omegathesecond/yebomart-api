/**
 * One-time migration: convert plaintext staff PINs to bcrypt hashes.
 *
 * Staff PINs were stored in `User.pin` as plaintext and compared with `!==`.
 * The login path now uses bcrypt (see utils/hash.ts), so the stored values have
 * to be hashed or every staff member is locked out.
 *
 * Idempotent: rows whose PIN is already a bcrypt hash ($2a$/$2b$/$2y$) are
 * skipped, so a re-run after a partial failure is safe.
 *
 * Run BEFORE (or together with) the deploy that ships the bcrypt login —
 * the two are a single cutover, and PIN login fails in the window between them.
 *
 *   DATABASE_URL='<url>' npx ts-node -r tsconfig-paths/register \
 *     scripts/hash-staff-pins.ts [--dry-run]
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { BCRYPT_ROUNDS } from '../src/utils/hash';

const prisma = new PrismaClient();

/** bcrypt hashes always carry a `$2<x>$<cost>$` prefix; plaintext PINs never do. */
const BCRYPT_PREFIX = /^\$2[aby]\$\d{2}\$/;

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const users = await prisma.user.findMany({
    where: { pin: { not: null } },
    select: { id: true, pin: true, shopId: true, name: true },
  });

  const alreadyHashed = users.filter((u) => BCRYPT_PREFIX.test(u.pin!));
  const toHash = users.filter((u) => !BCRYPT_PREFIX.test(u.pin!));

  console.log(`users with a PIN set : ${users.length}`);
  console.log(`already hashed       : ${alreadyHashed.length}`);
  console.log(`to hash              : ${toHash.length}`);

  // A plaintext PIN that isn't 4 digits means the column holds something we
  // didn't expect. Hashing it blindly would lock that person out with no way
  // to tell what the value had been, so stop and let a human look.
  const malformed = toHash.filter((u) => !/^\d{4}$/.test(u.pin!));
  if (malformed.length > 0) {
    console.error(
      `\nABORT: ${malformed.length} row(s) have a non-4-digit plaintext PIN ` +
        `(ids: ${malformed.map((u) => u.id).join(', ')}). Inspect before migrating.`,
    );
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    return;
  }

  let done = 0;
  for (const user of toHash) {
    await prisma.user.update({
      where: { id: user.id },
      data: { pin: await bcrypt.hash(user.pin!, BCRYPT_ROUNDS) },
    });
    done += 1;
  }

  // Re-read rather than trusting the loop: the whole point is that no plaintext
  // survives, and that's a property of the database, not of this process.
  const after = await prisma.user.findMany({
    where: { pin: { not: null } },
    select: { id: true, pin: true },
  });
  const stillPlaintext = after.filter((u) => !BCRYPT_PREFIX.test(u.pin!));

  console.log(`\nhashed ${done} PIN(s).`);
  console.log(`plaintext PINs remaining: ${stillPlaintext.length}`);
  if (stillPlaintext.length > 0) {
    console.error(`FAILED — ids: ${stillPlaintext.map((u) => u.id).join(', ')}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
