# Cloud Run forwarded-header rate-limit incident

## Provider evidence and scope

Exact entry `6ae28c800006c6d31dc1150b`, 2026-10-29T00:00:00.444115Z,
project hiyebo, service yebomart-api-prod, revision 00092-7lp:
`ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` from express-rate-limit's default
IP key generator because Express trust proxy was false.

The correlated request was POST /api/internal/billing/run at
00:00:00.387486Z, HTTP 200. This is a limiter configuration defect, not
evidence of a failed billing charge. Do not rerun that scheduled operation
as an incident probe: it can perform billing work. Standard, auth, POS and
AI limiters all use the default req.ip key and share this configuration.

The authenticated central Sentry project registry was queried successfully.
It contains heygeorge and seven yebolearn projects, no yebomart project.
The supported YeboMart project query returned explicit HTTP 404
PROJECT_NOT_FOUND. Sentry correlation is unavailable, not zero issues.
No ingestion integration or fabricated correlation was added in this fix.

Public GET /api/billing/plans returned HTTP 200 and success:true through
both the custom domain and the service run.app URL before the repair.
This does not establish correct per-client rate limiting.

## Repair and reproduction

Set Express trust proxy to one hop before middleware registration. Cloud Run
is the only supported runtime and every public path terminates at its ingress.
Only the nearest forwarded address determines req.ip; caller-controlled
prefixes are ignored. Never replace this with boolean true. An additional
external proxy will be treated as the client; do not increase hop counts
without verifying every ingress path, including the direct run.app URL.

References:
- https://expressjs.com/en/guide/behind-proxies/
- https://docs.cloud.google.com/run/docs/triggering/https-request

The real application and real standard/auth limiters are exercised over
loopback HTTP; only the route handler is substituted, with no DB/provider
access. Before the fix, all three regression cases fail, the exact provider
validation is emitted, and distinct forwarded clients exhaust the same auth
bucket. After the fix, client IP extraction, isolation, 429 enforcement,
prefix spoof resistance and requests without a forwarded header pass.
The synthetic route exists only in the test mock, never in production.

cloudbuild.yaml explicitly preserves zero service and revision minimum
instances. Existing workload sizing, secrets and environment bindings remain
in place. No savings are claimed.

Implementation validation: 36 suites, 536 tests pass, 2 existing todo;
production TypeScript build passes. No migrations required.

## Review and deployment handoff

This is an IMPLEMENT-stage branch. Do not confuse its push with deployment.
Review first, then use the normal main/Cloud Build pipeline. Do not manually
redeploy a service or merge during implementation.

Before signalling deployment completion, PATCH this existing task's verifyCmd
to a read-only command using the exact released production commit:

    python3 scripts/verify-proxy-release.py <full-production-commit-sha> <production-build-id>

Use the API repository checkout as the command's working directory (or an
absolute script path on the fleet). The script asserts a successful production
build for that SHA, matching live image digest, a Ready revision at 100%
traffic, zero minimum instances, readiness and the real public plans journey
through both supported production hostnames. It changes spoofed XFF prefixes
and asserts the same client bucket continues to decrement; it never invokes
the billing runner, creates sales, sends OTPs or initiates payments.

A shared proxy bucket can also decrement: live HTTP status/counters alone
cannot establish client separation. Independently rerun app.proxy.test.ts on
the exact released source and, where two existing fleet egress IPs are
available, compare their read-only plans request counters. Confirm actual
forwarded-address topology before increasing trust. Inspect the exact probe
requests' provider diagnostics as supporting evidence; an empty later log
window is never sufficient proof. Keep Sentry's coverage gap explicit.
