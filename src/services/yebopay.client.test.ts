/**
 * Wire-contract tests for the YeboPay client.
 *
 * These assert the actual HTTP request that leaves this process — URL, method,
 * body keys — rather than that some mocked method was called. That distinction
 * is the whole point of the file.
 *
 * The credit-debit path sat broken in production for weeks while its tests
 * stayed green: they mocked `YeboPayClient.chargeWallet` and asserted it was
 * called, so they agreed with our assumption about the peer no matter what the
 * peer actually did. YeboPay's Addendum 6 had removed the legacy
 * `payment_method: 'WALLET'` branch from POST /v1/charges, every debit answered
 * 400, and nothing here noticed. A mock can only ever confirm what you already
 * believe; pinning the request is what would have caught it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.YEBOPAY_API_KEY = 'ypk_test_contract_only';
delete process.env.YEBOPAY_BASE_URL;

const { YeboPayClient, YeboPayChargeError } = await import('./yebopay.client');

const SUB = '11111111-1111-1111-1111-111111111111';

/** Stub fetch and hand back the single call it received. */
function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function lastCall(fn: ReturnType<typeof stubFetch>) {
  const [url, init] = (fn.mock.calls.at(-1) ?? []) as unknown as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body ?? '{}')) };
}

afterEach(() => vi.unstubAllGlobals());

describe('base URL', () => {
  it('defaults to the gateway domain, never a raw Cloud Run hostname', async () => {
    const fn = stubFetch(200, { success: true, data: { available: 0, frozen: 0, total: 0, currency: 'SZL' } });
    await YeboPayClient.getBalance(SUB);

    const { url } = lastCall(fn);
    expect(url).toContain('https://api.yebopay.app/');
    // `.com` is an unrelated third party; `run.app` breaks on any rename or
    // re-region of the service and gives no warning when it does.
    expect(url).not.toContain('run.app');
    expect(url).not.toContain('yebopay.com');
  });
});

