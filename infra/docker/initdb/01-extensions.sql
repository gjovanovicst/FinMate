-- Runs once, on first initialisation of an empty data volume.
--
-- All three extensions are REQUIRED by the canonical schema in docs/03-domain-model.md §4.
-- They are created here rather than by a migration because `CREATE EXTENSION` needs superuser
-- and the application role is deliberately not superuser.
--
--   citext   -> users.email case-insensitive uniqueness
--   pg_trgm  -> fuzzy Merchant/Counterparty resolution (docs/04 §4, stage 3)
--   vector   -> Household-local embeddings for entity resolution (pgvector)

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;
