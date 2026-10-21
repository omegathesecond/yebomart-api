Run credit concurrency tests against a disposable **local** PostgreSQL database named
`credit_test`. Never supply a production URL. The test config refuses remote hosts
and other database names; it uses the real Prisma client rather than the unit-test fake.

```sh
export CREDIT_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55987/credit_test
DATABASE_URL="$CREDIT_TEST_DATABASE_URL" DIRECT_URL="$CREDIT_TEST_DATABASE_URL" npx prisma db push --skip-generate
npm run test:postgres
```

Use a fresh database with the current Prisma schema. Tests create unique shops,
customers, users and products, then delete only their own fixtures. Both request paths
run concurrently while a third transaction holds the customer row lock. Tests wait
for two blocked PostgreSQL backends before releasing the lock, and verify balances
against the signed ledger plus sale/stock rollback. No production services are called.

For the two-sale case only, a Prisma middleware allocates distinct receipt counts.
This prevents the unrelated receipt unique constraint and retry loop from serializing
the test accidentally. Everything involved in the credit invariant uses real Postgres.
The suite was also run against the pre-fix sale and controller implementations:
all four limit-race tests failed; override and unlimited cases passed.

Rework verification (2026-10-20): merged the shipped all-payment customer
ownership checks and their controller regressions into the credit-locking branch.
Ownership is checked inside the sale transaction before stock or sale writes for
CASH, CARD, MOMO, EMALI, MIXED and CREDIT; credit evaluation still uses the shared
locked ledger helper. The six PostgreSQL tests passed on a fresh local database.

Till transition regressions use the same disposable database and shared lock-race
helper. After `prisma db push`, apply the partial index explicitly (Prisma 5 cannot
represent partial indexes in its schema):

```sh
psql "$CREDIT_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261021000000_one_open_cash_session/migration.sql
npm run test:postgres -- --no-cache
```

`cash-session.test.ts` verifies overlapping opens and closes, direct-write uniqueness,
immutable winning cash-up fields, shop isolation, staff attribution and reopening.
Apply the migration before deploying the API. If existing shops have multiple OPEN
sessions, index creation intentionally fails; reconcile those drawers deliberately
before retrying. The migration never invents counted cash or closes legacy sessions.

`stock.test.ts` uses the same row-lock barrier to coordinate manual removals,
restocks, sale versus restock, and batches supplied in opposite product orders.
It checks the complete stock-log chain against final stock, concurrent cost-change
notes, rejected over-removals, ownership, duplicate rejection, and rollback of a
batch whose later item fails (including cost and log rollback).

Product metadata regressions in `stock.test.ts` also verify edits after sales,
imports with omitted quantity, bulk metadata writes racing sales, and explicit
quantity rejection on all existing-product service paths. Stock corrections use
the existing delta-based Stock Adjustments flow; its sale race checks final stock
and the complete signed log chain. New imports share atomic product + INITIAL log
creation with ordinary new products. Existing import rows containing quantity are
reported as row errors; omit that column for metadata imports.
