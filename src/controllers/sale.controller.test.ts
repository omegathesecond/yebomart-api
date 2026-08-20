import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SaleController, smsReceiptSchema, createSaleSchema } from './sale.controller';
import { resetDb, seedShop, seedSale, seedProduct, seedCustomer, table } from '../test/prismaFake';

// Minimal Express req/res doubles. The controller only touches the fields set
// here; res records the status + JSON body for assertions.
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

function reqFor(body: Record<string, any>): any {
  return {
    user: { id: 'user_1', shopId: 'shop_1', role: 'CASHIER', type: 'user' },
    body,
  };
}

// Stand in for the YeboLink HTTP gateway: the real YeboLinkClient.sendSMS calls
// global.fetch, so we stub that to control success/failure and capture the
// outgoing payload (proving the SMS body + recipient are correct end-to-end).
function stubFetchOk(): { calls: any[] } {
  const calls: any[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { message_id: 'msg_123', status: 'sent' } }),
      } as any;
    }),
  );
  return { calls };
}

function stubFetchFail() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => ({ success: false, error: 'gateway down' }),
    }) as any),
  );
}

beforeEach(() => {
  resetDb();
  process.env.YEBOLINK_API_KEY = 'ybk_test';
  // shop_1 is the shop every seed* helper attaches rows to.
  seedShop({ id: 'shop_1', name: 'Corner Store', currencySymbol: 'E' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SaleController.smsReceipt — happy path', () => {
  it('texts a concise receipt via YeboLink SMS and returns 200 with the message id', async () => {
    const sale = seedSale({
      receiptNumber: 'RCP-260626-0007',
      totalAmount: 250,
      paymentMethod: 'CASH',
      items: [
        { productName: 'Bread', quantity: 2, unitPrice: 50, costPrice: 30, totalPrice: 100 },
        { productName: 'Milk', quantity: 3, unitPrice: 50, costPrice: 30, totalPrice: 150 },
      ],
    });
    const { calls } = stubFetchOk();
    const res = mockRes();

    await SaleController.smsReceipt(reqFor({ saleId: sale.id, phone: '+26878422613' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ success: true, messageId: 'msg_123', status: 'sent' });

    // Exactly one SMS went out, to the supplied number, on the sms channel.
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ to: '+26878422613', channel: 'sms' });

    // The body is built server-side from the persisted sale (currency-correct).
    const text: string = calls[0].body.content.text;
    expect(text).toContain('Corner Store');
    expect(text).toContain('Receipt RCP-260626-0007');
    expect(text).toContain('2x Bread E100.00');
    expect(text).toContain('Total: E250.00');
    expect(text).toContain('Paid: Cash');
  });

  it('looks the sale up by receiptNumber when no saleId is given', async () => {
    seedSale({ receiptNumber: 'RCP-260626-0009', totalAmount: 40, items: [] });
    const { calls } = stubFetchOk();
    const res = mockRes();

    await SaleController.smsReceipt(reqFor({ receiptNumber: 'RCP-260626-0009', phone: '+26878422613' }), res);

    expect(res.statusCode).toBe(200);
    expect(calls[0].body.content.text).toContain('Receipt RCP-260626-0009');
  });
});

describe('SaleController.smsReceipt — failures surface loudly (no silent fallback)', () => {
  it('returns 404 when the sale is not in the caller shop', async () => {
    const res = mockRes();
    await SaleController.smsReceipt(reqFor({ saleId: 'does_not_exist', phone: '+26878422613' }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('does NOT leak another shop\'s sale', async () => {
    seedShop({ id: 'shop_2', name: 'Other Shop', currencySymbol: 'E' });
    const sale = seedSale({ shopId: 'shop_2', receiptNumber: 'RCP-OTHER', items: [] });
    const res = mockRes();
    await SaleController.smsReceipt(reqFor({ saleId: sale.id, phone: '+26878422613' }), res);
    expect(res.statusCode).toBe(404);
  });

  it('returns 5xx (not a fake success) when YeboLink fails to deliver', async () => {
    const sale = seedSale({ items: [] });
    stubFetchFail();
    const res = mockRes();

    await SaleController.smsReceipt(reqFor({ saleId: sale.id, phone: '+26878422613' }), res);

    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/Failed to send SMS receipt/i);
  });
});

describe('smsReceiptSchema — phone validation + normalization', () => {
  it('requires at least one of saleId / receiptNumber', () => {
    const { error } = smsReceiptSchema.validate({ phone: '+26878422613' });
    expect(error).toBeTruthy();
  });

  it('rejects a missing phone', () => {
    const { error } = smsReceiptSchema.validate({ saleId: 's1' });
    expect(error).toBeTruthy();
  });

  it('rejects a non-numeric phone', () => {
    const { error } = smsReceiptSchema.validate({ saleId: 's1', phone: 'not-a-phone' });
    expect(error).toBeTruthy();
    expect(error?.message).toMatch(/valid phone/i);
  });

  it('normalizes spaces / dashes / parens out of the accepted phone', () => {
    const { error, value } = smsReceiptSchema.validate({ saleId: 's1', phone: '+268 7842-2613' });
    expect(error).toBeUndefined();
    expect(value.phone).toBe('+26878422613');
  });
});

describe('createSaleSchema — a credit sale must name a customer', () => {
  const base = {
    items: [{ productId: 'prod_1', quantity: 1 }],
    amountPaid: 0,
  };

  it('rejects CREDIT with no customerId', () => {
    const { error } = createSaleSchema.validate({ ...base, paymentMethod: 'CREDIT' });
    expect(error?.message).toMatch(/customer is required for credit/i);
  });

  it('rejects CREDIT with an empty customerId', () => {
    const { error } = createSaleSchema.validate({
      ...base,
      paymentMethod: 'CREDIT',
      customerId: '',
    });
    expect(error?.message).toMatch(/customer is required for credit/i);
  });

  it('accepts CREDIT with a customerId', () => {
    const { error } = createSaleSchema.validate({
      ...base,
      paymentMethod: 'CREDIT',
      customerId: 'cust_1',
    });
    expect(error).toBeUndefined();
  });

  it('still allows CASH with no customerId (attaching a buyer stays optional)', () => {
    const { error } = createSaleSchema.validate({
      ...base,
      paymentMethod: 'CASH',
      amountPaid: 50,
    });
    expect(error).toBeUndefined();
  });
});

describe('SaleController.create — credit ("on the book") sales', () => {
  it('books the sale to the customer ledger and returns the new balance for the receipt', async () => {
    seedShop({ id: 'shop_1' });
    const product = seedProduct({ shopId: 'shop_1', sellPrice: 10, quantity: 100 });
    const customer = seedCustomer({ shopId: 'shop_1', balance: 20, creditLimit: 0 });
    const res = mockRes();

    await SaleController.create(
      reqFor({
        items: [{ productId: product.id, quantity: 3 }],
        paymentMethod: 'CREDIT',
        amountPaid: 0,
        customerId: customer.id,
      }),
      res,
    );

    expect(res.statusCode).toBe(201);
    expect(res.body.data.amountPaid).toBe(0);
    expect(res.body.data.customerBalance).toBe(50);
  });

  it('returns 422 CREDIT_LIMIT_EXCEEDED with the numbers, not a silent success', async () => {
    seedShop({ id: 'shop_1', currencySymbol: 'E' });
    const product = seedProduct({ shopId: 'shop_1', sellPrice: 10, quantity: 100 });
    const customer = seedCustomer({ shopId: 'shop_1', balance: 80, creditLimit: 100 });
    const res = mockRes();

    await SaleController.create(
      reqFor({
        items: [{ productId: product.id, quantity: 3 }], // 30 → would be 110 > 100
        paymentMethod: 'CREDIT',
        amountPaid: 0,
        customerId: customer.id,
      }),
      res,
    );

    expect(res.statusCode).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('CREDIT_LIMIT_EXCEEDED');
    expect(res.body.message).toMatch(/Credit limit exceeded/);
    expect(res.body.meta).toMatchObject({
      requiresOverride: false,
      creditLimit: 100,
      currentBalance: 80,
      attemptedBalance: 110,
    });

    // Nothing committed: no sale, no ledger entry, stock untouched.
    expect(table('sale')).toHaveLength(0);
    expect(table('customerCredit')).toHaveLength(0);
    expect(table('product').find((p) => p.id === product.id)!.quantity).toBe(100);
  });

  it('returns 400 (not 500) when a credit sale reaches the service with no customer', async () => {
    seedShop({ id: 'shop_1' });
    const product = seedProduct({ shopId: 'shop_1', sellPrice: 10, quantity: 100 });
    const res = mockRes();

    await SaleController.create(
      reqFor({
        items: [{ productId: product.id, quantity: 1 }],
        paymentMethod: 'CREDIT',
        amountPaid: 0,
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/customer is required for credit/i);
    expect(table('sale')).toHaveLength(0);
  });
});
