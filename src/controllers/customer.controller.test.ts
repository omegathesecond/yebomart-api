import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CustomerController } from './customer.controller';
import { resetDb, seedCustomer, table } from '../test/prismaFake';

// Minimal Express req/res doubles. The controller only touches the fields set
// here, and res records the status + JSON body for assertions.
function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: any) => {
    res.body = body;
    return res;
  };
  res.send = () => res;
  return res;
}

function reqFor(
  customerId: string,
  body: Record<string, any>,
  role: 'OWNER' | 'MANAGER' | 'CASHIER' = 'CASHIER',
): any {
  return {
    user: { id: 'user_1', shopId: 'shop_1', role },
    params: { id: customerId },
    body,
  };
}

beforeEach(() => {
  resetDb();
});

describe('CustomerController.addCredit — ADJUSTMENT applies its signed amount (bug #2)', () => {
  it('a negative ADJUSTMENT lowers the balance atomically with the ledger write', async () => {
    const customer = seedCustomer({ balance: 100, creditLimit: 0 });
    const res = mockRes();

    await CustomerController.addCredit(reqFor(customer.id, { type: 'ADJUSTMENT', amount: -40 }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.newBalance).toBe(60);
    // Balance actually moved on the customer row...
    expect(table('customer')[0].balance).toBe(60);
    // ...and exactly one ledger entry was written.
    expect(table('customerCredit')).toHaveLength(1);
    expect(table('customerCredit')[0].amount).toBe(-40);
  });

  it('a positive ADJUSTMENT raises the balance', async () => {
    const customer = seedCustomer({ balance: 100, creditLimit: 0 });
    const res = mockRes();

    await CustomerController.addCredit(reqFor(customer.id, { type: 'ADJUSTMENT', amount: 25 }), res);

    expect(res.statusCode).toBe(200);
    expect(table('customer')[0].balance).toBe(125);
  });
});

describe('CustomerController.addCredit — credit limit enforcement (bug #1)', () => {
  it('rejects an over-limit PURCHASE and does NOT touch the balance or write a ledger row', async () => {
    const customer = seedCustomer({ balance: 50, creditLimit: 100 });
    const res = mockRes();

    await CustomerController.addCredit(reqFor(customer.id, { type: 'PURCHASE', amount: 80 }), res);

    expect(res.statusCode).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/Credit limit exceeded/i);
    // Nothing was committed.
    expect(table('customer')[0].balance).toBe(50);
    expect(table('customerCredit')).toHaveLength(0);
  });

  it('lets a PURCHASE within the limit through', async () => {
    const customer = seedCustomer({ balance: 50, creditLimit: 100 });
    const res = mockRes();

    await CustomerController.addCredit(reqFor(customer.id, { type: 'PURCHASE', amount: 40 }), res);

    expect(res.statusCode).toBe(200);
    expect(table('customer')[0].balance).toBe(90);
  });

  it('honours override=true only for an OWNER', async () => {
    const customer = seedCustomer({ balance: 50, creditLimit: 100 });
    const res = mockRes();

    await CustomerController.addCredit(
      reqFor(customer.id, { type: 'PURCHASE', amount: 80, override: true }, 'OWNER'),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(table('customer')[0].balance).toBe(130);
  });

  it('ignores override=true from a non-OWNER (cashier cannot self-approve)', async () => {
    const customer = seedCustomer({ balance: 50, creditLimit: 100 });
    const res = mockRes();

    await CustomerController.addCredit(
      reqFor(customer.id, { type: 'PURCHASE', amount: 80, override: true }, 'CASHIER'),
      res,
    );

    expect(res.statusCode).toBe(422);
    expect(table('customer')[0].balance).toBe(50);
    expect(table('customerCredit')).toHaveLength(0);
  });

  it('a PAYMENT is never blocked by the credit limit', async () => {
    const customer = seedCustomer({ balance: 500, creditLimit: 100 });
    const res = mockRes();

    await CustomerController.addCredit(reqFor(customer.id, { type: 'PAYMENT', amount: 50 }), res);

    expect(res.statusCode).toBe(200);
    expect(table('customer')[0].balance).toBe(450);
  });
});

describe('CustomerController — audit logging (owner-initiated writes succeed and appear)', () => {
  it('an OWNER addCredit writes an audit row with NO userId (owners have no User row)', async () => {
    const customer = seedCustomer({ balance: 0, creditLimit: 0 });
    const res = mockRes();

    // OWNER actor: reqFor sets role but no `type`, mirroring the YeboID owner
    // shape (type === 'shop'), so auditContext stores userId = null.
    await CustomerController.addCredit(
      reqFor(customer.id, { type: 'ADJUSTMENT', amount: 30 }, 'OWNER'),
      res,
    );

    expect(res.statusCode).toBe(200);
    const logs = table('auditLog');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      shopId: 'shop_1',
      userId: null,
      actorRole: 'OWNER',
      action: 'CREDIT_ADD',
      entityType: 'customer',
      entityId: customer.id,
    });
    expect(logs[0].details).toMatchObject({ creditType: 'ADJUSTMENT', amount: 30, newBalance: 30 });
  });

  it('a CASHIER (staff) addCredit writes an audit row carrying their userId', async () => {
    const customer = seedCustomer({ balance: 0, creditLimit: 1000 });
    const res = mockRes();

    const req = reqFor(customer.id, { type: 'PURCHASE', amount: 40 }, 'CASHIER');
    req.user.type = 'user'; // staff token shape
    await CustomerController.addCredit(req, res);

    expect(res.statusCode).toBe(200);
    const logs = table('auditLog');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ userId: 'user_1', actorRole: 'CASHIER', action: 'CREDIT_ADD' });
  });

  it('a CREATE writes a CUSTOMER_CREATE audit row', async () => {
    const res = mockRes();
    const req: any = { user: { id: 'shop_1', shopId: 'shop_1', role: 'OWNER' }, params: {}, body: { name: 'Walk-in' } };

    await CustomerController.create(req, res);

    expect(res.statusCode).toBe(201);
    const logs = table('auditLog');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: 'CUSTOMER_CREATE', entityType: 'customer', actorRole: 'OWNER', userId: null });
  });
});

describe('CustomerController.addCredit — machine-readable signal survives production', () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  // The whole point of this case: ApiResponse.error strips the dev-only `error`
  // arg in production, so the over-limit contract MUST ride the ungated
  // top-level code/meta channel. Assert it survives with NODE_ENV unset/prod.
  for (const env of ['production', undefined] as const) {
    it(`returns code=CREDIT_LIMIT_EXCEEDED + requiresOverride when NODE_ENV=${env ?? 'unset'}`, async () => {
      process.env.NODE_ENV = env as any;
      const customer = seedCustomer({ balance: 50, creditLimit: 100 });
      const res = mockRes();

      await CustomerController.addCredit(reqFor(customer.id, { type: 'PURCHASE', amount: 80 }), res);

      expect(res.statusCode).toBe(422);
      // Stable, machine-readable signal — present regardless of environment.
      expect(res.body.code).toBe('CREDIT_LIMIT_EXCEEDED');
      expect(res.body.meta).toMatchObject({
        requiresOverride: true,
        creditLimit: 100,
        currentBalance: 50,
        attemptedBalance: 130,
      });
      // The loud human message is still there too.
      expect(res.body.message).toMatch(/Credit limit exceeded/i);
      // And the dev-only `error` debug field stays stripped in production.
      expect(res.body.error).toBeUndefined();
    });
  }
});
