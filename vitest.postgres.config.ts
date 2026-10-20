import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Explicit opt-in: no fake, no production connection, no automatic DB provisioning.
if (
  !process.env.CREDIT_TEST_DATABASE_URL ||
  !/^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/credit_test(?:\?|$)/.test(
    process.env.CREDIT_TEST_DATABASE_URL,
  )
) {
  throw new Error(
    "CREDIT_TEST_DATABASE_URL must point to a disposable local credit_test database",
  );
}
process.env.DATABASE_URL = process.env.CREDIT_TEST_DATABASE_URL;
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["integration/**/*.test.ts"],
    testTimeout: 15000,
    env: {
      JWT_SECRET: "integration-only",
      JWT_REFRESH_SECRET: "integration-only",
    },
  },
});
