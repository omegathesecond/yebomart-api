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

  // Check memory
  const memUsage = process.memoryUsage();
  const heapUsedMB = memUsage.heapUsed / 1024 / 1024;
  const heapTotalMB = memUsage.heapTotal / 1024 / 1024;
  const memoryPercentage = (heapUsedMB / heapTotalMB) * 100;

  let memoryStatus: 'ok' | 'warning' | 'critical' = 'ok';
  if (memoryPercentage > 90) {
    memoryStatus = 'critical';
  } else if (memoryPercentage > 70) {
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
