ALTER TABLE "Return" ADD COLUMN "settlementMethod" "PaymentMethod", ADD COLUMN "settlementReference" TEXT, ADD COLUMN "settledAt" TIMESTAMP(3), ADD COLUMN "cashSessionId" TEXT;
ALTER TABLE "Return" ADD CONSTRAINT "Return_cashSessionId_fkey" FOREIGN KEY ("cashSessionId") REFERENCES "CashSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Return_cashSessionId_idx" ON "Return"("cashSessionId");
ALTER TABLE "Return" ADD CONSTRAINT "Return_cash_settlement_check" CHECK ("settlementMethod" IS DISTINCT FROM 'CASH' OR ("cashSessionId" IS NOT NULL AND "settledAt" IS NOT NULL AND "status" = 'COMPLETED' AND "type" = 'REFUND'));
