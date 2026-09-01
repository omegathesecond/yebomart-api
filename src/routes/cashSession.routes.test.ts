/**
 * Route-level tests for cash-session — pins the WIRING, not the reconciliation
 * arithmetic (that's cashSession.controller.test.ts). Two things live only in
 * cashSession.routes.ts and are invisible to a controller-level test that
 * drives CashSessionController's statics directly with a hand-built req:
 *
 *   (a) `validateRequest(openCashSessionSchema)` / `validateRequest(closeCashSessionSchema)`
 *       run BEFORE the controller. A negative openingFloat, a missing
 *       countedCash, or an over-long notes string must be rejected by Joi
 *       with a 400 and never reach CashSessionService — deleting the
 *       validateRequest() call (or loosening the schema) would let a
 *       negative float open a till while the controller-level suite stays
 *       green.
 *   (b) `router.use(authMiddleware)` gates all four routes. Deleting that
 *       line would leave req.user unset for every request — the controller's
 *       own `if (!req.user)` check would then 401 even a request carrying a
 *       VALID token, which the "reaches the controller" assertions below
 *       catch (they'd flip from 201/400/404 to 401).
 *
 * The app under test mounts the real router with express.json() in front of
 * it and drives the REAL authMiddleware (imported unmocked) with a real
 * HS256 staff token signed by the same JWTUtil the middleware verifies with
 * — no auth stubbing needed for the happy path. The only mock is
 * '@yebo/mcp-server' (JwksValidator), so the middleware's YeboID branch
 * fails fast into the HS256 branch instead of making a real network call to
 * api.yeboid.com. @config/prisma is aliased to the in-memory prismaFake for
 * the whole suite (see vitest.config.ts), so a request that clears
 * validation drives the same store as the controller suite.
 *
 * Note: local imports below use RELATIVE paths, not the `@alias/*` short
 * forms — tsconfig.json excludes `src/**\/*.test.ts` from its `include`, so
 * vite-tsconfig-paths does not resolve those aliases from within a test
 * file (it does resolve them fine from non-test source files like
 * cashSession.routes.ts, which is how the router itself imports things).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// auth.middleware.ts tries YeboID (JwksValidator, real JWKS network call)
// before falling back to the yebomart-signed HS256 path. Tests must never
// hit the network, so make that branch fail immediately and deterministically
// — every request in this file authenticates via the HS256 fallback.
vi.mock('@yebo/mcp-server', () => ({
  JwksValidator: vi.fn().mockImplementation(() => ({
    verify: vi.fn().mockRejectedValue(new Error('not a YeboID token')),
  })),
  extractBearerToken: (header?: string) =>
    header?.startsWith('Bearer ') ? header.slice(7) : null,
}));

import cashSessionRoutes from './cashSession.routes';
import { JWTUtil } from '../utils/jwt';
import { resetDb, seedShop, seedUser, table } from '../test/prismaFake';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cashSessionRoutes);
  return app;
}

let staffToken: string;

beforeEach(() => {
  resetDb();
  seedShop({
    ownerYeboidSub: '11111111-1111-1111-1111-111111111111',
    name: 'Test Shop',
    currency: 'SZL',
    currencySymbol: 'E',
  });
  const cashierId = seedUser({ shopId: 'shop_1', name: 'Thandi' }).id;
  staffToken = JWTUtil.generateAccessToken({
    id: cashierId,
    shopId: 'shop_1',
    role: 'CASHIER',
    type: 'user',
  });
});

function authed(req: request.Test) {
  return req.set('Authorization', `Bearer ${staffToken}`);
}

describe('POST /open — Joi validation', () => {
  it('rejects a negative openingFloat with 400 and persists nothing', async () => {
    const res = await authed(request(buildApp()).post('/open')).send({ openingFloat: -1 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(table('cashSession')).toHaveLength(0);
  });

  it('rejects a missing body with 400', async () => {
    const res = await authed(request(buildApp()).post('/open')).send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(table('cashSession')).toHaveLength(0);
  });

  it('accepts a valid openingFloat, passes validation, and actually opens the till', async () => {
    const res = await authed(request(buildApp()).post('/open')).send({ openingFloat: 250 });

    expect(res.status).toBe(201);
    expect(table('cashSession')).toHaveLength(1);
    expect(table('cashSession')[0].openingFloat).toBe(250);
  });
});

describe('POST /:id/close — Joi validation', () => {
  it('rejects a missing countedCash with 400', async () => {
    const res = await authed(request(buildApp()).post('/some-session-id/close')).send({
      notes: 'balanced',
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects notes longer than 1000 characters with 400', async () => {
    const res = await authed(request(buildApp()).post('/some-session-id/close')).send({
      countedCash: 100,
      notes: 'x'.repeat(1001),
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('accepts a valid payload, passes validation, and reaches the controller (404 — no such session)', async () => {
    const res = await authed(request(buildApp()).post('/some-session-id/close')).send({
      countedCash: 100,
    });

    // A 400 here would mean the schema is still blocking a well-formed
    // body; a 404 proves it cleared Joi and reached CashSessionService.
    expect(res.status).toBe(404);
  });
});

describe('auth gate — router.use(authMiddleware)', () => {
  it('401s POST /open without a token, and persists nothing', async () => {
    const res = await request(buildApp()).post('/open').send({ openingFloat: 100 });

    expect(res.status).toBe(401);
    expect(table('cashSession')).toHaveLength(0);
  });

  it('401s GET /current without a token', async () => {
    const res = await request(buildApp()).get('/current');

    expect(res.status).toBe(401);
  });

  it('401s POST /:id/close without a token', async () => {
    const res = await request(buildApp()).post('/some-id/close').send({ countedCash: 100 });

    expect(res.status).toBe(401);
  });

  it('401s GET /:id/zreport without a token', async () => {
    const res = await request(buildApp()).get('/some-id/zreport');

    expect(res.status).toBe(401);
  });

  it('401s with a garbage token, never reaching validation', async () => {
    // Proves the gate rejects a bad token outright — an invalid Bearer value
    // that passes neither the YeboID nor the HS256 check — rather than
    // merely reflecting "no header at all".
    const res = await request(buildApp())
      .post('/open')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ openingFloat: -1 });

    expect(res.status).toBe(401);
  });
});
