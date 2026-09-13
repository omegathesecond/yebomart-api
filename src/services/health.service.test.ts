import { describe, it, expect, vi } from 'vitest';

vi.mock('@yebo/mcp-server', () => ({
  JwksValidator: vi.fn().mockImplementation(() => ({ verify: vi.fn() })),
  extractBearerToken: vi.fn(),
}));

import { getHealthReport } from './health.service';

describe('getHealthReport — memory is measured against the heap ceiling', () => {
  it('does not report a healthy process as critical', async () => {
    // The regression this guards: memory used to be heapUsed/heapTotal, which
    // V8 keeps at 85-95% by design, so a perfectly healthy process reported
    // "critical" and /health served 503 forever. Measured against
    // heap_size_limit, an idle test process sits near zero.
    const report = await getHealthReport();

    expect(report.checks.memory.status).toBe('ok');
    expect(report.checks.memory.usage).toBeLessThan(75);
  });

  it('reports memory usage as a sane percentage', async () => {
    const report = await getHealthReport();
    expect(report.checks.memory.usage).toBeGreaterThanOrEqual(0);
    expect(report.checks.memory.usage).toBeLessThanOrEqual(100);
  });

  it('is not unhealthy on memory alone when the database is reachable', async () => {
    const report = await getHealthReport();
    // The fake prisma answers SELECT 1, so database is up; status must not be
    // "unhealthy", which is what drives the 503.
    expect(report.status).not.toBe('unhealthy');
  });
});
