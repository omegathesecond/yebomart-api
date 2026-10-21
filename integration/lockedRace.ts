import { expect } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/config/prisma";

// Force both real database requests to overlap: opens wait on a table lock,
// closes on the session row. A plain Promise.all would not prove concurrency.
export async function race<T>(
  lock: Prisma.Sql,
  operations: (() => Promise<T>)[],
) {
  let ready!: () => void, release!: () => void;
  const locked = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw(lock);
      ready();
      await gate;
    },
    { timeout: 12000 },
  );
  await locked;
  const pending = Promise.allSettled(operations.map((op) => op()));
  try {
    let waiting = 0;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const rows = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()
        AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
      waiting = Number(rows[0].count);
      if (waiting >= operations.length) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(waiting).toBeGreaterThanOrEqual(operations.length);
  } finally {
    release();
    await blocker;
  }
  return pending;
}
