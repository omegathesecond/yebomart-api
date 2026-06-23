-- PIN security hardening for staff till login.
--
-- 1. Brute-force protection: count failed PIN logins per user and allow a
--    temporary lockout. A 4-digit PIN is only 10k combinations, so an IP-based
--    rate limiter (defeated by rotating IPs) is not enough — the counter lives
--    on the user row.
ALTER TABLE "User" ADD COLUMN "failedPinAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "pinLockedUntil" TIMESTAMP(3);

-- 2. Existing PINs are stored in plaintext. They cannot be bcrypt-hashed in
--    pure SQL, so the data backfill runs as a separate, idempotent script:
--      npx tsx scripts/hash-existing-pins.ts
--    Until that runs (or the user next logs in, which lazily upgrades the PIN
--    to a hash), auth.service still authenticates legacy plaintext PINs and
--    rewrites them as a hash on first successful login. No till user is locked
--    out by this migration.
