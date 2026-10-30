CREATE TYPE "SupplierPaymentFundingSource" AS ENUM ('OUTSIDE_TILL', 'TILL_CASH');
ALTER TABLE "SupplierLedger" ADD COLUMN "fundingSource" "SupplierPaymentFundingSource",
  ADD COLUMN "cashSessionId" TEXT, ADD COLUMN "submissionKey" TEXT, ADD COLUMN "paymentNote" TEXT;
ALTER TABLE "CashSession" ADD COLUMN "supplierPayoutsTotal" DOUBLE PRECISION,
  ADD COLUMN "supplierPayoutsCount" INTEGER;
CREATE UNIQUE INDEX "SupplierLedger_shopId_submissionKey_key" ON "SupplierLedger"("shopId", "submissionKey");
CREATE INDEX "SupplierLedger_shopId_cashSessionId_idx" ON "SupplierLedger"("shopId", "cashSessionId");
ALTER TABLE "SupplierLedger" ADD CONSTRAINT "SupplierLedger_cashSessionId_fkey" FOREIGN KEY ("cashSessionId") REFERENCES "CashSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierLedger" ADD CONSTRAINT "SupplierLedger_payout_membership_check" CHECK (
  ("fundingSource" IS NULL AND "cashSessionId" IS NULL AND "submissionKey" IS NULL)
  OR (type = 'PAYMENT' AND amount > 0 AND "submissionKey" IS NOT NULL AND (
    ("fundingSource" = 'TILL_CASH' AND "cashSessionId" IS NOT NULL)
    OR ("fundingSource" = 'OUTSIDE_TILL' AND "cashSessionId" IS NULL)
  ) AND "fundingSource" IS NOT NULL)
);
-- Existing ledger attribution and closed subtotals stay NULL; no inferred cash/backfill.
