-- Two-factor authentication (ADR-041, docs/03 §4).
--
-- Additive and forward-only: three nullable columns on `users` and two new tables. Nothing existing
-- is read differently, so this applies while the previous release is still serving traffic — the old
-- code never reads or writes any of it. No `NOT NULL DEFAULT` and no data rewrite, so the `users`
-- table is not locked.
--
-- Split across two tables rather than JSON on `users` because both are queried by their own key
-- (a challenge by its token digest, a recovery code by its digest) and both are pruned by expiry or
-- use; `sessions` and `email_tokens` follow the same shape for the same reason.

ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_confirmed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN email_otp_enabled_at TIMESTAMPTZ;

COMMENT ON COLUMN users.totp_secret IS
  'TOTP shared secret, AES-256-GCM encrypted under MFA_ENCRYPTION_KEY. NULL until a setup starts; the factor is on only once totp_confirmed_at is set.';

-- A login that passed its password and is waiting for a second factor. Only the digest of the
-- challenge token is stored, exactly like a refresh token; `attempts` caps guessing of a six-digit
-- emailed code, and `consumed_at` makes the challenge single-use.
CREATE TABLE mfa_challenges (
  id              UUID PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      CHAR(64) NOT NULL UNIQUE,
  method          TEXT NOT NULL CHECK (method IN ('TOTP','EMAIL')),
  code_hash       CHAR(64),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,
  ip_hash         TEXT,
  user_agent_hash TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Live challenges only: the verification path never wants a spent one, and a periodic prune can use
-- the expiry index. Both indexes are partial for the same reason `sessions`' are.
CREATE INDEX mfa_challenges_live_user_idx ON mfa_challenges (user_id) WHERE consumed_at IS NULL;
CREATE INDEX mfa_challenges_live_expiry_idx ON mfa_challenges (expires_at) WHERE consumed_at IS NULL;

-- Ten single-use recovery codes per account, minted when a factor is enabled and stored only as
-- SHA-256 digests. A fast digest is correct here: each code is 80 bits of randomness, so there is no
-- dictionary to attack and no need for a slow KDF (unlike a password).
CREATE TABLE mfa_recovery_codes (
  id         UUID PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  CHAR(64) NOT NULL UNIQUE,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX mfa_recovery_codes_live_idx ON mfa_recovery_codes (user_id) WHERE used_at IS NULL;
