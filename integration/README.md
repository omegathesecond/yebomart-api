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

Receipt rework verification (2026-10-21): retained main's shipped stock service,
locked receipt products in stable order, and added an opposite-order multi-product
receipt/restock regression. Build, sequential receipt tests and all 26 disposable
Postgres tests passed. The receipt fix requires no additional migration.

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

`sale-usage.test.ts` verifies one accounting attempt per committed sale,
rejected sales uncounted, concurrent/repeated localId deduplication, and a
counter failure returning the committed sale successfully. Accounting uses the
shared ShopService helper after commit, with failures logged as best-effort
analytics; counters can undercount during outages. Replays do not retry accounting.
The POST route no longer increments before validation. No migration is needed.

Rework verification (2026-10-26): API build passed; 469 unit/HTTP tests
passed (2 existing TODOs); all 3 real PostgreSQL sale-usage tests passed.
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

Refund requeue verification (2026-10-26): merged current main including
validateCreditReturn/settleCreditReturn and all ten debt-settlement regressions.
Credit tests now explicitly approve before completion; completed account adjustments
reverse debt without cash outflows in either live cash-up or the Z report.
Both builds, 465 API unit tests (2 TODOs), 125 app tests and all 46 real PostgreSQL
regressions passed, including close/refund races and forced transaction rollback.
Return inventory rework verification (2026-10-26): merged current main, retaining
`settleCreditReturn` before ordered product locks and the shipped `NO KEY UPDATE`
sale entitlement lock. Customer settlement precedes product locks to match sale
lock ordering. Build, 465 unit tests (2 existing TODOs), and all 45 real PostgreSQL
regressions passed on a fresh disposable local database. This includes all 17
return-stock and return-credit tests run together, plus the full Postgres suite.

Final refund requeue verification (2026-10-26): merged origin/main at 94fc13d,
including ordered product locks and all current credit-debt helpers/regressions.
Updated the newly merged return-stock fixtures to approve refunds and explicitly
record successful external settlement; their inventory assertions remain intact.
API and app builds passed; 465 API unit tests (2 TODOs), 125 app tests, and all
53 real PostgreSQL regressions passed on a fresh local database with both the
open-session index and refund settlement constraint applied. All ten credit-return
regressions passed, including balance reversal, retries, contention and rollback.

Store-credit returns (`store-credit-return.test.ts`): paid receipts require a
shop-local recipient and a positive reserved entitlement from the shared VAT and
discount allocation. Completion posts one REFUND through `applyCustomerCredit`
in the stock/status transaction. Retries and competing completions cannot post
twice; the shared unique `CustomerCredit.returnId` links the ledger to the return.
CREDIT-sale returns retain `validateCreditReturn`/`settleCreditReturn` and post
only their negative debt ADJUSTMENT, never a second REFUND or cash payout.

Apply `20261026000000_return_account_credit` before deploying this API: it adds
only the return/customer relation; the shipped reversal migration owns returnId.
The migration does not credit historical returns. Details expose recipient,
amount and ledger entry; customer statements include the return-reference note.
Tests cover full/partial VAT/discount allocation, mixed cash-return reservations,
missing/foreign/moved recipients, retries, competing completions, concurrent ledger
writes, and injected ledger/final-status failures proving complete rollback.

Requeue verification (2026-10-26): merged current main and preserved the shipped
pay-later helpers, their ten PostgreSQL regressions and Returns.test.tsx. Both
component builds, 465 API unit tests (2 TODOs), 7 return UI tests and all 63 real
PostgreSQL regressions passed on a fresh local database with the open-till index
and refund settlement check applied. Cash-up exclusion now uses a valid paid
store-credit receipt and verifies the persisted ledger and negative balance.

Purchase-order receipt requeue verification (2026-10-26): merged current main,
retaining its shared PO lock in recordPayment and supplier-payment.test.ts.
Receipts use that same lock before entitlement reads, reject duplicate line ids,
and lock products in stable order before atomic stock increments. Build, all 465
unit tests (2 existing TODOs), and all 73 real PostgreSQL tests passed against a
fresh disposable database with the open-till index and refund CHECK applied.
The competing payments of 80 against 100 return [200,400], with one PAYMENT,
amountPaid 80 and supplier balance 20. All ten receipt races and rollback tests pass.
No new migration is required.

PO receipt rework verification (2026-10-21): merged main through e8a3c30,
retained stock.service.ts and integration/stock.test.ts exactly from main, and
reused the payable PO lock for receipt entitlement. Receipts lock products in
stable order before atomic increments. All 31 real PostgreSQL regressions pass,
including opposite-order receipt/restock batches, cost-change notes, duplicate
validation, receipt/payment overlap and forced rollback. Build and 463 unit tests
pass (2 existing TODOs). No schema migration is required for the receipt fix.

Receipt rework verification (2026-10-21): retained main's shipped stock service,
locked receipt products in stable order, and added an opposite-order multi-product
receipt/restock regression. Build, sequential receipt tests and all 26 disposable
Postgres tests passed. The receipt fix requires no additional migration.

Receipt requeue verification (2026-10-26): merged current main through db85fc7
into the existing receipt branch, retaining the shipped supplier-payment locking,
`integration/supplier-payment.test.ts`, `integration/stock.test.ts` and
`stock.service.ts`. Build and all 31 coordinated PostgreSQL regressions passed
on a fresh local database, including concurrent payments of 80 against 100.
No additional schema migration is required.

Sale usage resume verification (2026-10-27): merged current main through
4d6043c, preserving stock and customer-credit protections. Added a real Postgres
late-stock-log failure regression proving sale/stock rollback leaves usage at zero,
and an HTTP counter-failure regression proving checkout and replay return 201.
Corrected the stale atomic-accounting route comment. Build, 470 unit/HTTP tests
(2 existing TODOs), and all 4 sale-usage PostgreSQL tests passed. Generated an
isolated Prisma client from this schema to avoid the stale shared client.
