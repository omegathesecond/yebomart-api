import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'http';

// Keep the production app and rate limiter, replacing business routes with a
// read-only probe so these requests never access a database or external API.
vi.mock('./routes/index', async () => {
  const { Router } = await import('express');
  const router = Router();
  router.get('/proxy-probe', (req, res) => res.json({ ip: req.ip }));
  return { default: router };
});

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function start(cloudRun: boolean) {
  vi.resetModules();
  vi.stubEnv('K_SERVICE', cloudRun ? 'yebomart-api-prod' : '');
  const { default: app } = await import('./app');
  server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  const { port } = server.address() as { port: number };
  return async (forwardedFor?: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/proxy-probe`, {
      headers: forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {},
    });
    expect(response.status).toBe(200);
    return {
      ip: (await response.json()).ip,
      remaining: Number(response.headers.get('ratelimit-remaining')),
    };
  };
}

describe('Cloud Run client identity and API rate limiting', () => {
  it('isolates clients and ignores forged prefixes instead of sharing the proxy bucket', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const request = await start(true);
    const first = await request('192.0.2.10');
    const second = await request('198.51.100.20');
    const forged = await request('203.0.113.30, 192.0.2.10');
    expect(first).toEqual({ ip: '192.0.2.10', remaining: 9999 });
    expect(second).toEqual({ ip: '198.51.100.20', remaining: 9999 });
    expect(forged).toEqual({ ip: '192.0.2.10', remaining: 9998 });
    expect(error).not.toHaveBeenCalled();
  });

  it('uses the socket address without a forwarding header', async () => {
    const request = await start(true);
    expect((await request()).ip).toBe('127.0.0.1');
  });

  it('does not trust caller headers outside the Cloud Run ingress', async () => {
    const request = await start(false);
    // Health checks/local callers need no forwarding header.
    expect((await request()).ip).toBe('127.0.0.1');
    const { default: app } = await import('./app');
    expect(app.get('trust proxy')).toBe(false);
  });
});
