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
  },
});
