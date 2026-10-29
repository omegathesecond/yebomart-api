CREATE TYPE "ExpenseFundingSource" AS ENUM ('OUTSIDE_TILL', 'TILL_CASH');
ALTER TABLE "Expense" ADD COLUMN "fundingSource" "ExpenseFundingSource",
  ADD COLUMN "cashSessionId" TEXT, ADD COLUMN "submissionKey" TEXT;
ALTER TABLE "CashSession" ADD COLUMN "expensePayoutsTotal" DOUBLE PRECISION,
  ADD COLUMN "expensePayoutsCount" INTEGER;
CREATE UNIQUE INDEX "Expense_shopId_submissionKey_key" ON "Expense"("shopId", "submissionKey");
CREATE INDEX "Expense_shopId_cashSessionId_idx" ON "Expense"("shopId", "cashSessionId");
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_cashSessionId_fkey" FOREIGN KEY ("cashSessionId") REFERENCES "CashSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_payout_membership_check" CHECK (
  ("fundingSource" IS NOT NULL AND "fundingSource" = 'TILL_CASH' AND "cashSessionId" IS NOT NULL AND "submissionKey" IS NOT NULL AND amount > 0)
  OR (("fundingSource" IS NULL OR "fundingSource" = 'OUTSIDE_TILL') AND "cashSessionId" IS NULL)
);
-- Historical sources, membership and saved subtotals deliberately remain NULL.
