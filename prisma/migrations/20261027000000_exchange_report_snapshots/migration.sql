ALTER TABLE "ReturnExchangeItem"
  ADD COLUMN "costPrice" DOUBLE PRECISION,
  ADD COLUMN "tax" DOUBLE PRECISION,
  ADD COLUMN "totalAmount" DOUBLE PRECISION;

CREATE INDEX "Return_shopId_status_processedAt_idx" ON "Return"("shopId", "status", "processedAt");
