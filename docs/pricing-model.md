# YeboMart pricing — cost basis and the plan model

Status: cost fixes shipped on `pricing/stop-the-bleed`. Subscription tier below is designed, not built.

## Cost basis

One YeboMart credit is E1, about USD 0.055 (SZL is pegged 1:1 to ZAR).
YeboLink sells credits at USD 0.070 (deepest pack) to 0.080 (list); its own
policy is a 50% margin floor over Twilio, so its price is our floor.

| Action | Landed cost | = SZL | We charge | Margin |
|---|---|---|---|---|
| Assistant question (Gemini Flash, capped prompt) | < $0.001 | E0.02 | 1 credit | 98% |
| Email (Resend via YeboLink, 0.1 credit) | $0.007 | E0.13 | 1 credit | 87% |
| WhatsApp (1 YeboLink credit) | $0.070 | E1.27 | 3 credits | 58% |
| SMS, Eswatini (8 YeboLink credits/segment) | $0.560 | E10.18 | 20 credits | 49% |

SMS is expensive because it is expensive. One Eswatini segment costs eight
times a WhatsApp message; Kenya is 9 credits, Nigeria 12, and an unrecognised
destination 23. Pricing SMS at parity with WhatsApp lost roughly E9 a send.

## What was losing money (fixed)

1. **Silent SMS fallback.** `sendTextWithFallback` tried WhatsApp then SMS. A
   shop with unreachable WhatsApp cost about E30 a night on a three-segment
   daily report, charged to nobody. Removed; callers pick a channel.
2. **Messaging charged nothing.** Only the AI routes called
   `requireCreditBalance`. SMS receipts, customer statements, daily reports and
   low-stock alerts were all free to the shop and billed to us.
3. **Prices below cost.** SMS at 1 credit, WhatsApp at 2.
4. **A Pro tier that was never served.** Chat and voice billed `AI_PRO` while
   both call sites hardcode `gemini-2.0-flash`.

## What is still loss-making

The daily report and low-stock alert now go by WhatsApp only, but the cron
still charges nothing: about E1.27 a day, roughly **E38 per shop per month**.
Down from ~E900 on the SMS path, but it is the largest remaining hole and it
scales linearly with shops.

## The plan model (designed, not built)

The strategic error is that we meter the thing that costs nothing (AI) and give
away the thing that costs the most (messages). Invert it: make the assistant
generous because it is nearly free to serve, and charge a subscription for the
messages a shop receives every day.

| Plan | Price | Included | Landed cost | Margin |
|---|---|---|---|---|
| Till | Free | Everything in-app; 20 assistant questions/mo | infrastructure only | acquisition |
| Shop | E199/mo | Daily WhatsApp report, low-stock alerts, unlimited assistant, 30 customer messages | ~$5.00 | 55% |
| Busy | E499/mo | 150 customer messages, priority support | ~$14.00 | 49% |

Overage stays pay-as-you-go at the credit rates above.

Why the daily report is the product: it is the one paid thing a shop uses every
single day without deciding to. That is a subscription in all but name, and it
is far more predictable than ad-hoc questions.

## To build

1. `Plan` + `ShopSubscription` models; entitlement checks in place of raw
   balance checks for included actions.
2. Monthly allowance metering with reset, and overage falling through to credits.
3. Recurring billing through YeboPay (today `createCheckout` is one-shot,
   hardcoded `currency: 'SZL'`).
4. Charge or entitle the notification cron, which currently does neither.
5. Destination-aware SMS pricing. The flat 20 credits covers one Eswatini
   segment; Kenya, Nigeria and long messages still cost more than we charge.

## Open, and not a code decision

The landing quotes prices in 22 currencies while checkout hardcodes SZL, so the
local figures are estimates presented as prices. The rate table also has two
provable errors: South Africa at 1.3 when the Lilangeni is pegged 1:1 to the
Rand (Lesotho and Namibia are correctly at 1.0), and Senegal and Ivory Coast
carrying different rates for the same XOF currency.
