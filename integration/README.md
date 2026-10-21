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

`purchase-order.test.ts` holds the PO row lock until both receipt requests are
blocked in PostgreSQL, then checks full/partial entitlement, duplicates, shop
scope, payable balances and BILL entries. Product-row races also exercise a real
sale and bulk restock against a receipt, checking stock and log continuity. An
invalid staff foreign key verifies that a stock-log failure rolls back quantity,
cost and all receipt/payable writes. No schema migration is needed for this fix.

`supplier-payment.test.ts` uses the shared row-lock race coordinator on the
purchase order. It verifies competing payments, valid partial settlement,
payment/receipt overlap, foreign-shop rejection, history and balanceDue, and
rollback after a real PostgreSQL trigger rejects the final PO update. Receipts
and payments both lock the PO before reading it, then update the supplier. No
migration is needed for this change. The competing-80-payments regression was
also run against the original controller: both requests incorrectly returned 200.

`stock.test.ts` uses the same row-lock barrier to coordinate manual removals,
restocks, sale versus restock, and batches supplied in opposite product orders.
It checks the complete stock-log chain against final stock, concurrent cost-change
notes, rejected over-removals, ownership, duplicate rejection, and rollback of a
batch whose later item fails (including cost and log rollback).

Supplier payment requeue verification (2026-10-21): preserved the existing
implementation and regressions, merged current main, and resolved this document
by retaining both supplier-payment and stock coverage. All 21 PostgreSQL tests
passed together on a fresh local database, including forced payment rollback.

Final supplier-payment verification (2026-10-21): merged main through df68414
without replacing the shipped stock implementation. Build passed; all 21 real
PostgreSQL regressions and 463 unit tests passed (2 existing TODOs). The full
unit suite requires permission to bind its local HTTP test servers.

PO receipt rework verification (2026-10-21): merged main through e8a3c30,
retained stock.service.ts and integration/stock.test.ts exactly from main, and
reused the payable PO lock for receipt entitlement. Receipts lock products in
stable order before atomic increments. All 31 real PostgreSQL regressions pass,
including opposite-order receipt/restock batches, cost-change notes, duplicate
validation, receipt/payment overlap and forced rollback. Build and 463 unit tests
pass (2 existing TODOs). No schema migration is required for the receipt fix.
