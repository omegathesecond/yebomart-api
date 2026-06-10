# API test suite

Money-critical service tests for yebomart-api. They run against a **real,
disposable Postgres** (not a mocked Prisma) so `prisma.$transaction` blocks,
aggregate/`groupBy` SQL and unique constraints are genuinely exercised.

## What's covered

| Area | File |
|------|------|
| Sale creation: totals/VAT/change, stock decrement + StockLog, offline `localId` idempotency, rejection rollbacks | `services/sale.service.test.ts` |
| Sale creation under concurrency: N same-`localId` replays collapse to one sale | `services/sale.concurrency.test.ts` |
| Returns/exchanges: refund math, restock + StockLog, exchange deduction | `controllers/return.controller.test.ts` |
| Cash drawer: open/close, Z-report reconciliation (`expectedCash = float + cash sales − voids`) | `services/cashSession.service.test.ts` |
| Daily report generation: totals/cost/profit/payment breakdown reconcile with seeded sales | `services/report.service.test.ts` |
| Billing/credit: charge propagation, idempotency-key forwarding, top-up math (YeboPay HTTP client mocked) | `services/billing.service.test.ts` |

## Run locally

```bash
npm test          # one-shot
npm run test:watch
```

By default the suite targets a throwaway local DB:
`postgresql://yebomart_test:yebomart_test@127.0.0.1:5432/yebomart_test`.

Create it once (any disposable Postgres works):

```bash
sudo -u postgres psql -c "CREATE ROLE yebomart_test LOGIN PASSWORD 'yebomart_test' CREATEDB;"
sudo -u postgres createdb -O yebomart_test yebomart_test
```

`globalSetup` runs `prisma db push` to materialise the schema; every test
truncates all tables in `beforeEach`.

## Run in CI / Cloud Build

Point `TEST_DATABASE_URL` at a disposable Postgres (a service container, or the
dev Neon DB) and run `npm test`:

```bash
TEST_DATABASE_URL='postgresql://user:pass@host:5432/yebomart_ci' npm test
```

Safety rail: the harness **refuses to run** unless the target database name
contains `test` (it issues a `TRUNCATE`), unless you set `ALLOW_NONTEST_DB=1`.
This prevents a stray `DATABASE_URL` from ever wiping dev/prod data.

Example GitHub Actions service:

```yaml
services:
  postgres:
    image: postgres:16
    env: { POSTGRES_DB: yebomart_test, POSTGRES_PASSWORD: yebomart_test, POSTGRES_USER: yebomart_test }
    ports: ['5432:5432']
steps:
  - run: npm ci
  - run: npm test
    env:
      TEST_DATABASE_URL: postgresql://yebomart_test:yebomart_test@localhost:5432/yebomart_test
```

> The deploy `cloudbuild.yaml` only builds + deploys the image; it does not run
> tests (a DB-backed step would slow every deploy). Gate merges on a separate
> CI workflow that runs `npm test` against a Postgres service as above.
