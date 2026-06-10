/**
 * Pure test-environment helpers — NO Prisma import, so they're safe to load
 * from vitest's globalSetup (which runs in the main process before any worker /
 * path-alias plumbing is in play).
 */

/**
 * The default local test database. A disposable Postgres role+db created just
 * for the suite — never the dev/prod Neon DB.
 */
export const DEFAULT_TEST_DATABASE_URL =
  'postgresql://yebomart_test:yebomart_test@127.0.0.1:5432/yebomart_test';

export function resolveTestDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;
}

/**
 * Hard safety rail. The harness TRUNCATEs every table, so refuse outright
 * unless the database name clearly identifies a test DB. Override only with an
 * explicit ALLOW_NONTEST_DB=1 (e.g. an ephemeral CI Postgres named otherwise).
 */
export function assertTestDatabase(url: string | undefined): void {
  if (!url) {
    throw new Error(
      'No DATABASE_URL set for tests. Set TEST_DATABASE_URL to a disposable Postgres.',
    );
  }

  let dbName = '';
  try {
    dbName = new URL(url).pathname.replace(/^\//, '');
  } catch {
    throw new Error(`DATABASE_URL is not a valid URL: ${url}`);
  }

  const looksLikeTest = /test/i.test(dbName);
  if (!looksLikeTest && process.env.ALLOW_NONTEST_DB !== '1') {
    throw new Error(
      `Refusing to run destructive tests against database "${dbName}". ` +
        'Point TEST_DATABASE_URL at a disposable *test* DB, or set ' +
        'ALLOW_NONTEST_DB=1 if you are certain this DB is disposable.',
    );
  }
}
