import { describe, it, expect } from 'vitest';
import customerRoutes from './customer.routes';
import { managerAuth } from '../middleware/auth.middleware';

// Route-gate regression tests. The middleware itself is covered in
// auth.middleware.test.ts — what we assert here is that the money-touching
// customer routes are actually *wired* to it. A gate that exists but isn't
// mounted protects nothing, and a one-line `managerAuth` is easy to drop in a
// future refactor of this file.

type RouteLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: unknown }>;
  };
};

function handlersFor(method: string, path: string): unknown[] {
  const stack = (customerRoutes as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route?.methods[method]);
  if (!layer?.route) {
    throw new Error(`Route ${method.toUpperCase()} ${path} is not mounted on the customer router`);
  }
  return layer.route.stack.map((s) => s.handle);
}

describe('customer routes — credit-ledger writes are manager-gated', () => {
  it('POST /:id/credit requires OWNER/MANAGER', () => {
    // Without this gate any authenticated cashier could post a PAYMENT or
    // ADJUSTMENT entry and wipe out a customer's outstanding debt.
    expect(handlersFor('post', '/:id/credit')).toContain(managerAuth);
  });

  it('runs the role check before the request-body validator', () => {
    // Unauthorised callers should be rejected on identity alone, without the
    // server parsing their payload first.
    expect(handlersFor('post', '/:id/credit')[0]).toBe(managerAuth);
  });

  it.each([
    ['patch', '/:id'],
    ['post', '/:id/send-statement'],
  ])('keeps the sibling privileged route %s %s gated', (method, path) => {
    expect(handlersFor(method, path)).toContain(managerAuth);
  });
});
