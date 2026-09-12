import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { resolve } from 'path';

// Tests run against an in-memory Prisma fake — no DB, no network, never Neon.
// We redirect the `@config/prisma` import to that fake at resolve time so the
// services under test transparently use it (more robust than per-file
// vi.mock hoisting with path aliases).
export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      '@config/prisma': resolve(__dirname, 'src/test/prismaFake.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    clearMocks: true,
    // utils/jwt.ts requires its signing secrets at module load and throws
    // without them — deliberately, so a missing secret can never silently fall
    // back to a guessable default in production. Tests therefore have to supply
    // them. These are throwaway values that exist only in this process; the
    // real ones come from Secret Manager. Do NOT "fix" a failing test by adding
    // a default back into jwt.ts — that reopens the forge-token hole.
    env: {
      JWT_SECRET: 'test-only-jwt-secret-not-used-anywhere-real-0000000000',
      JWT_REFRESH_SECRET: 'test-only-refresh-secret-not-used-anywhere-real-000',
    },
  },
});
