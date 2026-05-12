/**
 * Thin client for the centralized YeboPay /v1/* gateway.
 *
 * YeboMart no longer talks to Stripe directly; it asks YeboPay to create a
 * checkout and routes the user to the resulting hosted URL. See
 * companies/yebopay/api/docs/superpowers/specs/2026-05-11-yebomart-yebolearn-cutover-plan.md.
 *
 * Failures throw (no silent fallback per CLAUDE.md); callers must surface the
 * error through the app's normal error path.
 */

const BASE_URL = process.env.YEBOPAY_BASE_URL ?? 'https://yebopay-api-prod-dysic27f5a-ew.a.run.app';

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
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface YeboPayChargeDto {
  id: string;
  status: string;
  amount: string;
  currency: string;
  payment_method: string;
  processor: string;
  external_ref: string | null;
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

  static async sendInvoice(id: string): Promise<YeboPayInvoiceDto> {
    const res = await fetch(`${BASE_URL}/v1/invoices/${encodeURIComponent(id)}/send`, {
      method: 'POST',
      headers: { 'X-API-Key': getApiKey() },
    });
    const body = (await res.json().catch(() => ({}))) as ApiEnvelope<YeboPayInvoiceDto>;
    if (!res.ok || !body.success || !body.data) {
      throw new Error(`YeboPay POST /v1/invoices/${id}/send ${res.status}: ${body.error ?? 'unknown error'}`);
    }
    return body.data;
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

  // Charge (debit) the wallet for a billable action — AI query, comms send, etc.
  // Throws on insufficient balance (402). Callers should map to a user-facing
  // "Top up to continue" prompt.
  static async chargeWallet(input: ChargeWalletInput): Promise<YeboPayChargeDto> {
    const headers: Record<string, string> = {
      'X-API-Key': getApiKey(),
      'Content-Type': 'application/json',
    };
    if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey;

    const res = await fetch(`${BASE_URL}/v1/charges`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        yeboid_sub: input.yeboidSub,
        amount: input.amount,
        currency: 'SZL',
        payment_method: 'WALLET',
        description: input.description,
        metadata: input.metadata,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as ApiEnvelope<YeboPayChargeDto>;
    if (!res.ok || !body.success || !body.data) {
      // 402 = insufficient balance; surface verbatim so caller can route to top-up UI.
      throw new YeboPayChargeError(
        res.status,
        body.error ?? 'Charge failed',
        res.status === 402 ? 'INSUFFICIENT_BALANCE' : 'CHARGE_FAILED'
      );
    }
    return body.data;
  }
}

export class YeboPayChargeError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
    public readonly code: 'INSUFFICIENT_BALANCE' | 'CHARGE_FAILED'
  ) {
    super(message);
    this.name = 'YeboPayChargeError';
  }
}
