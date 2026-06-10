/**
 * Vitest setupFiles — runs in each worker before its test files are imported.
 * DATABASE_URL/NODE_ENV are already injected by `test.env` in vitest.config.ts
 * (so the @config/prisma singleton connects to the test DB the moment a service
 * imports it). Here we just re-assert the safety guard and ensure the Prisma
 * connection is torn down so the worker exits cleanly.
 */
import { afterAll } from 'vitest';
import { prisma } from './db';
import { assertTestDatabase } from './testEnv';

assertTestDatabase(process.env.DATABASE_URL);

afterAll(async () => {
  await prisma.$disconnect();
});
