/**
 * Thin client for the centralized YeboLink comms gateway (api.yebolink.com).
 *
 * YeboLink is the canonical SMS / WhatsApp / email gateway for every Omevision
 * product. YeboMart uses it to send customer credit statements + payment
 * reminders. There is no shared npm package — the wire protocol IS the SDK, so
 * each product keeps its own copy of this client (mirrors yeboid.client.ts /
 * yebopay.client.ts).
 *
 * Failures throw (no silent fallback per CLAUDE.md); callers must surface the
 * error through the app's normal error path (5xx).
 */

const BASE_URL = process.env.YEBOLINK_API_URL ?? 'https://api.yebolink.com';

function getApiKey(): string {
  const key = process.env.YEBOLINK_API_KEY;
  if (!key) throw new Error('YEBOLINK_API_KEY env var is not set');
  return key;
}

export type YeboLinkChannel = 'sms' | 'whatsapp' | 'email';

export interface YeboLinkSendResult {
  messageId: string;
  status: string;
}

interface SendPayload {
  to: string;
  channel: YeboLinkChannel;
  content: {
    text?: string;
    subject?: string;
    html?: string;
    from_name?: string;
  };
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

const FROM_NAME = 'YeboMart';

async function send(payload: SendPayload): Promise<YeboLinkSendResult> {
  const res = await fetch(`${BASE_URL}/api/v1/messages/send`, {
    method: 'POST',
    headers: { 'X-API-Key': getApiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = (await res.json().catch(() => ({}))) as ApiEnvelope<{
    message_id?: string;
    id?: string;
    status?: string;
  }>;

  if (!res.ok || !body.success || !body.data) {
    throw new Error(
      `YeboLink ${payload.channel} send failed (${res.status}): ${body.error ?? 'unknown error'}`
    );
  }

  return {
    messageId: body.data.message_id ?? body.data.id ?? '',
    status: body.data.status ?? '',
  };
}

export const YeboLinkClient = {
  /** Send an SMS. `to` must be E.164. */
  sendSMS(to: string, text: string, fromName: string = FROM_NAME): Promise<YeboLinkSendResult> {
    return send({ to, channel: 'sms', content: { text, from_name: fromName } });
  },

  /** Send a WhatsApp message. `to` must be E.164. */
  sendWhatsApp(to: string, text: string, fromName: string = FROM_NAME): Promise<YeboLinkSendResult> {
    return send({ to, channel: 'whatsapp', content: { text, from_name: fromName } });
  },

  /** Send an email. `to` must be a valid address. */
  sendEmail(
    to: string,
    subject: string,
    html: string,
    fromName: string = FROM_NAME
  ): Promise<YeboLinkSendResult> {
    return send({ to, channel: 'email', content: { subject, html, from_name: fromName } });
  },

  /*
   * REMOVED: sendTextWithFallback (WhatsApp, then SMS on failure).
   *
   * The fallback was silent in cost, not in logging: one Eswatini SMS segment
   * costs 8 YeboLink credits (~E10) against 1 for a WhatsApp message, and the
   * daily report runs to three segments. A shop whose WhatsApp was unreachable
   * quietly cost ~E30 a night, charged to nobody.
   *
   * Callers now pick a channel explicitly and are charged that channel's rate.
   * If WhatsApp fails, fail loudly rather than spending 8x without being asked.
   */
};
