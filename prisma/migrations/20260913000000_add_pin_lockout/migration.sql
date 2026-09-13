-- Staff PIN brute-force throttle.
-- Additive only: both columns are nullable or defaulted, so existing rows are
-- unaffected and the migration is safe to apply before the code that reads them.
ALTER TABLE "User" ADD COLUMN "failedPinAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "pinLockedUntil" TIMESTAMP(3);
