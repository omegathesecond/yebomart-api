/**
 * Thin client for the centralized YeboPay /v1/* gateway.
 *
 * YeboMart asks YeboPay to create a checkout, fetch wallet balance, charge
 * credits, etc. — yebopay handles the payment processor internally. See
 * companies/yebopay/api/docs/superpowers/specs/2026-05-11-yebomart-yebolearn-cutover-plan.md.
 *
 * Failures throw (no silent fallback per CLAUDE.md); callers must surface the
 * error through the app's normal error path.
 */

/**
 * The gateway's own domain, never the raw Cloud Run hostname it happens to sit
 * behind today. `*.run.app` URLs are an implementation detail: they change if
 * the service is renamed, re-regioned or re-projected, and nothing warns you.
 * The domain is `.app` — `api.yebopay.com` is an unrelated third party.
 *
 * Dev overrides this to https://dev-api.yebopay.app; prod sets nothing and
 * takes the default.
 */
const BASE_URL = process.env.YEBOPAY_BASE_URL ?? 'https://api.yebopay.app';

function getApiKey(): string {
  const key = process.env.YEBOPAY_API_KEY;
  if (!key) throw new Error('YEBOPAY_API_KEY env var is not set');
  return key;
}

export interface CreateCheckoutInput {
  amount: number;
  currency: string;
  yeboidSub?: string | null;
  paymentMethod?: 'CARD' | 'MTN_MOMO' | 'SWYCHR' | 'WALLET';
  successUrl: string;
  cancelUrl: string;
  description?: string;
  email?: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
  invoiceId?: string;
}

export interface CreateInvoiceInput {
  yeboidSub: string;
  currency: string;
  dueDate: string; // ISO-8601
  lineItems: Array<{ description: string; quantity: number; unitPrice: number }>;
  toEmail: string;
  toName?: string;
  description?: string;
  status?: 'DRAFT' | 'PAID'; // PAID for POS receipts
  paidAt?: string; // ISO-8601, only used when status=PAID
  amountPaid?: number; // only used when status=PAID
  metadata?: Record<string, string>;
}

export interface YeboPayInvoiceDto {
  id: string;
  number: string;
  status: 'DRAFT' | 'SENT' | 'PAID' | 'VOID' | 'OVERDUE';
  amount_due: string;
  amount_paid: string;
  currency: string;
  pdf_url: string | null;
  sent_at: string | null;
  paid_at: string | null;
  to_email: string | null;
  charge_id: string | null;
}

/**
 * `POST /v1/invoices/:id/send` returns the invoice under `data` and the
 * delivery artefacts under a SIBLING `delivery` key — NOT nested inside
 * `data`. Reading `data.payUrl` yields undefined and strands the customer
 * with an invoice they cannot pay (this exact shape took down Eneza's
 * payments in 2026-08). Typed explicitly so that cannot recur.
 */
export interface YeboPaySendInvoiceResult {
  invoice: YeboPayInvoiceDto;
  pdfUrl: string | null;
  payUrl: string;
  emailQueued: boolean;
  messageId: string | null;
}

export interface YeboPayBalanceDto {
  available: number;
  frozen: number;
  total: number;
  currency: string;
}

