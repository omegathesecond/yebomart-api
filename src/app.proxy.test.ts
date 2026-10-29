import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

vi.mock('./routes/index', async () => {
  const { Router } = await import('express');
  const { authLimiter } = await import('./middleware/rateLimit.middleware');
  const router = Router();
  router.get('/proxy-test', authLimiter, (req, res) => res.json({ ip: req.ip }));
  return { default: router };
});
import app from './app';

describe('Cloud Run proxy boundary and real IP rate limiting', () => {
  let server: Server;
  let url: string;
  const errors = vi.spyOn(console, 'error');
  beforeAll(async () => {
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/proxy-test`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    errors.mockRestore();
  });
  async function request(forwarded?: string) {
    return fetch(url, { headers: forwarded ? { 'X-Forwarded-For': forwarded } : {} });
  }
  it('uses the nearest forwarded address and ignores caller-controlled prefixes', async () => {
    const response = await request('192.0.2.10, 198.51.100.10');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ip: '198.51.100.10' });
    expect(await (await request('192.0.2.11, 198.51.100.10')).json()).toEqual({ ip: '198.51.100.10' });
    expect(errors).not.toHaveBeenCalled();
  });
  it('keeps different clients separate and cannot bypass auth limits by spoofing prefixes', async () => {
    for (let i = 0; i < 100; i++) {
      expect((await request(`192.0.2.${i + 1}, 198.51.100.20`)).status).toBe(200);
    }
    expect((await request('203.0.113.90, 198.51.100.20')).status).toBe(429);
    expect((await request('203.0.113.90, 198.51.100.21')).status).toBe(200);
    expect(errors).not.toHaveBeenCalled();
  });
  it('uses the socket address when no forwarded header is present', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ip: '127.0.0.1' });
  });
});
