-- A pending email change (docs/03 §4, docs/06 §2).
--
-- Purely additive and forward-only: nothing is dropped, renamed or backfilled, so it is safe to
-- apply while the previous release is still serving traffic — the old code simply never reads or
-- writes the column.
--
-- Why a column rather than a payload on the token: `email_tokens` stores only a digest, and the new
-- address has to survive until the emailed link is clicked, possibly days later. Keeping the *old*
-- address live in `users.email` until then is the point — a typo in the new one, or an abandoned
-- change, leaves the account's login identity exactly where it was.
--
-- Nullable, with no default: an existing User has no pending change, and NULL is the honest value.
-- The CHECK constraints on `users` are untouched by an ADD COLUMN.
ALTER TABLE users ADD COLUMN pending_email CITEXT;

COMMENT ON COLUMN users.pending_email IS
  'New address awaiting confirmation via a CHANGE_EMAIL link. users.email stays the login identity until the link is consumed.';
