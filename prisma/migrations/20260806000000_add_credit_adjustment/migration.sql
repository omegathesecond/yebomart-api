-- Admin credit adjustments: the yebomart-side audit trail for manual changes to
-- a shop's yebopay wallet balance. The money lives in yebopay; this table
-- records which admin authorised the change, why, and whether it landed.

-- CreateEnum
CREATE TYPE "CreditAdjustmentType" AS ENUM ('GOODWILL', 'REFUND', 'CORRECTION');

-- CreateEnum
CREATE TYPE "CreditAdjustmentStatus" AS ENUM ('PENDING', 'APPLIED', 'FAILED');

-- CreateTable
CREATE TABLE "CreditAdjustment" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "type" "CreditAdjustmentType" NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "CreditAdjustmentStatus" NOT NULL DEFAULT 'PENDING',
    "adminId" TEXT NOT NULL,
    "adminEmail" TEXT NOT NULL,
    "yebopayTxnId" TEXT,
    "balanceAfter" DOUBLE PRECISION,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditAdjustment_shopId_createdAt_idx" ON "CreditAdjustment"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditAdjustment_status_idx" ON "CreditAdjustment"("status");

-- AddForeignKey
ALTER TABLE "CreditAdjustment" ADD CONSTRAINT "CreditAdjustment_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
