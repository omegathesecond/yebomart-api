import v8 from 'v8';

import { prisma } from '@config/prisma';

interface HealthReport {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  checks: {
    database: { status: 'up' | 'down'; latency?: number };
    memory: { status: 'ok' | 'warning' | 'critical'; usage: number };
  };
}

export const getHealthReport = async (options?: { includeExternal?: boolean }): Promise<HealthReport> => {
  const timestamp = new Date().toISOString();
  const uptime = process.uptime();

  // Check database
  let dbStatus: 'up' | 'down' = 'down';
  let dbLatency: number | undefined;

  try {
    const start = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    dbLatency = Date.now() - start;
    dbStatus = 'up';
  } catch (error) {
    console.error('Database health check failed:', error);
  }

  // Check memory against the heap CEILING, not the currently-allocated heap.
  //
  // This used to be heapUsed/heapTotal, which is not a health signal at all:
  // V8 sizes heapTotal to fit what is live, so a healthy, efficient process
  // sits at 85-95% by design, and a LOW number just means V8 grew the heap
  // after a spike. That made prod report "critical" and serve 503 on /health
  // continuously while the database was up and every request succeeded — and
  // it was immune to raising the container memory, because both halves of the
  // ratio scale together.
  //
  // heap_size_limit is the real ceiling V8 will not allocate past (it tracks
  // --max-old-space-size / the container limit), so heapUsed against it is the
  // fraction of headroom actually consumed, and it genuinely climbs before an
  // out-of-memory kill.
  const memUsage = process.memoryUsage();
  const heapLimitBytes = v8.getHeapStatistics().heap_size_limit;
  const memoryPercentage = (memUsage.heapUsed / heapLimitBytes) * 100;

  let memoryStatus: 'ok' | 'warning' | 'critical' = 'ok';
  if (memoryPercentage > 90) {
    memoryStatus = 'critical';
  } else if (memoryPercentage > 75) {
    memoryStatus = 'warning';
  }

  // Determine overall status
  let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
  if (dbStatus === 'down' || memoryStatus === 'critical') {
    status = 'unhealthy';
  } else if (memoryStatus === 'warning') {
    status = 'degraded';
  }

  return {
    status,
    timestamp,
    uptime,
    checks: {
      database: { status: dbStatus, latency: dbLatency },
      memory: { status: memoryStatus, usage: Math.round(memoryPercentage) },
    },
  };
};

export const getReadinessStatus = async (): Promise<{ ready: boolean; reason?: string }> => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ready: true };
  } catch (error) {
    return { ready: false, reason: 'Database not available' };
  }
};

export const getLivenessStatus = (): { alive: boolean } => {
  return { alive: true };
};
