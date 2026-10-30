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

`return-stock.test.ts` also covers equal-value exchange replacement issuance:
concurrent completion/retries issue stock once; competing exchanges cannot
oversell; duplicate replacement lines are one demand; same-product returned
stock is available in the batch; shortages and a forced final-write failure
roll back stock, flags, logs and status. Replacement values use current retail
prices plus current shop tax and must equal the original discounted, tax-aware
return entitlement. Changed prices or incomplete historical exchanges must be
rejected and recreated; no balance collection or payout is introduced. No new
schema migration is required.

Cash checkout/close serialization (`checkout-cash.test.ts`): CASH checkout and
cash refund settlement reuse `CashSessionService.lockOpenSessionId` inside their
write transactions, before product locks. A checkout holding the drawer lock
commits before close tallies it. If close wins, checkout remains unassigned
(`cashSessionId: null`); no till opening is required. Lookup/database errors abort
checkout rather than simulating a missing till. Receipt retries and localId
idempotency retain their existing transaction boundaries.

Cash totals in current/close/Z reports now use explicit session membership;
noncash Z-report totals retain their time window. Unassigned cash is excluded,
including late commits whose transaction timestamp predates close. No historical
attribution is inferred and stored closed expectedCash/variance are not rewritten.
No migration is required. Historical drawers affected by the original race may
need deliberate reconciliation. Coordinated tests pause actual transactions after
sale insertion or the close claim, observe blocked PostgreSQL backends, then
release them. They check both orders, retry attribution, stock, lookup rollback,
and sale/refund/close contention using the existing disposable database harness.

Exchange requeue verification (2026-10-27): preserved the existing replacement
workflow and merged main through fe2d863, retaining the shared till-session lock.
Both component builds passed; all 140 app tests and 491 API unit tests passed
(2 existing API TODOs). All 12 real PostgreSQL return-stock regressions passed
against a fresh disposable database, including competing exchanges, one-time
completion, duplicate demand, same-product restocking and forced rollback.

Cash void/close serialization (`checkout-cash.test.ts`): voiding an attached CASH
sale locks its exact OPEN drawer through the same guarded update as checkout,
before the sale and stock locks. Both close/void orders observe PostgreSQL lock
waits before releasing the winner. Closed-drawer voids fail with a direction to
use return/refund settlement; sale status, stock, saved expected cash/variance
and reopened Z-report remain unchanged, including after another drawer opens.
Unassigned cash and noncash voids retain their existing behavior. Credit reversal
and return-entitlement regressions continue to apply. No migration is required.

Customer debt collections (`customer-collections.test.ts`): PAYMENT writes require
an explicit CASH or EXTERNAL_NONCASH method and UUID retry key. Cash uses the
existing till lock before the customer ledger lock; no open till means refusal.
Ledger, balance, method and till attribution commit together. Collection retries
return the existing ledger row, including after the till closes; changing a retry
payload is refused. Debt settlement does not create sales or revenue. Tests cover
both close race orders, duplicate retries, rollback, foreign shop/customer/sale,
noncash without a drawer, adjustments and unknown historical attribution.

Apply `20261029131000_customer_collections` before releasing this API and app
change together. The payment request contract intentionally rejects unclassified
new payments; there is no legacy request fallback. Historical payment method and
till remain null, and historical closed collection subtotals remain null/unknown.
No historical totals or balances are rewritten and no cash attribution is inferred.
The app retains unconfirmed payment payloads and retry keys in sessionStorage
across route remounts/reloads in the same browser tab; retry the unchanged entry.

