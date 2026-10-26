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

Product metadata regressions in `stock.test.ts` also verify edits after sales,
imports with omitted quantity, bulk metadata writes racing sales, and explicit
quantity rejection on all existing-product service paths. Stock corrections use
the existing delta-based Stock Adjustments flow; its sale race checks final stock
and the complete signed log chain. New imports share atomic product + INITIAL log
creation with ordinary new products. Existing import rows containing quantity are
reported as row errors; omit that column for metadata imports.

Supplier payment requeue verification (2026-10-21): preserved the existing
implementation and regressions, merged current main, and resolved this document
by retaining both supplier-payment and stock coverage. All 21 PostgreSQL tests
passed together on a fresh local database, including forced payment rollback.

Final supplier-payment verification (2026-10-21): merged main through df68414
without replacing the shipped stock implementation. Build passed; all 21 real
PostgreSQL regressions and 463 unit tests passed (2 existing TODOs). The full
unit suite requires permission to bind its local HTTP test servers.

Product stock-edit requeue verification (2026-10-21): merged current main while
retaining product attributes/bulk pricing, supplier payment locking and all shipped
stock protections. Both component builds, 463 API unit tests (2 existing TODOs),
10 ProductForm payload tests and all 28 real PostgreSQL tests passed. The Postgres
run used a fresh local database with the open-till partial index applied.

`store-credit-return.test.ts` covers paid-sale store credit using the existing return
entitlement allocation (including line/order discounts, VAT, product boundaries,
partial/final returns and shared cash-refund reservations). It checks shop-scoped
recipients, paid-receipt revalidation, rejection of receiptless/unbooked-CREDIT/exchange
combinations, retries, forced competing completions, concurrent customer ledger
writes and rollback after injected ledger and final-status failures.

Apply `20261026000000_return_account_credit` before deploying this API. It adds
the return's customer relation; the shared unique `CustomerCredit.returnId` link
is added by `20261026000000_return_credit_reversal`. Existing returns are not credited or revalued by the migration; an old
zero-value STORE_CREDIT reservation fails validation instead of silently posting
an invented amount. CREDIT-sale debt settlement remains a separate operation.

Store-credit verification (2026-10-26): API and app builds passed; 465 API unit
tests passed (2 existing TODOs), and all 38 PostgreSQL tests passed, including
10 store-credit regressions. Applied the new SQL migration to a second disposable
database built from the original main schema; Prisma migrate diff reported no
difference against the updated schema.
`return-stock.test.ts` coordinates return completion against sales, restocks and
returns from different original sales using `lockedRace.ts`. Exchange deductions
and reversed exchange product orders use the same product-lock barrier. Shared
`stockHistory.ts` assertions verify the signed movements and full previous/new
quantity chain. A real PostgreSQL trigger rejects the final return status update
to verify rollback of inventory, logs, restocked flags and completion status.
All five inventory race regressions fail against the original return controller
(including stock 12 instead of 9 for return versus sale). No migration is required.
Verification: build and 465 unit tests passed (2 existing TODOs); all 35 Postgres
tests passed with a client freshly generated from this branch's schema. The
workspace's shared generated client had an unrelated CustomerCredit.returnId
field, so the verification client was generated separately under /tmp and aliased
only for the test run; shared dependencies and product schema were unchanged.

Credit sale returns (`return-credit.test.ts`): apply migration
`20261026000000_return_credit_reversal` before deploying this API. Each completed
CREDIT-sale return appends one uniquely return-linked negative ADJUSTMENT through
`applyCustomerCredit`. Only STORE_CREDIT/account adjustment is supported; REFUND,
EXCHANGE and exchange lines are rejected. The recipient is the original purchase
debtor, and value comes from the existing sale entitlement, including tax/discount
allocation. Repayments are account-wide, so partial/full repayment does not change
the reversal: all payments remain intact and a negative balance is account credit,
with no cash paid out. Missing/duplicate purchases, incompatible sale corrections,
unsettled historical completions and ledger/balance drift require reconciliation.
Other STORE_CREDIT return implementations must reuse the same `returnId` unique
ledger link and must not award additional account credit for CREDIT-sale returns.
Sale locks use NO KEY UPDATE to retain serialization while allowing sale-linked
payment FK checks; this avoids a sale/customer lock cycle. Tests force overlapping
payment/completion and competing completions, and a real trigger proves rollback.

Store-credit rework verification (2026-10-26): merged current main and retained
`validateCreditReturn`/`settleCreditReturn` and its complete PostgreSQL suite.
Paid-sale refunds reuse main's `creditReversal` relation and unique returnId;
CREDIT-sale completions post only the existing negative debt ADJUSTMENT. Both
component builds, 465 API unit tests (2 TODOs), 20 PostgreSQL return regressions
and both paid/pay-later UI regressions passed. The account-credit migration now
adds only the customer relation; the existing reversal migration owns returnId.
Return inventory rework verification (2026-10-26): merged current main, retaining
`settleCreditReturn` before ordered product locks and the shipped `NO KEY UPDATE`
sale entitlement lock. Customer settlement precedes product locks to match sale
lock ordering. Build, 465 unit tests (2 existing TODOs), and all 45 real PostgreSQL
regressions passed on a fresh disposable local database. This includes all 17
return-stock and return-credit tests run together, plus the full Postgres suite.

Final store-credit requeue verification (2026-10-26): merged current main through
94fc13d, preserving validateCreditReturn/settleCreditReturn, Returns.test.tsx,
and ordered concurrent return inventory movements. API and app builds passed,
465 API unit tests passed (2 existing TODOs), both return UI regressions passed,
and all 55 PostgreSQL regressions passed together after applying the documented
open-till partial index to the disposable database. Paid-sale credit and pay-later
debt adjustments share the unique returnId link and remain mutually exclusive.
