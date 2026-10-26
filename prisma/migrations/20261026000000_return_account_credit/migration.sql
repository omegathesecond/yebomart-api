ALTER TABLE "CustomerCredit" ADD COLUMN "returnId" TEXT;
CREATE UNIQUE INDEX "CustomerCredit_returnId_key" ON "CustomerCredit"("returnId");
ALTER TABLE "CustomerCredit" ADD CONSTRAINT "CustomerCredit_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "Return"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Return" ADD CONSTRAINT "Return_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