Till expense payouts (`expense-payouts.test.ts`): every new expense requires an
explicit OUTSIDE_TILL or TILL_CASH source, a positive amount, date and UUID retry
key. TILL_CASH also requires an exact open shop-owned session. Creation serializes
shop/key retries, then locks the drawer using the existing guarded update before
inserting the single expense row. Close shares that lock. Retrying an accepted
payout after close returns the original row; changed payloads are rejected.
Till-funded expenses reject all edits/deletes, including while open. Historical
expenses remain unclassified and cannot be reclassified by update. Outside-till
expenses retain normal editing and have no drawer effect. Profit reports aggregate
the same expense row once; no separate expense or sales posting is introduced.

Apply `20261029203000_expense_payouts` before releasing this API/app together.
The task branches include the already dev-released customer-collection dependency;
production will also require its migration if promoted there. The new migration
leaves historical funding/session/key and saved expense subtotals NULL. Closed
expected/count/variance and expense subtotal/count are saved; historical subtotal
NULL displays as unknown. No historical reclassification is performed.

Expense payout implementation verification (2026-10-29): API build and 540 unit/
HTTP regressions passed (2 existing TODOs); app build, 202 regressions and lint
passed (5 existing warnings). All 106 real PostgreSQL regressions passed with the
open-till index and refund/collection/expense CHECK constraints applied, including
both payout/close lock orders and combined sales/collection/refund/expense totals.
The actual migration also passed a rolled-back historical-row preservation check.
No production or dev database/service was changed during implementation.

Supplier payments from the till (`supplier-payouts.test.ts`) extend the released
expense work (task-1793304083639-mpr9zd), using its shared submission lock and
exact OPEN till guarded update; no second expense/payout row is created. A PAYMENT
ledger row records the funding source, exact session and shop-scoped UUID key in
the same transaction as supplier.balance and PO.amountPaid. Global lock order is
shop/key advisory lock -> exact till -> PO -> supplier. Receipts retain PO ->
products -> supplier and never acquire a till after the PO. Close only claims the
till, then reads committed movements. Tests observe PostgreSQL lock waits in
both payment/close orders, not timing assumptions. Deduplication precedes OPEN
validation and caps, so accepted requests replay after close/full settlement.
Changed payloads for an existing key return 409 and retain the original outcome.
Business rejections return SUPPLIER_PAYMENT_NOT_RECORDED only after rollback,
allowing the app to correct funding; uncertain responses retain the original
payload/key in tab sessionStorage, scoped by shop and PO, across remounts.

Apply `20261030033000_supplier_payouts` BEFORE deploying this API and app together.
New payments require explicit TILL_CASH or OUTSIDE_TILL funding plus a UUID key;
TILL_CASH requires an exact open shop-owned session. No old-request fallback is
provided. Historical ledger funding/session/key and closed supplier subtotal/count
remain NULL/unknown; no backfill or reclassification. Current cash-up subtracts
supplier payouts separately from expenses, and close saves the supplier subtotal
and count alongside expected/count/variance. Closed Z reports use those saved
supplier figures. No YeboPay charge, sale or operating expense is created by
settling a payable. Existing caps, tax allocation, returns, customer collections
and expense accounting remain covered by the full PostgreSQL regression suite.

Implementation verification (2026-10-30): API build and 550 unit/HTTP tests pass
(2 pre-existing TODOs); all 112 real PostgreSQL regressions pass with supplier,
expense and collection membership constraints and the one-open-till index. App
build, 233 tests and lint pass (5 existing lint warnings). An independent fresh
pre-change schema seeded with historical supplier PAYMENT and CLOSED cash-up
rows passes the actual supplier migration; original balance, amount, expected,
counted and variance are unchanged, new attribution/subtotals remain NULL.
No deployed service/database, charge, historical data or production branch changed.
`stock.test.ts` also exercises atomic stock usage accounting: a temporary,
shop-scoped PostgreSQL CHECK constraint rejects the final usage update after
inventory writes. Both adjustment and bulk receipt must roll back; retrying the
receipt counts two movements once. Opposite-order concurrent bulk receipts
verify exact usage totals alongside the existing locked stock audit history.
The constraint is removed in `finally`; no live schema or counters are changed.
