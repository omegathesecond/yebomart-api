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
}
