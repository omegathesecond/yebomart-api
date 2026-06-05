-- Idempotency for the POS offline outbox.
-- Sales rung up offline carry a client-generated `localId`; this unique index
-- lets the API dedup replayed/lost-response sales (no duplicate rows, no double
-- stock decrement). Postgres treats NULLs as distinct, so the many existing
-- rows with localId = NULL (sales rung up online) are unaffected.
CREATE UNIQUE INDEX "Sale_shopId_localId_key" ON "Sale"("shopId", "localId");
