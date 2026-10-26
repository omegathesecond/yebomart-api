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

Refund settlement (2026-10-26): apply
`20261026000000_record_refund_settlement` to dev and prod **before** deploying
this API, then deploy the app. REFUND completion requires an APPROVED return and `settlement: { method, confirmed: true,
reference? }`. CASH uses the shop's current OPEN till (including prior-day sales),
locked against close. CARD/MOMO/EMALI record an externally completed payout with
a required successful refund reference; this endpoint never calls or claims
success from a provider. Only full settlement of the server-derived refund is
supported. Store-credit and exchange returns cannot record a cash payout.
CREDIT-sale money payouts are unsupported. Use STORE_CREDIT/account adjustment
to reverse debt through the shared settleCreditReturn helper; approval alone
never pays cash or changes debt.

Existing completed returns retain null settlement fields. There is no inferred
historical payout or recalculation of stored closed-session expected/variance.
The Z report adds cash refunds as a separate drawer outflow and preserves gross,
discounts, VAT, charged total and payment-method sales semantics.

`refund-cash.test.ts` verifies 100+50-20=130, prior-day attribution, noncash and
store-credit exclusion, pending/rejected/legacy exclusion, explicit confirmation,
no-open/foreign till rejection, unpaid CREDIT refusal, concurrent retries and
close/refund serialization, immutable closed figures, and full stock/payout
rollback under a forced PostgreSQL completion failure. Run against the disposable
local database after applying the migration's CHECK constraint as well as the
open-till partial index.
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

Refund requeue verification (2026-10-26): merged current main including
validateCreditReturn/settleCreditReturn and all ten debt-settlement regressions.
Credit tests now explicitly approve before completion; completed account adjustments
reverse debt without cash outflows in either live cash-up or the Z report.
Both builds, 465 API unit tests (2 TODOs), 125 app tests and all 46 real PostgreSQL
regressions passed, including close/refund races and forced transaction rollback.
