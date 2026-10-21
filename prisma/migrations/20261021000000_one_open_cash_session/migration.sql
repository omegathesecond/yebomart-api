-- Fail loudly if legacy overlapping drawers exist: operators must reconcile
-- those rows deliberately before retrying, rather than fabricate cash-ups.
CREATE UNIQUE INDEX "CashSession_one_open_per_shop"
ON "CashSession" ("shopId") WHERE "status" = 'OPEN';
