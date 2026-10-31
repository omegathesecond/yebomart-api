# CORS policy rejection incident — 2026-10-31

Task: incident-8372432efb1f7ce25a371b61. Implementation only; review and deployment pending.

Exact Cloud Logging entry `6ae59d840008867b0ceaa3ee` at
`2026-10-31T07:49:24.558715Z`, revision `yebomart-api-prod-00094-l2d`,
reports `Error: Not allowed by CORS` from dist/app.js:46. That revision
still serves 100% at investigation. Fresh origin/main and starting task HEAD
were `14adcba506bd1d34e9f87d405fc032e982f1cee7`; no remote task branch or
local incident changes existed.

The CORS callback passes a generic Error into the central 500 handler.
Read-only live reproduction against GET /api/billing/plans with Origin
https://untrusted.invalid returned 500 without Access-Control-Allow-Origin.
The same endpoint from https://app.yebomart.com, https://admin.yebomart.com,
and https://yebomart.com returned 200 with the corresponding allowed origin.
No customer payload was retained. Nearby provider requests probe .env and
configuration paths; request-level 500s in the surrounding window include
POST /api/graphql and /v1/graphql. The exact stderr entry has no request trace
or origin, so those requests cannot be definitively attributed to this entry.
This evidence does not establish a failed retailer transaction.

Sentry correlation is unavailable: the current ops credential lists eight
projects, none for YeboMart. The API has no Sentry SDK or live SENTRY_DSN.
The existing monitoring-coverage incident owns that gap; an empty project list
is not evidence of recovery.

## Repair

src/app.ts now gates origins before invoking CORS or business routes, using
the existing ApiResponse.forbidden helper. Rejections return success=false,
HTTP 403, and no allow-origin header. A bounded warning keeps the rejection
visible without recording caller-controlled origin contents. Approved origins,
credential headers, preflight, custom allowlists and originless callers retain
their behavior. The allowlist is not expanded and no fake response is returned.

src/app.cors.test.ts exercises the actual production app boundary with only
business routes mocked. Nine cases cover rejection of GET/OPTIONS/POST before
routes, all three public origins, approved preflight, originless requests, and
configured allowlist enforcement. The existing three proxy tests also pass.
Build and targeted lint pass. Complete API suite: 37 files, 545 tests pass
with two existing TODO cases (single fork, cache disabled). Loopback tests require host execution because
sandbox listen returns EPERM; no external services or databases are used.

cloudbuild.yaml already persists --min=0 and --min-instances=0. No runtime,
secret, environment, scaling or resource changes were made; no savings claimed.

## Deployment stage requirements

Use the normal reviewed production pipeline, preserving all additive bindings.
Confirm pushed commit, successful build, Ready revision and exact serving image
separately. Before reporting deployment complete, PATCH task verifyCmd to a
read-only assertion of that exact revision/image and these live operations:

- GET /api/billing/plans with Origin https://untrusted.invalid: HTTP 403,
  success=false, message Not allowed by CORS, no allow-origin header.
- OPTIONS on the same path from that origin: HTTP 403, no allow-origin header.
- Each approved public origin above: HTTP 200, success=true, matching
  allow-origin and allow-credentials=true.
- Approved OPTIONS preflight: HTTP 204, matching origin and allowed method.
- Originless pricing GET: HTTP 200, success=true.
- Service and revision minimum instances remain zero.

Do not substitute an empty later log window for operation verification. Do not
claim a completed deployment from implementation tests or this document.