describe('debitWallet', () => {
  const OK = {
    success: true,
    data: {
      replayed: false,
      transaction: { id: 'ctx_1', type: 'DEBIT', ref_type: 'MERCHANT_CHARGE', amount: 3 },
      balance: { available: 97, frozen: 0, total: 97, currency: 'SZL' },
    },
  };

  it('posts to the wallet adjustments endpoint, NOT the charges endpoint', async () => {
    const fn = stubFetch(201, OK);
    await YeboPayClient.debitWallet({ yeboidSub: SUB, amount: 3, description: 'WhatsApp statement' });

    const { url, init } = lastCall(fn);
    expect(url).toBe('https://api.yebopay.app/wallet/v1/adjustments');
    expect(init.method).toBe('POST');
    // The regression guard: /v1/charges has had no wallet branch since
    // Addendum 6 and answers 400 for this shape.
    expect(url).not.toContain('/v1/charges');
  });

  it('sends a NEGATIVE amount, so the signed field debits rather than credits', async () => {
    const fn = stubFetch(201, OK);
    await YeboPayClient.debitWallet({ yeboidSub: SUB, amount: 3, description: 'WhatsApp statement' });

    expect(lastCall(fn).body.amount).toBe(-3);
  });

  it('still debits when a caller passes an already-negative cost', async () => {
    // Signed amounts make a double negative a CREDIT — i.e. silently handing
    // out free credits. Math.abs in the client makes that unreachable.
    const fn = stubFetch(201, OK);
    await YeboPayClient.debitWallet({ yeboidSub: SUB, amount: -3, description: 'oops' });

    expect(lastCall(fn).body.amount).toBe(-3);
  });

  it('tags usage as MERCHANT_CHARGE so it stays out of the operator audit trail', async () => {
    const fn = stubFetch(201, OK);
    await YeboPayClient.debitWallet({ yeboidSub: SUB, amount: 1, description: 'AI assistant: chat' });

    const { body } = lastCall(fn);
    expect(body.ref_type).toBe('MERCHANT_CHARGE');
    expect(body.reason).toBe('AI assistant: chat');
  });

  it('carries the idempotency key as external_ref, not as a header', async () => {
    // /wallet/v1/adjustments dedupes on (yeboid_sub, external_ref, ref_type)
    // and ignores Idempotency-Key entirely. Sending it as a header only would
    // leave every retry free to debit again.
    const fn = stubFetch(201, OK);
    await YeboPayClient.debitWallet({
      yeboidSub: SUB, amount: 1, description: 'AI', idempotencyKey: 'shop_1:/api/ai/chat:17',
    });

    const { body, init } = lastCall(fn);
    expect(body.external_ref).toBe('shop_1:/api/ai/chat:17');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBeUndefined();
  });

  it('maps 409 to INSUFFICIENT_BALANCE so callers can prompt a top-up', async () => {
    stubFetch(409, { success: false, error: 'Cannot debit 5 — wallet holds only 2', code: 'INSUFFICIENT_BALANCE' });

    await expect(
      YeboPayClient.debitWallet({ yeboidSub: SUB, amount: 5, description: 'AI' }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE', httpStatus: 409 });
  });

  it('maps 404 to WALLET_NOT_FOUND', async () => {
    stubFetch(404, { success: false, error: 'No wallet exists for that yeboid_sub', code: 'WALLET_NOT_FOUND' });

    await expect(
      YeboPayClient.debitWallet({ yeboidSub: SUB, amount: 1, description: 'AI' }),
    ).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
  });

  it('throws rather than reporting a debit that never happened', async () => {
    // CLAUDE.md: no silent fallbacks. A 400 must never read as success.
    stubFetch(400, { success: false, error: 'ref_type must be one of: ...' });

    await expect(
      YeboPayClient.debitWallet({ yeboidSub: SUB, amount: 1, description: 'AI' }),
    ).rejects.toBeInstanceOf(YeboPayChargeError);
  });
});

describe('invoices', () => {
  it('always sends due_date — POST /v1/invoices 400s without it', async () => {
    // Typed required in CreateInvoiceInput precisely because an optional field
    // is dropped by JSON.stringify when undefined, which 400s every invoice.
    const fn = stubFetch(201, { success: true, data: { id: 'inv_1', number: 'INV-1' } });
    await YeboPayClient.createInvoice({
      yeboidSub: SUB,
      currency: 'SZL',
      dueDate: '2026-10-01T00:00:00.000Z',
      lineItems: [{ description: 'Plan', quantity: 1, unitPrice: 250 }],
      toEmail: 'shop@example.com',
    });

    const { body } = lastCall(fn);
    expect(body.due_date).toBe('2026-10-01T00:00:00.000Z');
    expect(Object.keys(body)).toContain('due_date');
  });

  it('reads the pay URL from the sibling `delivery` key, not from `data`', async () => {
    // `data` IS the invoice; the URLs live beside it. Reading data.payUrl
    // yields undefined and strands the customer with an unpayable invoice.
    stubFetch(200, {
      success: true,
      data: { id: 'inv_1', number: 'INV-1', status: 'SENT' },
      delivery: { payUrl: 'https://yebopay.app/checkout/abc', pdfUrl: 'https://x/y.pdf', emailQueued: true, messageId: 'm_1' },
    });

    const sent = await YeboPayClient.sendInvoice('inv_1');
    expect(sent.payUrl).toBe('https://yebopay.app/checkout/abc');
    expect(sent.invoice.number).toBe('INV-1');
  });

  it('throws when delivery.payUrl is missing rather than storing undefined', async () => {
    stubFetch(200, { success: true, data: { id: 'inv_1' }, delivery: { emailQueued: true } });

    await expect(YeboPayClient.sendInvoice('inv_1')).rejects.toThrow(/no delivery.payUrl/);
  });

  it('fetches one invoice for reconciliation', async () => {
    const fn = stubFetch(200, { success: true, data: { id: 'inv_1', status: 'PAID' } });
    const inv = await YeboPayClient.getInvoice('inv_1');

    expect(lastCall(fn).url).toBe('https://api.yebopay.app/v1/invoices/inv_1');
    expect(inv.status).toBe('PAID');
  });
});
