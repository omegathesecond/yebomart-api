-- Harden returns/refunds: tie cash refunds to the till drawer and make
-- exchange-out stock deductions idempotent.
--
-- 1. Return.cashSessionId: links a completed REFUND return to the OPEN cash
--    session it was paid out of, so the end-of-day cash-up subtracts cash that
--    left the drawer for refunds (mirrors Sale.cashSessionId for cash taken in).
-- 2. ReturnExchangeItem.deducted: idempotency flag for the exchange-OUT stock
--    deduction, mirroring ReturnItem.restocked on the inbound side. Without it a
--    re-run of "complete" deducted exchange stock again every time.
--
-- Both columns are additive and nullable/defaulted, so existing rows are
-- unaffected.

ALTER TABLE "Return" ADD COLUMN "cashSessionId" TEXT;

ALTER TABLE "ReturnExchangeItem" ADD COLUMN "deducted" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Return_cashSessionId_idx" ON "Return"("cashSessionId");

ALTER TABLE "Return" ADD CONSTRAINT "Return_cashSessionId_fkey"
  FOREIGN KEY ("cashSessionId") REFERENCES "CashSession"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
