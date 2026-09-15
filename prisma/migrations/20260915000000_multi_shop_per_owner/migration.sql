-- Multi-shop per owner.
--
-- Shop.ownerYeboidSub and Shop.ownerPhone were each globally UNIQUE, which
-- hard-capped a YeboID owner at exactly one Shop row (a second shop create
-- would collide on both constraints — ownerPhone mirrors the same YeboID
-- profile across every shop the owner has, so it's never unique once they
-- have more than one). Drop both unique indexes and replace them with a
-- plain index on (ownerYeboidSub, createdAt) so "resolve all shops for this
-- owner, oldest first" is an indexed scan instead of a unique point lookup.
--
-- Existing single-shop owners are unaffected: nothing about their one row's
-- data changes, and auth.middleware.ts still resolves them to that same shop
-- by default (their only row is trivially "the oldest").
DROP INDEX IF EXISTS "Shop_ownerYeboidSub_key";
DROP INDEX IF EXISTS "Shop_ownerPhone_key";

CREATE INDEX "Shop_ownerYeboidSub_createdAt_idx" ON "Shop"("ownerYeboidSub", "createdAt");
