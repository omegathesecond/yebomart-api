import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SaleController, smsReceiptSchema } from './sale.controller';
import { resetDb, seedShop, seedSale } from '../test/prismaFake';

// emailReceipt dynamically imports @services/yebopay.client — vi.mock still
// hoists and intercepts that resolution regardless of the static/dynamic
// import site.
vi.mock('../services/yebopay.client', () => ({
  YeboPayClient: {
    createInvoice: vi.fn(async (input: any) => ({
      id: 'inv_1',
      number: 'INV-0001',
      status: 'PAID',
      amount_due: '0',
      amount_paid: String(input.amountPaid),
      currency: input.currency,
      pdf_url: null,
      sent_at: null,
      paid_at: input.paidAt ?? null,
      to_email: input.toEmail,
      charge_id: null,
    })),
    sendInvoice: vi.fn(async () => ({ pdf_url: 'https://example.com/inv_1.pdf' })),
  },
}));
import { YeboPayClient } from '../services/yebopay.client';

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

function reqFor(body: Record<string, any>, shopId = 'shop_1'): any {
  return {
    user: { id: 'user_1', shopId, role: 'CASHIER', type: 'user' },
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

describe('SaleController.emailReceipt — YeboPay invoice reconciles with the sale total', () => {
  it('exclusive VAT: adds a VAT line so lineItems sum to amountPaid (= totalAmount)', async () => {
    // South Africa: directBillable, fxRate 1 — keeps assertions currency-neutral.
    seedShop({ id: 'shop_vat1', name: 'Corner Store', countryCode: 'ZA', ownerYeboidSub: 'yeboid_owner_vat1' });
    const sale = seedSale({
      shopId: 'shop_vat1',
      subtotal: 100,
      discount: 0,
      tax: 15,
      totalAmount: 115,
      amountPaid: 115,
      items: [{ productName: 'Bread', quantity: 1, unitPrice: 100, costPrice: 60, totalPrice: 100 }],
    });
    const res = mockRes();

    await SaleController.emailReceipt(reqFor({ email: 'buyer@example.com', saleId: sale.id }, 'shop_vat1'), res);

    expect(res.statusCode).toBe(200);
    const input = (YeboPayClient.createInvoice as any).mock.calls[0][0];
    expect(input.amountPaid).toBe(115);
    expect(input.lineItems).toEqual([
      { description: 'Bread', quantity: 1, unitPrice: 100 },
      { description: 'VAT', quantity: 1, unitPrice: 15 },
    ]);
    const sum = input.lineItems.reduce((s: number, li: any) => s + li.quantity * li.unitPrice, 0);
    expect(sum).toBe(input.amountPaid);
  });

  it('exclusive VAT + cart discount: adds both a Discount and a VAT line', async () => {
    seedShop({ id: 'shop_vat2', name: 'Corner Store', countryCode: 'ZA', ownerYeboidSub: 'yeboid_owner_vat2' });
    // base = 100 - 20 = 80; tax = 80 * 15/100 = 12; total = 92.
    const sale = seedSale({
      shopId: 'shop_vat2',
      subtotal: 100,
      discount: 20,
      tax: 12,
      totalAmount: 92,
      amountPaid: 92,
      items: [{ productName: 'Bread', quantity: 1, unitPrice: 100, costPrice: 60, totalPrice: 100 }],
    });
    const res = mockRes();

    await SaleController.emailReceipt(reqFor({ email: 'buyer@example.com', saleId: sale.id }, 'shop_vat2'), res);

    const input = (YeboPayClient.createInvoice as any).mock.calls[0][0];
    expect(input.lineItems).toEqual([
      { description: 'Bread', quantity: 1, unitPrice: 100 },
      { description: 'Discount', quantity: 1, unitPrice: -20 },
      { description: 'VAT', quantity: 1, unitPrice: 12 },
    ]);
    const sum = input.lineItems.reduce((s: number, li: any) => s + li.quantity * li.unitPrice, 0);
    expect(sum).toBe(92);
    expect(input.amountPaid).toBe(92);
  });

  it('inclusive VAT: tax is already inside the item price — no separate VAT line, still reconciles', async () => {
    seedShop({
      id: 'shop_vat3',
      name: 'Corner Store',
      countryCode: 'ZA',
      ownerYeboidSub: 'yeboid_owner_vat3',
      taxInclusive: true,
    });
    // 100 inclusive @ 15% -> tax 13.04 backed out, total unchanged at 100.
    const sale = seedSale({
      shopId: 'shop_vat3',
      subtotal: 100,
      discount: 0,
      tax: 13.04,
      totalAmount: 100,
      amountPaid: 100,
      items: [{ productName: 'Bread', quantity: 1, unitPrice: 100, costPrice: 60, totalPrice: 100 }],
    });
    const res = mockRes();

    await SaleController.emailReceipt(reqFor({ email: 'buyer@example.com', saleId: sale.id }, 'shop_vat3'), res);

    const input = (YeboPayClient.createInvoice as any).mock.calls[0][0];
    expect(input.lineItems).toEqual([{ description: 'Bread', quantity: 1, unitPrice: 100 }]);
    expect(input.amountPaid).toBe(100);
  });

  it('no VAT (default 0% shop): behaves exactly as before', async () => {
    seedShop({ id: 'shop_vat4', name: 'Corner Store', countryCode: 'ZA', ownerYeboidSub: 'yeboid_owner_vat4' });
    const sale = seedSale({
      shopId: 'shop_vat4',
      subtotal: 42,
      discount: 0,
      tax: 0,
      totalAmount: 42,
      amountPaid: 42,
      items: [{ productName: 'Bread', quantity: 2, unitPrice: 21, costPrice: 12, totalPrice: 42 }],
    });
    const res = mockRes();

    await SaleController.emailReceipt(reqFor({ email: 'buyer@example.com', saleId: sale.id }, 'shop_vat4'), res);

    const input = (YeboPayClient.createInvoice as any).mock.calls[0][0];
    expect(input.lineItems).toEqual([{ description: 'Bread', quantity: 2, unitPrice: 21 }]);
    expect(input.amountPaid).toBe(42);
  });
});

describe('SaleController.smsReceipt — shows a VAT line when the sale has tax', () => {
  it('prints the shop VAT number alongside the tax amount', async () => {
    seedShop({ id: 'shop_smsvat', name: 'Corner Store', currencySymbol: 'E', taxNumber: 'VAT-12345' });
    const sale = seedSale({
      shopId: 'shop_smsvat',
      totalAmount: 115,
      tax: 15,
      items: [{ productName: 'Bread', quantity: 1, unitPrice: 100, costPrice: 60, totalPrice: 100 }],
    });
    const { calls } = stubFetchOk();
    const res = mockRes();

    await SaleController.smsReceipt(reqFor({ saleId: sale.id, phone: '+26878422613' }, 'shop_smsvat'), res);

    const text: string = calls[0].body.content.text;
    expect(text).toContain('VAT (VAT-12345): E15.00');
    expect(text).toContain('Total: E115.00');
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
