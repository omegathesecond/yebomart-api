import { describe, it, expect, beforeEach } from 'vitest';
import {
  ExpenseController,
  createExpenseSchema,
  updateExpenseSchema,
} from './expense.controller';
import { resetDb, seedExpense, table } from '../test/prismaFake';

// Minimal Express req/res doubles, mirroring customer.controller.test.ts.
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
  body: Record<string, any>,
  opts: { id?: string; shopId?: string } = {},
): any {
  return {
    user: { id: 'user_1', shopId: opts.shopId ?? 'shop_1', role: 'MANAGER' },
    params: { id: opts.id ?? '' },
    body,
  };
}

beforeEach(() => {
  resetDb();
});

const RECEIPT = 'https://cdn.yebomart.com/expenses/receipt-1.jpg';

describe('ExpenseController.create — receipt attachment', () => {
  it('persists receiptUrl when the client attaches one', async () => {
    const res = mockRes();

    await ExpenseController.create(
      reqFor({
        category: 'SUPPLIES',
        amount: 250,
        description: 'Till rolls',
        date: new Date('2026-08-20T00:00:00.000Z'),
        receiptUrl: RECEIPT,
      }),
      res,
    );

    expect(res.statusCode).toBe(201);
    expect(res.body.data.receiptUrl).toBe(RECEIPT);
    expect(table('expense')).toHaveLength(1);
    expect(table('expense')[0].receiptUrl).toBe(RECEIPT);
    // shopId comes from the token, never the body.
    expect(table('expense')[0].shopId).toBe('shop_1');
  });

  it('records an expense with no receipt at all', async () => {
    const res = mockRes();

    await ExpenseController.create(
      reqFor({ category: 'RENT', amount: 4000, date: new Date('2026-08-01T00:00:00.000Z') }),
      res,
    );

    expect(res.statusCode).toBe(201);
    expect(table('expense')[0].receiptUrl).toBeUndefined();
  });
});

describe('ExpenseController.update — attach / replace / detach a receipt', () => {
  it('attaches a receipt to an existing expense', async () => {
    const expense = seedExpense({ receiptUrl: null });
    const res = mockRes();

    await ExpenseController.update(
      reqFor({ receiptUrl: RECEIPT }, { id: expense.id }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.data.receiptUrl).toBe(RECEIPT);
    expect(table('expense')[0].receiptUrl).toBe(RECEIPT);
    // A partial update must not disturb the untouched fields.
    expect(table('expense')[0].amount).toBe(100);
    expect(table('expense')[0].category).toBe('SUPPLIES');
  });

  it('replaces an existing receipt', async () => {
    const expense = seedExpense({ receiptUrl: RECEIPT });
    const replacement = 'https://cdn.yebomart.com/expenses/receipt-2.jpg';
    const res = mockRes();

    await ExpenseController.update(
      reqFor({ receiptUrl: replacement }, { id: expense.id }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(table('expense')[0].receiptUrl).toBe(replacement);
  });

  it("stores NULL (not '') when the receipt is removed", async () => {
    const expense = seedExpense({ receiptUrl: RECEIPT });
    const res = mockRes();

    await ExpenseController.update(reqFor({ receiptUrl: '' }, { id: expense.id }), res);

    expect(res.statusCode).toBe(200);
    expect(table('expense')[0].receiptUrl).toBeNull();
  });

  it('updates the other editable fields too', async () => {
    const expense = seedExpense({ amount: 100, category: 'SUPPLIES' });
    const res = mockRes();

    await ExpenseController.update(
      reqFor({ amount: 175.5, category: 'TRANSPORT', description: 'Fuel' }, { id: expense.id }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(table('expense')[0].amount).toBe(175.5);
    expect(table('expense')[0].category).toBe('TRANSPORT');
    expect(table('expense')[0].description).toBe('Fuel');
  });

  it("404s and leaves the row untouched when the expense belongs to another shop", async () => {
    const expense = seedExpense({ shopId: 'shop_2', receiptUrl: null });
    const res = mockRes();

    await ExpenseController.update(
      reqFor({ receiptUrl: RECEIPT }, { id: expense.id, shopId: 'shop_1' }),
      res,
    );

    expect(res.statusCode).toBe(404);
    expect(table('expense')[0].receiptUrl).toBeNull();
  });

  it('404s for an id that does not exist', async () => {
    const res = mockRes();

    await ExpenseController.update(reqFor({ receiptUrl: RECEIPT }, { id: 'nope' }), res);

    expect(res.statusCode).toBe(404);
  });

  it('401s without a user on the request', async () => {
    const res = mockRes();

    await ExpenseController.update({ params: { id: 'x' }, body: {} } as any, res);

    expect(res.statusCode).toBe(401);
  });
});

// The route wires these schemas through validateRequest, so what they accept
// IS the endpoint's contract.
describe('expense receiptUrl validation contract', () => {
  it('create accepts a valid receipt url', () => {
    const { error } = createExpenseSchema.validate({
      category: 'SUPPLIES',
      amount: 10,
      receiptUrl: RECEIPT,
    });
    expect(error).toBeUndefined();
  });

  it('create rejects a non-url receipt (so the app must omit it, not send "")', () => {
    const { error } = createExpenseSchema.validate({
      category: 'SUPPLIES',
      amount: 10,
      receiptUrl: '',
    });
    expect(error).toBeDefined();
  });

  it("update accepts '' as the explicit detach signal", () => {
    const { error } = updateExpenseSchema.validate({ receiptUrl: '' });
    expect(error).toBeUndefined();
  });

  it('update rejects a receiptUrl that is not a url', () => {
    const { error } = updateExpenseSchema.validate({ receiptUrl: 'not a url' });
    expect(error).toBeDefined();
  });

  it('update rejects an empty body', () => {
    const { error } = updateExpenseSchema.validate({});
    expect(error).toBeDefined();
  });

  it('update rejects an unknown category', () => {
    const { error } = updateExpenseSchema.validate({ category: 'CRYPTO' });
    expect(error).toBeDefined();
  });
});
