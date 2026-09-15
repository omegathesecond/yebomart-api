-- Multi-shop support: one YeboID owner (ownerYeboidSub) can now own more
-- than one Shop row, so a second shop for the same owner/phone is no longer
-- rejected by a uniqueness violation. Existing single-shop owners are
-- unaffected — dropping a unique constraint never invalidates existing rows,
-- and AuthService.signInWithYeboID/authMiddleware still resolve to a shop
-- (the oldest one by createdAt, i.e. the one that existed before this change)
-- when the client doesn't ask for a specific shop.
DROP INDEX IF EXISTS "Shop_ownerYeboidSub_key";
DROP INDEX IF EXISTS "Shop_ownerPhone_key";

-- Non-unique index: AuthService.signInWithYeboID / listShopsForOwner now
-- look up ALL shops for a given ownerYeboidSub instead of exactly one.
CREATE INDEX "Shop_ownerYeboidSub_idx" ON "Shop"("ownerYeboidSub");
