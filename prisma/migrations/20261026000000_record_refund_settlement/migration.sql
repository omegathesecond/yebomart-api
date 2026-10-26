-- Do not infer historical cash payouts from merchandise return status.
ALTER TABLE "Return" ADD COLUMN "settlementMethod" "PaymentMethod",
  ADD COLUMN "settlementReference" TEXT,
  ADD COLUMN "settledAt" TIMESTAMP(3),
  ADD COLUMN "cashSessionId" TEXT;
ALTER TABLE "Return" ADD CONSTRAINT "Return_cashSessionId_fkey"
  FOREIGN KEY ("cashSessionId") REFERENCES "CashSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Return_shopId_cashSessionId_idx" ON "Return"("shopId", "cashSessionId");
ALTER TABLE "Return" ADD CONSTRAINT "Return_settlement_check" CHECK (
  ("settlementMethod" IS NULL AND "settledAt" IS NULL AND "cashSessionId" IS NULL)
  OR ("settlementMethod" IS NOT NULL AND type = 'REFUND' AND status = 'COMPLETED' AND "settledAt" IS NOT NULL
      AND "settlementMethod" IN ('CASH','CARD','MOMO','EMALI')
      AND (("settlementMethod" = 'CASH' AND "cashSessionId" IS NOT NULL)
        OR ("settlementMethod" <> 'CASH' AND "cashSessionId" IS NULL AND "settlementReference" IS NOT NULL AND length(trim("settlementReference")) > 0)))
);
