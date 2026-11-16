# Restaurant flow release

This release adds opt-in restaurant work to the existing YeboMart workspace. The owner selects activities in Workspace settings. Server-provided navigation and direct API authorization use the current business modules and staff duty; kitchen colleagues cannot read financial reports or collect payments.

## Customer and staff journey

Save restaurant hours and preparation capacity, photograph one menu section, review every extracted item and uncertain price, and confirm the import. Imports reuse ProductService inside a transaction. Dishes are made to order (`trackStock=false`); existing counted products retain their stock rules. Costs left blank are explicitly unknown, including on sale snapshots and profit reports.

Publish the included website at `https://app.yebomart.com/r/<slug>`. Generate a general or table-specific QR code in setup. Guests choose available items, a server-validated preparation slot, their contact details and an optional WhatsApp consent. They review the total before placing an idempotent order. Kitchen acceptance, preparation, ready and handover are separate steps. Cash is recorded only after a counter colleague enters the amount received. SaleService remains the stock/accounting writer, with frozen order prices and tax.

Online card checkout uses an encrypted, restaurant-owned YeboPay key; the YeboMart software-billing key never receives restaurant takings. The checkout must match amount, currency and charge reference before marking paid. Ambiguous checkout creation is held for reconciliation and never blindly retried. Paid/ambiguous orders cannot be cancelled by pretending a refund occurred; resolve refunds through YeboPay before any operational correction. Automatic in-app refund orchestration is outside this release.

Reports show recorded payments, open/unpaid orders, completed dishes, preparation time and reconciliation actions. Owners/managers can opt in to daily, Monday weekly and daily insight reports through WhatsApp or email. WhatsApp draws existing plan allowances; emails use the existing EMAIL credit price. Failed/uncertain sends remain visible in message history. Accepted means provider acceptance, not delivered. There is no SMS fallback. Public menu answers use only the approved live menu and produce editable suggestions, never autonomous orders or allergy guarantees.

## Connections and deployment

- YeboAI restaurant endpoints use a dedicated `YEBOMART__YEBOAI_API_KEY`, bound as `YEBOMART_API_KEY` in the shared AI service and `YEBOAI_API_KEY` in Mart.
- Mart requires `YEBOAI_BASE_URL` pointing to the isolated restaurant AI revision, `RESTAURANT_PUBLIC_ORIGIN=https://app.yebomart.com`, and `RESTAURANT_CREDENTIAL_KEY` bound to `YEBOMART__RESTAURANT_CREDENTIAL_KEY`.
- Existing unrelated env/secret settings and all shared-AI traffic tags must be preserved. Restaurant AI deploys with zero default traffic and its own tag.
- Apply `20261116020000_restaurant_workspace` before routing dependent API code. Use the explicit VPC-connected migration job if the pinned SSH tunnel is unavailable; use the direct migrator credential, never the pooled application credential or a public database firewall rule.
- Authenticated scheduler: `POST /api/internal/restaurant/run`, existing `X-Internal-Secret`, every five minutes. Reconciles known checkouts, queues opted-in local-time reports and dispatches pending messages. Uncertain attempts are held, not retried.
- Tenant activation needs the business's own menu/hours/public phone. Online payment additionally needs its verified merchant key with `checkouts.write` and `wallet.read` access. These are setup requirements, not hardcoded shared merchant credentials.

## Validation

API regression suite, disposable local PostgreSQL order/import/payment/authorization tests and full transaction suite. Shared AI offline suite includes product-key isolation, unclear menu prices, visible provider failure and invalid suggestion rejection. Browser and deployed revision evidence is recorded separately after rollout. Synthetic provider tests do not prove live card settlement, WhatsApp delivery or physical POS hardware.
