-- Preserve unknown historical VAT metadata; deliberately no defaults or backfill.
ALTER TABLE "Sale" ADD COLUMN "taxRate" DOUBLE PRECISION,
  ADD COLUMN "taxInclusive" BOOLEAN,
  ADD COLUMN "taxNumber" TEXT;
