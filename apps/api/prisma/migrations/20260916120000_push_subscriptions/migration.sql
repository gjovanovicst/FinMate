-- Browser push endpoints (ADR-028, docs/03 §4). One row per `endpoint`, household-scoped.
--
-- A brand-new table, so this is purely additive and forward-only: nothing is dropped, renamed or
-- backfilled, and it is safe to apply while the previous release is still serving traffic — the old
-- code simply never reads or writes the table.
--
-- The endpoint is the identity, so `UNIQUE (endpoint)` is global rather than per-Household: a
-- subscription belongs to a device, and a re-subscribe from the same browser must update the row
-- instead of duplicating it. A `404`/`410` from the push service is what retires a row (soft delete),
-- never a delivery failure. `p256dh`/`auth` are the client's **public** key material (RFC 8291);
-- nothing in this table is a secret of ours, but the endpoint is a device identifier and therefore
-- personal data (docs/08 §3.9, data-flow row 31b).
--
-- No CHECK constraint: every value here is free-form client or push-service text, so there is no
-- invariant the database can enforce beyond the two foreign keys and the endpoint's uniqueness.
CREATE TABLE push_subscriptions (
  id                 UUID PRIMARY KEY,
  household_id       UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint           TEXT NOT NULL,
  p256dh             TEXT NOT NULL,
  auth               TEXT NOT NULL,
  user_agent         TEXT,
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ,
  UNIQUE (endpoint)
);

-- Live subscriptions only: the dispatch path never wants a tombstone (ADR-028 decision 3), and the
-- table holds one row per browser, so this stays small enough for a plain (non-CONCURRENT) index.
CREATE INDEX push_subscriptions_live_idx ON push_subscriptions (household_id) WHERE deleted_at IS NULL;
