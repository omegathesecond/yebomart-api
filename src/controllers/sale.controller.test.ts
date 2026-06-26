import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SaleController, smsReceiptSchema } from './sale.controller';
import { resetDb, seedShop, seedSale } from '../test/prismaFake';

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
