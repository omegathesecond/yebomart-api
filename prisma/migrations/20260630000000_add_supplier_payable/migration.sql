-- CreateEnum
CREATE TYPE "SupplierLedgerType" AS ENUM ('BILL', 'PAYMENT', 'ADJUSTMENT');

-- AlterTable: supplier accounts-payable running balance (positive = we owe them)
ALTER TABLE "Supplier" ADD COLUMN "balance" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable: per-PO payable tracking (balance due = amountReceived - amountPaid)
ALTER TABLE "PurchaseOrder" ADD COLUMN "amountReceived" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "amountPaid" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateTable: append-only supplier payable ledger
CREATE TABLE "SupplierLedger" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "type" "SupplierLedgerType" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "poId" TEXT,
    "note" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierLedger_supplierId_createdAt_idx" ON "SupplierLedger"("supplierId", "createdAt");

-- CreateIndex
CREATE INDEX "SupplierLedger_shopId_createdAt_idx" ON "SupplierLedger"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "SupplierLedger_poId_idx" ON "SupplierLedger"("poId");

-- AddForeignKey
ALTER TABLE "SupplierLedger" ADD CONSTRAINT "SupplierLedger_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierLedger" ADD CONSTRAINT "SupplierLedger_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
