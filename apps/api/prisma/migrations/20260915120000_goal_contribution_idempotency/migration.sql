-- A goal contribution is money, so its write is idempotent (I-10, docs/06 §5.7).
--
-- Expand-only and forward-only: a nullable column plus a partial unique index, exactly the shape
-- `transactions.idempotency_key` already has. Nothing is backfilled (existing rows keep NULL, which the
-- partial index does not cover) and nothing is dropped, so this migration is safe to run while the
-- previous release is still serving traffic — the old code simply never writes the column.
--
-- `goal_contributions` holds one row per contribution (tens per Household, not millions), so a plain
-- CREATE INDEX is right here; CONCURRENTLY is for the tables that can grow without bound.

ALTER TABLE goal_contributions ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX goal_contributions_idempotency_idx
  ON goal_contributions (household_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
