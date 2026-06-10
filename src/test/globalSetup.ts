/**
 * Vitest globalSetup — runs ONCE before the whole suite, in the main vitest
 * process (not a worker). It materialises the schema on the disposable test DB
 * with `prisma db push` (no migration history needed for a throwaway DB) so the
 * service tests have real tables/constraints to run against.
 *
 * Imports only the prisma-free helpers from ./testEnv so loading this file in
 * the main process never constructs a PrismaClient or needs path aliases.
 */
import { execSync } from 'child_process';
import { resolveTestDatabaseUrl, assertTestDatabase } from './testEnv';

export default async function setup(): Promise<void> {
  const databaseUrl = resolveTestDatabaseUrl();
  assertTestDatabase(databaseUrl);

  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });
}
