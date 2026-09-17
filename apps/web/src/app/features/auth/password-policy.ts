/**
 * The password policy, as the client needs it for a form hint.
 *
 * Mirrors `PasswordService` on the API (`MIN_PASSWORD_LENGTH` 12, `MAX_PASSWORD_LENGTH` 256) — the
 * server's `validateStrength` is **length only**, and it still enforces it, so this is a convenience
 * that saves a round trip, never the control. It lives here rather than in each screen because two
 * screens now need the same number and a second copy is how a hint starts lying (docs/15).
 *
 * @module apps/web/src/app/features/auth
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;
