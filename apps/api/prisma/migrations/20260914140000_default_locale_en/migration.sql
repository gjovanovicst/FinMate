-- English becomes the primary language (ADR-019), so the default for a new User follows it.
--
-- A default change is metadata-only: it does not rewrite existing rows, so it is safe on a live
-- table and needs no backfill. Existing Users keep whatever locale they already have, which is the
-- correct behaviour — their preference is not ours to overwrite.
ALTER TABLE users ALTER COLUMN locale SET DEFAULT 'en';

-- No data migration. Deliberately: silently switching a Serbian user's language to English would be
-- a worse outcome than a stale default.
