import { expect } from 'vitest';
import { prisma } from '../src/config/prisma';

// Pause a real transaction after it owns its lock; verify the other backend
// actually blocks before releasing it. No timing-based assumption of overlap.
export async function ordered<T, U>(setHook: (hook: ((params: any) => Promise<void>) | undefined) => void, model: string, action: string, first: () => Promise<T>, second: () => Promise<U>) {
  let ready!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { ready = r; });
  const gate = new Promise<void>(r => { release = r; });
  setHook(async p => { if (p.model === model && p.action === action) { setHook(undefined); ready(); await gate; } });
  const a = first();
  await entered;
  const b = second();
  try {
    let waiting = false;
    for (const deadline = Date.now() + 3000; Date.now() < deadline;) {
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (Number(rows[0].n) > 0) { waiting = true; break; }
      await new Promise(r => setTimeout(r, 20));
    }
    expect(waiting).toBe(true);
  } finally { release(); setHook(undefined); }
  return Promise.all([a, b]);
}
