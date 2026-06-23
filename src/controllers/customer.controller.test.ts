import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CustomerController, updateCustomerSchema } from './customer.controller';
import { resetDb, seedCustomer, table } from '../test/prismaFake';

// Mirror exactly how validateRequest runs the schema in production
// (src/middleware/validation.middleware.ts): abortEarly:false + stripUnknown:true.
// This is the boundary that protects PATCH /api/customers/:id from
// mass-assignment, so we assert against the same options the route uses.
function runUpdateSchema(body: Record<string, any>) {
  return updateCustomerSchema.validate(body, { abortEarly: false, stripUnknown: true });
}

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

describe('updateCustomerSchema — blocks mass-assignment on PATCH /:id', () => {
  it('strips balance, shopId, createdAt, updatedAt and id from the update body', () => {
    const { value, error } = runUpdateSchema({
      name: 'Jane Doe',
      balance: 0, // attacker trying to wipe their debt
      shopId: 'shop_2', // attacker trying to move the record cross-tenant
      createdAt: '2000-01-01',
      updatedAt: '2000-01-01',
      id: 'someone_elses_id',
      creditLimit: 999999, // attacker trying to raise their own limit (allowed field, but see note)
    });

    // The dangerous fields never survive validation...
    expect(error).toBeUndefined();
    expect(value).not.toHaveProperty('balance');
    expect(value).not.toHaveProperty('shopId');
    expect(value).not.toHaveProperty('createdAt');
    expect(value).not.toHaveProperty('updatedAt');
    expect(value).not.toHaveProperty('id');
    // ...while the legitimate whitelisted fields pass through.
    expect(value).toEqual({ name: 'Jane Doe', creditLimit: 999999 });
  });

  it('rejects a body that contains ONLY forbidden fields (nothing left to update)', () => {
    const { value, error } = runUpdateSchema({ balance: 0, shopId: 'shop_2', createdAt: '2000-01-01' });

    // After stripping, the object is empty, so .min(1) fails — the request is a
    // 400, NOT a silent no-op that could mask the attempt.
    expect(value).toEqual({});
    expect(error).toBeDefined();
    expect(error?.details[0].type).toBe('object.min');
  });

  it('allows a normal profile edit (name/phone/email/address/isActive)', () => {
    const { value, error } = runUpdateSchema({
      name: 'Jane Doe',
      phone: '+26878422613',
      email: 'jane@example.com',
      address: '12 Market St',
      isActive: false,
    });

    expect(error).toBeUndefined();
    expect(value).toEqual({
      name: 'Jane Doe',
      phone: '+26878422613',
      email: 'jane@example.com',
      address: '12 Market St',
      isActive: false,
    });
  });

  it('controller cannot change balance/shop when the post-strip body has no such keys', async () => {
    // Belt-and-suspenders: even if the controller is reached with a body that
    // the middleware already stripped to {}, updateMany writes nothing dangerous.
    const customer = seedCustomer({ balance: 100, shopId: 'shop_1', creditLimit: 0 });
    const res = mockRes();

    // Simulate the post-middleware body: forbidden keys already removed.
    const { value } = runUpdateSchema({ balance: 0, shopId: 'shop_2' });
    await CustomerController.update({ user: { id: 'u', shopId: 'shop_1', role: 'MANAGER' }, params: { id: customer.id }, body: value } as any, res);

    // Balance and shop are untouched.
    expect(table('customer')[0].balance).toBe(100);
    expect(table('customer')[0].shopId).toBe('shop_1');
  });
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
