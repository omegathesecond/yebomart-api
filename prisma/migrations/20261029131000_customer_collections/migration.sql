-- No historical payment or closed-till backfill: attribution remains explicitly unknown.
CREATE TYPE "CollectionMethod" AS ENUM ('CASH', 'EXTERNAL_NONCASH');
ALTER TABLE "CustomerCredit" ADD COLUMN "collectionMethod" "CollectionMethod",
  ADD COLUMN "collectionKey" TEXT, ADD COLUMN "cashSessionId" TEXT;
ALTER TABLE "CashSession" ADD COLUMN "cashCollectionsTotal" DOUBLE PRECISION,
  ADD COLUMN "cashCollectionsCount" INTEGER;
CREATE UNIQUE INDEX "CustomerCredit_shopId_collectionKey_key" ON "CustomerCredit"("shopId", "collectionKey");
CREATE INDEX "CustomerCredit_shopId_cashSessionId_idx" ON "CustomerCredit"("shopId", "cashSessionId");
ALTER TABLE "CustomerCredit" ADD CONSTRAINT "CustomerCredit_cashSessionId_fkey"
  FOREIGN KEY ("cashSessionId") REFERENCES "CashSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerCredit" ADD CONSTRAINT "CustomerCredit_collection_check" CHECK (
  ("collectionMethod" IS NULL AND "collectionKey" IS NULL AND "cashSessionId" IS NULL) OR
  ("collectionMethod" IS NOT NULL AND type = 'PAYMENT' AND amount > 0 AND "collectionKey" IS NOT NULL AND
    (("collectionMethod" = 'CASH' AND "cashSessionId" IS NOT NULL) OR
     ("collectionMethod" = 'EXTERNAL_NONCASH' AND "cashSessionId" IS NULL)))
);
