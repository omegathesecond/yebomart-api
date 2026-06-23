import { describe, it, expect, beforeEach } from 'vitest';
import { ReturnController } from './return.controller';
import { CashSessionService } from '../services/cashSession.service';
import {
  resetDb,
  seedProduct,
  seedCustomer,
  seedSale,
  seedCashSession,
  table,
} from '../test/prismaFake';

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

function user(shopId = 'shop_1') {
  return { id: 'user_1', shopId, type: 'user', role: 'MANAGER' };
}

async function createReturn(body: Record<string, any>, shopId = 'shop_1') {
  const res = mockRes();
  await ReturnController.create({ user: user(shopId), body } as any, res);
  return res;
}

async function processReturn(id: string, action: string, shopId = 'shop_1') {
  const res = mockRes();
  await ReturnController.process(
    { user: user(shopId), params: { id }, body: { action } } as any,
    res,
  );
  return res;
}

beforeEach(() => {
  resetDb();
});

describe('ReturnController.create — tenancy', () => {
  it('rejects a saleId that belongs to another shop', async () => {
    seedProduct({ id: 'p1' });
    seedSale({ id: 'sale_other', shopId: 'shop_2' });
    const res = await createReturn({
      saleId: 'sale_other',
      reason: 'defective item',
      type: 'REFUND',
      items: [{ productId: 'p1', productName: 'Widget', quantity: 1, unitPrice: 10 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Sale not found/i);
  });

  it('rejects a customerId that belongs to another shop', async () => {
    seedProduct({ id: 'p1' });
    seedCustomer({ id: 'c_other', shopId: 'shop_2', phone: '+111' });
    const res = await createReturn({
      customerId: 'c_other',
      reason: 'change of mind',
      type: 'REFUND',
      items: [{ productId: 'p1', productName: 'Widget', quantity: 1, unitPrice: 10 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Customer not found/i);
  });

  it('rejects a productId that belongs to another shop', async () => {
    seedProduct({ id: 'p_other', shopId: 'shop_2' });
    const res = await createReturn({
      reason: 'defective item',
      type: 'REFUND',
      items: [{ productId: 'p_other', productName: 'Widget', quantity: 1, unitPrice: 10 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Product\(s\) not found/i);
  });

  it('rejects a store-credit return with no customer to credit', async () => {
    seedProduct({ id: 'p1' });
    const res = await createReturn({
      reason: 'change of mind',
      type: 'STORE_CREDIT',
      items: [{ productId: 'p1', productName: 'Widget', quantity: 1, unitPrice: 10 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/store-credit return requires a customerId/i);
  });
});

describe('ReturnController.create — quantity ceiling', () => {
  it('rejects returning more than was sold', async () => {
    seedProduct({ id: 'p1', quantity: 100 });
    seedSale({ id: 'sale_1', items: [{ productId: 'p1', quantity: 2 }] });
    const res = await createReturn({
      saleId: 'sale_1',
      reason: 'defective item',
      type: 'REFUND',
      items: [{ productId: 'p1', productName: 'Widget', quantity: 3, unitPrice: 10 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/only 2 of 2 sold remain returnable/i);
  });

  it('allows returning up to the sold quantity', async () => {
    seedProduct({ id: 'p1', quantity: 100 });
    seedSale({ id: 'sale_1', items: [{ productId: 'p1', quantity: 2 }] });
    const res = await createReturn({
      saleId: 'sale_1',
      reason: 'defective item',
      type: 'REFUND',
      items: [{ productId: 'p1', productName: 'Widget', quantity: 2, unitPrice: 10 }],
    });
    expect(res.statusCode).toBe(201);
  });

  it('accounts for quantity already returned on prior non-rejected returns', async () => {
    seedProduct({ id: 'p1', quantity: 100 });
    seedSale({ id: 'sale_1', items: [{ productId: 'p1', quantity: 3 }] });
    // First return takes 2 of the 3 sold.
    const first = await createReturn({
      saleId: 'sale_1',
      reason: 'defective item',
      type: 'REFUND',
      items: [{ productId: 'p1', productName: 'Widget', quantity: 2, unitPrice: 10 }],
    });
    expect(first.statusCode).toBe(201);
    // Second return wants 2 more — only 1 remains.
    const second = await createReturn({
      saleId: 'sale_1',
      reason: 'defective item',
      type: 'REFUND',
      items: [{ productId: 'p1', productName: 'Widget', quantity: 2, unitPrice: 10 }],
    });
    expect(second.statusCode).toBe(400);
    expect(second.body.message).toMatch(/only 1 of 3 sold remain returnable/i);
  });
});

describe('ReturnController.process — state machine', () => {
  async function pendingRefund() {
    seedProduct({ id: 'p1', quantity: 100 });
    const res = await createReturn({
      reason: 'defective item',
      type: 'REFUND',
      items: [{ productId: 'p1', productName: 'Widget', quantity: 1, unitPrice: 10 }],
    });
    return res.body.data.id as string;
  }

  it('refuses to complete a PENDING return (must approve first)', async () => {
    const id = await pendingRefund();
    const res = await processReturn(id, 'complete');
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('INVALID_RETURN_TRANSITION');
  });

  it('approve -> complete succeeds and flips status to COMPLETED', async () => {
    const id = await pendingRefund();
    expect((await processReturn(id, 'approve')).statusCode).toBe(200);
    const done = await processReturn(id, 'complete');
    expect(done.statusCode).toBe(200);
    expect(done.body.data.status).toBe('COMPLETED');
  });

  it('refuses to reject a COMPLETED return', async () => {
    const id = await pendingRefund();
    await processReturn(id, 'approve');
    await processReturn(id, 'complete');
    const res = await processReturn(id, 'reject');
    expect(res.statusCode).toBe(409);
  });
});

describe('ReturnController.process — restock + exchange idempotency', () => {
  async function approvedExchange() {
    seedProduct({ id: 'p_in', quantity: 100 }); // returned (restocked)
    seedProduct({ id: 'p_out', quantity: 100 }); // exchanged out (deducted)
    const res = await createReturn({
      reason: 'wrong size',
      type: 'EXCHANGE',
      items: [{ productId: 'p_in', productName: 'In', quantity: 2, unitPrice: 10, restockable: true }],
      exchangeItems: [{ productId: 'p_out', productName: 'Out', quantity: 3, unitPrice: 10 }],
    });
    const id = res.body.data.id as string;
    await processReturn(id, 'approve');
    return id;
  }

  it('completing restocks returned items and deducts exchanged-out items exactly once', async () => {
    const id = await approvedExchange();
    const done = await processReturn(id, 'complete');
    expect(done.statusCode).toBe(200);

    const pIn = table('product').find((p) => p.id === 'p_in')!;
    const pOut = table('product').find((p) => p.id === 'p_out')!;
    expect(pIn.quantity).toBe(102); // +2 restocked
    expect(pOut.quantity).toBe(97); // -3 deducted

    expect(table('returnItem')[0].restocked).toBe(true);
    expect(table('returnExchangeItem')[0].deducted).toBe(true);

    const logs = table('stockLog');
    expect(logs.some((l) => l.type === 'RETURN' && l.quantity === 2)).toBe(true);
    expect(logs.some((l) => l.type === 'SALE' && l.quantity === -3)).toBe(true);
  });

  it('re-completing is an idempotent no-op — no double restock or double deduct', async () => {
    const id = await approvedExchange();
    await processReturn(id, 'complete');
    const again = await processReturn(id, 'complete');

    expect(again.statusCode).toBe(200);
    expect(again.body.message).toMatch(/already completed/i);

    const pIn = table('product').find((p) => p.id === 'p_in')!;
    const pOut = table('product').find((p) => p.id === 'p_out')!;
    expect(pIn.quantity).toBe(102); // unchanged — not 104
    expect(pOut.quantity).toBe(97); // unchanged — not 94
    expect(table('stockLog')).toHaveLength(2); // not 4
  });
});

describe('ReturnController.process — money booking', () => {
  it('a completed cash REFUND is tied to the open till and reduces expected drawer cash', async () => {
    seedProduct({ id: 'p1', quantity: 100 });
    const session = seedCashSession({ openingFloat: 100 });

    const created = await createReturn({
      reason: 'defective item',
      type: 'REFUND',
      items: [{ productId: 'p1', productName: 'Widget', quantity: 1, unitPrice: 30 }],
    });
    const id = created.body.data.id as string;
    await processReturn(id, 'approve');
    const done = await processReturn(id, 'complete');

    expect(done.body.data.cashSessionId).toBe(session.id);

    const current = await CashSessionService.getCurrent('shop_1');
    expect(current!.cashRefundsTotal).toBe(30);
    expect(current!.expectedCash).toBe(70); // 100 float + 0 sales − 30 refund
  });

  it('a completed STORE_CREDIT return creates a REFUND ledger entry and lowers the balance', async () => {
    seedProduct({ id: 'p1', quantity: 100 });
    const customer = seedCustomer({ id: 'c1', balance: 0, creditLimit: 0, phone: '+222' });

    const created = await createReturn({
      customerId: 'c1',
      reason: 'change of mind',
      type: 'STORE_CREDIT',
      items: [{ productId: 'p1', productName: 'Widget', quantity: 1, unitPrice: 50 }],
    });
    const id = created.body.data.id as string;
    await processReturn(id, 'approve');
    await processReturn(id, 'complete');

    const credits = table('customerCredit');
    expect(credits).toHaveLength(1);
    expect(credits[0].type).toBe('REFUND');
    expect(credits[0].amount).toBe(50);

    const updated = table('customer').find((c) => c.id === customer.id)!;
    expect(updated.balance).toBe(-50); // refund lowered what they owe
  });

  it('store credit + balance write are atomic — REFUND ledger never duplicates on re-complete', async () => {
    seedProduct({ id: 'p1', quantity: 100 });
    seedCustomer({ id: 'c1', balance: 0, creditLimit: 0, phone: '+333' });

    const created = await createReturn({
      customerId: 'c1',
      reason: 'change of mind',
      type: 'STORE_CREDIT',
      items: [{ productId: 'p1', productName: 'Widget', quantity: 1, unitPrice: 50 }],
    });
    const id = created.body.data.id as string;
    await processReturn(id, 'approve');
    await processReturn(id, 'complete');
    await processReturn(id, 'complete'); // idempotent re-run

    expect(table('customerCredit')).toHaveLength(1);
    expect(table('customer').find((c) => c.id === 'c1')!.balance).toBe(-50);
  });
});
