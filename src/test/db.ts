/**
 * Real-Postgres test harness for the money-critical service tests.
 *
 * WHY a real DB (and NOT a mocked/in-memory Prisma):
 *   The money tier lives inside `prisma.$transaction(...)` blocks — sale
 *   creation decrements stock + writes a StockLog atomically; cash-up,
 *   returns and report generation all lean on real aggregate/groupBy SQL and
 *   real unique constraints (e.g. @@unique([shopId, localId]) is what makes
 *   the offline-sync idempotency race-proof). A hand-rolled fake can only
 *   assert the behaviour we already believe is true; it can't catch a broken
 *   transaction, a bad SQL filter, or a constraint that didn't fire. So these
 *   tests run against a real, DISPOSABLE Postgres.
 *
 * HOW it stays hermetic & CI-safe:
 *   - The connection string comes from TEST_DATABASE_URL (vitest injects it as
 *     DATABASE_URL via `test.env` in vitest.config.ts). Locally it defaults to
 *     a throwaway `yebomart_test` database; in CI point it at a disposable
 *     Postgres container or the dev Neon DB.
 *   - `assertTestDatabase` refuses to run unless the target DB name looks like
 *     a test DB (or ALLOW_NONTEST_DB=1 is set) — a hard guard so a stray
 *     DATABASE_URL can never let `resetDb()`'s TRUNCATE wipe prod/dev data.
 *   - `globalSetup` runs `prisma db push` once to materialise the schema;
 *     every test truncates all tables in `beforeEach` for a clean slate.
 *
 * The exported `prisma` is the SAME @config/prisma singleton the services use
 * (resolved to src/config/prisma.ts + cached on globalThis), so assertions read
 * exactly what the code under test wrote. We import it by relative path so the
 * harness doesn't depend on the @config/* alias plugin being wired in every
 * vitest context.
 */
import { prisma } from '../config/prisma';

export { prisma };
export {
  DEFAULT_TEST_DATABASE_URL,
  resolveTestDatabaseUrl,
  assertTestDatabase,
} from './testEnv';

/**
 * Wipe every application table so each test starts from an empty DB. We query
 * the live table list (rather than hardcoding model names) so the harness
 * survives schema changes, then TRUNCATE ... CASCADE in one statement so FK
 * order doesn't matter.
 */
export async function resetDb(): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  if (rows.length === 0) return;

  const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
