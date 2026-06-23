-- AuditLog: make userId nullable so shop OWNERs (who have no User row — their
-- token id is the Shop id) can log mutations without violating the FK, and add
-- denormalized actor identity columns so owner actions stay attributable.

-- Drop the NOT NULL on userId. The existing AuditLog_userId_fkey FK stays:
-- a foreign key is only enforced for non-null values, so null is now allowed.
ALTER TABLE "AuditLog" ALTER COLUMN "userId" DROP NOT NULL;

-- Denormalized actor identity (covers both owner and staff actors).
ALTER TABLE "AuditLog" ADD COLUMN "actorRole" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "actorName" TEXT;
