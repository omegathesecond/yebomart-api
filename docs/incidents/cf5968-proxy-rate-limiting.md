# Cloud Run proxy identity incident — 2026-10-29

Task: incident-cf5968f2b17863762e931695 (implementation; review and deployment pending).

## Provider evidence and impact

Exact Cloud Logging insertId `6ae33af0000b4da5bb7123f0`, timestamp
`2026-10-29T12:24:16.740773Z`, revision
`yebomart-api-prod-hn1029-c0b28c` reports
`ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`. Express `trust proxy` was false.
The correlated request was `GET /api/billing/plans` from the landing page,
HTTP 200. This is a client-identity/rate-limit defect, not evidence that
pricing returned a 5xx. Express used the ingress socket IP, so unrelated
clients could share rate-limit buckets (including the staff login limiter).

The API domain maps directly to `yebomart-api-prod`, CNAME
`ghs.googlehosted.com`. At investigation the revision above served 100% of
traffic with image digest
`ffd5eb791a877868e5dbb49a2365729a363eda690047ab9111c7e756fb76828b`,
matching the prior release, not a newer fix. Fetched origin/main was
`98c4d750663769d41dfc4b14de8483b55c5ef0ea`; local task branch had no changes
and no remote task branch existed.

Read-only live baseline: pricing HTTP 200, success=true and data object;
`GET /api/auth/me` without credentials HTTP 401. No customer payloads retained.

Sentry correlation is unavailable: the existing Sentry ops credential returned
eight accessible projects, none for YeboMart, and the API has no Sentry SDK or
DSN wiring. Do not describe an empty Sentry search as proof of recovery. A
separate monitoring-coverage incident branch already exists; do not duplicate
that work here.

## Repair and reproduction

`src/app.proxy.test.ts` exercises the production Express app and real standard
limiter over loopback, with only business routes replaced by a read-only probe.
Before the fix, the regression failed: client `192.0.2.10` resolved to
`127.0.0.1`; different forwarded clients shared the same limiter bucket. After
the fix, each client starts with 9999 requests remaining; a forged prefix
before the first client's address consumes that client's existing bucket
(9998), rather than creating a fresh identity. Tests also cover missing
forwarding headers and direct non-Cloud-Run operation.

`src/app.ts` trusts exactly one ingress hop when the Cloud Run-provided
`K_SERVICE` exists, taking the rightmost forwarded address. It never trusts
all forwarded addresses or a caller-supplied prefix. Other runtimes retain
direct socket identity. All existing limiters use Express's resolved identity;
no duplicate key generator or disabled validation is introduced.

`cloudbuild.yaml` explicitly persists service and revision minimum instances
as zero using `--min=0` and `--min-instances=0`. Existing additive environment
and secret bindings remain intact. No resource rightsizing or savings claim.

Reference: https://expressjs.com/en/guide/behind-proxies.html and
https://github.com/express-rate-limit/express-rate-limit/wiki/Troubleshooting-Proxy-Issues

Validation: API build passed; 36 test files passed, 536 tests passed and two
existing todo tests; targeted ESLint passed for both changed TypeScript files.
The client-identity regression was observed failing before the fix and passing
after it.

## Review/deploy handoff

Do not merge from the implementation stage. Review the one-hop boundary and
client-isolation regression, then ship using the existing production pipeline.
No schema changes or migrations.

Deployment stage must independently verify the successful build's exact
commit/image digest against the Ready revision and 100% production traffic;
confirm both service-level and revision-level minimum instances are zero.
Before signalling deployment complete, PATCH this task's `verifyCmd` to a
read-only assertion tied to that released commit/revision/digest and run it.
It must perform the actual public `GET /api/billing/plans` with the landing's
Origin, assert HTTP 200, success=true and a nonempty plans array, and verify
that changing caller-supplied X-Forwarded-For prefixes cannot reset the rate
bucket. Use the released image to repeat the isolated-client regression as
well. Check the same revision's provider logs for validation errors correlated
with these requests; an empty later error window alone is insufficient.
Keep all verification read-only (no payments, customer writes or notifications).
If external routing adds another proxy, measure the actual chain before
changing the trust boundary; never set trust proxy=true.

Implementation evidence does not establish production recovery. Live repaired
operation and deployment evidence belong to the deployment stage.