export interface ChargeWalletInput {
  yeboidSub: string;
  amount: number;
  description: string;
  /**
   * Dedupe handle. Sent as `external_ref`, NOT as an `Idempotency-Key` header:
   * /wallet/v1/adjustments dedupes on (yeboid_sub, external_ref, ref_type) and
   * ignores the header entirely.
   */
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

/** One row of the YeboPay wallet ledger. */
export interface YeboPayLedgerEntryDto {
  id: string;
  type: 'CREDIT' | 'DEBIT';
  ref_type: string;
  amount: number;
  balance_before: number;
  balance_after: number;
  description: string | null;
  external_ref: string | null;
  merchant_app: string | null;
  created_at: string;
}

export interface YeboPayWalletDebitResult {
  /** True when YeboPay replayed an existing row rather than moving money again. */
  replayed: boolean;
  transaction: YeboPayLedgerEntryDto;
  balance: YeboPayBalanceDto;
}

export interface YeboPayCheckoutDto {
  id: string;
  hosted_url: string | null;
  expires_at: string;
  status: 'OPEN' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED';
  payment_method: string | null;
  processor: string | null;
  amount?: string;
  currency?: string;
  charge_id?: string | null;
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export class YeboPayClient {
  static async createCheckout(input: CreateCheckoutInput): Promise<YeboPayCheckoutDto> {
    const headers: Record<string, string> = {
      'X-API-Key': getApiKey(),
      'Content-Type': 'application/json',
    };
    if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey;

    const res = await fetch(`${BASE_URL}/v1/checkouts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        amount: input.amount,
        currency: input.currency,
        yeboid_sub: input.yeboidSub ?? null,
        payment_method: input.paymentMethod ?? 'CARD',
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        description: input.description,
        email: input.email,
        metadata: input.metadata,
        invoice_id: input.invoiceId,
      }),
    });

    const body = (await res.json().catch(() => ({}))) as ApiEnvelope<YeboPayCheckoutDto>;
    if (!res.ok || !body.success || !body.data) {
      throw new Error(`YeboPay POST /v1/checkouts ${res.status}: ${body.error ?? 'unknown error'}`);
    }
    return body.data;
  }

  static async getCheckout(id: string): Promise<YeboPayCheckoutDto> {
    const res = await fetch(`${BASE_URL}/v1/checkouts/${encodeURIComponent(id)}`, {
      headers: { 'X-API-Key': getApiKey() },
    });
    const body = (await res.json().catch(() => ({}))) as ApiEnvelope<YeboPayCheckoutDto>;
    if (!res.ok || !body.success || !body.data) {
      throw new Error(`YeboPay GET /v1/checkouts/${id} ${res.status}: ${body.error ?? 'unknown error'}`);
    }
    return body.data;
  }

  static async createInvoice(input: CreateInvoiceInput): Promise<YeboPayInvoiceDto> {
    const res = await fetch(`${BASE_URL}/v1/invoices`, {
      method: 'POST',
      headers: { 'X-API-Key': getApiKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        yeboid_sub: input.yeboidSub,
        currency: input.currency,
        due_date: input.dueDate,
        line_items: input.lineItems,
        to_email: input.toEmail,
        to_name: input.toName,
        description: input.description,
        status: input.status,
        paid_at: input.paidAt,
        amount_paid: input.amountPaid,
        metadata: input.metadata,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as ApiEnvelope<YeboPayInvoiceDto>;
    if (!res.ok || !body.success || !body.data) {
      throw new Error(`YeboPay POST /v1/invoices ${res.status}: ${body.error ?? 'unknown error'}`);
    }
    return body.data;
  }

  /**
   * Fetch one invoice. This is the POLL half of the paid/not-paid question.
   *
   * YeboPay does not retry a failed webhook delivery, so `invoice.paid` is
   * best-effort: a shop can pay and the event never arrive. Anything that
   * would penalise a shop for not paying has to check here first rather than
   * trusting the absence of a webhook.
   */
  static async getInvoice(id: string): Promise<YeboPayInvoiceDto> {
    const res = await fetch(`${BASE_URL}/v1/invoices/${encodeURIComponent(id)}`, {
      headers: { 'X-API-Key': getApiKey() },
    });
    const body = (await res.json().catch(() => ({}))) as ApiEnvelope<YeboPayInvoiceDto>;
    if (!res.ok || !body.success || !body.data) {
      throw new Error(`YeboPay GET /v1/invoices/${id} ${res.status}: ${body.error ?? 'unknown error'}`);
    }
    return body.data;
  }

  static async sendInvoice(id: string): Promise<YeboPaySendInvoiceResult> {
    const res = await fetch(`${BASE_URL}/v1/invoices/${encodeURIComponent(id)}/send`, {
      method: 'POST',
      headers: { 'X-API-Key': getApiKey() },
    });
    const body = (await res.json().catch(() => ({}))) as ApiEnvelope<YeboPayInvoiceDto> & {
      delivery?: { pdfRendered?: boolean; emailQueued?: boolean; pdfUrl?: string; payUrl?: string; messageId?: string };
    };
    if (!res.ok || !body.success || !body.data) {
      throw new Error(`YeboPay POST /v1/invoices/${id}/send ${res.status}: ${body.error ?? 'unknown error'}`);
    }

    const payUrl = body.delivery?.payUrl;
    if (!payUrl) {
      // The invoice HAS been created and emailed by this point; refusing to
      // return a half-answer is deliberate. Callers persist the invoice id
      // before calling send, so the row is recoverable.
      throw new Error(`YeboPay POST /v1/invoices/${id}/send returned no delivery.payUrl`);
    }

    return {
      invoice: body.data,
      pdfUrl: body.delivery?.pdfUrl ?? null,
      payUrl,
      emailQueued: Boolean(body.delivery?.emailQueued),
      messageId: body.delivery?.messageId ?? null,
    };
  }

  // Get the wallet balance for a yeboid_sub (synthetic or real).
  // Use this to render "X credits remaining" UI in yebomart.
  static async getBalance(yeboidSub: string): Promise<YeboPayBalanceDto> {
    const url = `${BASE_URL}/wallet/v1/balance?yeboid_sub=${encodeURIComponent(yeboidSub)}`;
    const res = await fetch(url, { headers: { 'X-API-Key': getApiKey() } });
    const body = (await res.json().catch(() => ({}))) as ApiEnvelope<YeboPayBalanceDto>;
    if (!res.ok || !body.success || !body.data) {
      throw new Error(`YeboPay GET /wallet/v1/balance ${res.status}: ${body.error ?? 'unknown error'}`);
    }
    return body.data;
  }

  /**
   * Debit the shop owner's YeboPay wallet for a billable action (AI question,
   * SMS receipt, WhatsApp statement).
   *
   * This used to be `POST /v1/charges` with `payment_method: 'WALLET'`.
   * YeboPay's Addendum 6 removed that legacy enum path — the route now demands
   * a `payment_method_id` or a `country`+`provider_code` pair, neither of which
   * describes "take it off the balance they already hold". Every YeboMart debit
   * had been answering 400 ever since, and because `settlePendingCharge`
   * deliberately does not fail a request whose work is already done, the shop
   * silently stopped being billed at all.
   *
   * The wallet's supported mutation is now `POST /wallet/v1/adjustments`:
   * a SIGNED amount, so a debit is a negative one. `ref_type: MERCHANT_CHARGE`
   * keeps usage out of the operator-adjustment audit trail.
   *
   * Idempotency is `external_ref`, not a header — YeboPay looks for an existing
   * row on (yeboid_sub, external_ref, ref_type) and replays it rather than
   * debiting twice.
   *
   * Throws `YeboPayChargeError` with code='INSUFFICIENT_BALANCE' on 409 so
   * callers can route to the top-up prompt.
   */
  static async debitWallet(input: ChargeWalletInput): Promise<YeboPayWalletDebitResult> {
    const res = await fetch(`${BASE_URL}/wallet/v1/adjustments`, {
      method: 'POST',
      headers: { 'X-API-Key': getApiKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        yeboid_sub: input.yeboidSub,
        // Negative = debit. Math.abs first so a caller that already passed a
        // negative cost cannot accidentally CREDIT the wallet.
        amount: -Math.abs(input.amount),
        reason: input.description,
        ref_type: 'MERCHANT_CHARGE',
        external_ref: input.idempotencyKey,
        metadata: input.metadata,
      }),
    });

    const body = (await res.json().catch(() => ({}))) as ApiEnvelope<YeboPayWalletDebitResult> & {
      code?: string;
    };
    if (!res.ok || !body.success || !body.data) {
      throw new YeboPayChargeError(
        res.status,
        body.error ?? 'Wallet debit failed',
        body.code === 'INSUFFICIENT_BALANCE' || res.status === 409
          ? 'INSUFFICIENT_BALANCE'
          : body.code === 'WALLET_NOT_FOUND' || res.status === 404
            ? 'WALLET_NOT_FOUND'
            : 'CHARGE_FAILED',
      );
    }
    return body.data;
  }
}

export class YeboPayChargeError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
    public readonly code: 'INSUFFICIENT_BALANCE' | 'WALLET_NOT_FOUND' | 'CHARGE_FAILED',
  ) {
    super(message);
    this.name = 'YeboPayChargeError';
  }
}
