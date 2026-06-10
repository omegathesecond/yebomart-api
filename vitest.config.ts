import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Money-critical service tests run against a REAL, disposable Postgres (NOT a
// mocked Prisma) so the prisma.$transaction blocks, aggregate/groupBy SQL and
// unique constraints are genuinely exercised. See src/test/db.ts for the why.
//
// The connection string comes from TEST_DATABASE_URL (defaulting to a local
// throwaway `yebomart_test` DB) and is injected as DATABASE_URL via test.env so
// the @config/prisma singleton — and return.controller's own PrismaClient —
// both connect to the test DB the instant they're imported.
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://yebomart_test:yebomart_test@127.0.0.1:5432/yebomart_test';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // One-time schema push to the test DB.
    globalSetup: ['src/test/globalSetup.ts'],
    // Per-worker guard + connection teardown.
    setupFiles: ['src/test/setup.ts'],
    clearMocks: true,
    // The whole suite shares one Postgres; run files serially in a single
    // worker so per-test TRUNCATEs never race across files.
    fileParallelism: false,
    poolOptions: { forks: { singleFork: true } },
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      NODE_ENV: 'test',
    },
  },
});
