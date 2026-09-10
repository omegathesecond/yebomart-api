/**
 * Inbound webhooks. Machine-only, and NOT behind the YeboID/staff auth
 * middleware — each provider authenticates itself with a signature over the
 * raw request body.
 */

import { Router, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { ApiResponse } from '@utils/ApiResponse';
import { markInvoicePaid } from '@services/subscription.service';

const router = Router();

/**
 * Verify YeboPay's `YeboPay-Signature: t=<ts>,v1=<hmac>` header.
 *
 * The HMAC is over `${t}.${rawBody}` keyed with the merchant's webhook secret.
 * The raw bytes matter: `app.ts` stashes them on the request precisely because
 * re-serializing the parsed body would change the signed string.
 */
function verifySignature(req: Request, secret: string): boolean {
  const header = req.header('YeboPay-Signature') ?? '';
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const [k, v] = kv.split('=');
      return [k?.trim(), v?.trim()];
    }),
  ) as { t?: string; v1?: string };

  if (!parts.t || !parts.v1) return false;

  const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (!raw) return false;

  const expected = createHmac('sha256', secret).update(`${parts.t}.${raw.toString('utf8')}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * POST /api/webhooks/yebopay
 *
 * The event we actually depend on is `invoice.paid` — that is what turns a
 * PENDING plan cycle into an ACTIVE one. Everything else is acknowledged and
 * ignored rather than rejected, so YeboPay adding an event type can never
 * start failing deliveries here.
 *
 * YeboPay does not retry failed deliveries, so the renewal cron independently
 * reconciles anything a missed webhook would have stranded.
 */
router.post('/yebopay', async (req: Request, res: Response) => {
  const secret = process.env.YEBOPAY_WEBHOOK_SECRET;
  if (!secret) {
    // Misconfiguration, not an attacker. Fail loud.
    console.error('[webhooks] YEBOPAY_WEBHOOK_SECRET is not configured');
    return ApiResponse.serverError(res, 'Webhook secret not configured');
  }

  if (!verifySignature(req, secret)) {
    console.warn('[webhooks] rejected a YeboPay delivery with a bad signature');
    return ApiResponse.unauthorized(res, 'Invalid signature');
  }

  const type = req.header('YeboPay-Event-Type') ?? (req.body?.type as string | undefined) ?? '';
  const data = (req.body?.data ?? {}) as { id?: string };

  try {
    if (type === 'invoice.paid' && data.id) {
      const matched = await markInvoicePaid(data.id);
      console.log(`[webhooks] invoice.paid ${data.id} — ${matched ? 'plan activated' : 'no matching subscription'}`);
    }
    return ApiResponse.success(res, { received: true, type });
  } catch (err: any) {
    console.error(`[webhooks] handling ${type} failed: ${err?.message ?? err}`);
    return ApiResponse.serverError(res, 'Webhook handling failed');
  }
});

export default router;
