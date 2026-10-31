import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'http';

const reachedRoute = vi.fn();
vi.mock('./routes/index', async () => {
  const { Router } = await import('express');
  const router = Router();
  router.all('/cors-probe', (_req, res) => {
    reachedRoute();
    res.json({ success: true });
  });
  return { default: router };
});
let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
async function request(origin?: string, method = 'GET', configuredOrigins?: string) {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'production');
  if (configuredOrigins !== undefined) vi.stubEnv('ALLOWED_ORIGINS', configuredOrigins);
  const { default: app } = await import('./app');
  server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  const { port } = server.address() as { port: number };
  return fetch(`http://127.0.0.1:${port}/api/cors-probe`, {
    method,
    headers: origin ? { Origin: origin, 'Access-Control-Request-Method': 'POST' } : {},
  });
}
describe('CORS policy at the production app boundary', () => {
  it.each(['GET', 'OPTIONS', 'POST'])('rejects an untrusted %s before routes without reporting a server error', async method => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await request('https://untrusted.invalid', method);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, message: 'Not allowed by CORS' });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(reachedRoute).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('CORS origin rejected');
  });
  it.each(['https://app.yebomart.com', 'https://admin.yebomart.com', 'https://yebomart.com'])('retains the approved journey from %s', async origin => {
    const response = await request(origin);
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(reachedRoute).toHaveBeenCalledOnce();
  });
  it('retains approved preflight without invoking a business route', async () => {
    const response = await request('https://app.yebomart.com', 'OPTIONS');
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    expect(reachedRoute).not.toHaveBeenCalled();
  });
  it('retains originless callers', async () => {
    expect((await request()).status).toBe(200);
    expect(reachedRoute).toHaveBeenCalledOnce();
  });
  it('honors the configured allowlist without admitting default origins', async () => {
    const response = await request('https://app.yebomart.com', 'GET', 'https://custom.example');
    expect(response.status).toBe(403);
    expect(reachedRoute).not.toHaveBeenCalled();
  });
});
