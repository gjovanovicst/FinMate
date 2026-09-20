import { z } from 'zod';

/**
 * Auth request schemas.
 *
 * These are also the TypeScript types (`z.infer`), so the wire contract and the compile-time type
 * cannot drift. Constraints that are *policy* (password length) are enforced in `PasswordService`
 * as well, so the rule has one definition.
 */

const email = z
  .string()
  .trim()
  .min(3)
  .max(320)
  // Deliberately permissive: over-strict email regexes reject valid addresses, and verification
  // email is the real check.
  .refine((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), 'Must be a valid email address.');

export const signupSchema = z.object({
  email,
  // Length bounds only; `PasswordService.validateStrength` owns the policy and its message.
  password: z.string().min(1).max(256),
  displayName: z.string().trim().min(1).max(80),
  // The language the client is showing. Optional: a client that does not send one leaves the User on
  // the product's primary language, which is what every notification and email then uses (ADR-040).
  locale: z.string().trim().min(2).max(35).optional(),
});
export type SignupInput = z.infer<typeof signupSchema>;

/**
 * The signed-in reader's language.
 *
 * Persisted so copy composed **after** the request — a verification mail, a password reset, an alert
 * from the daily job — is written in the language the reader chose rather than in whichever one the
 * server happened to default to. Same bounds as the assistant's locale argument, and rejected the same
 * way rather than trusted, because it reaches a stored column and later a prompt.
 */
export const updateLocaleSchema = z.object({
  locale: z
    .string()
    .trim()
    .min(2)
    .max(35)
    .regex(/^[a-z]{2,3}(?:-[A-Za-z]{2,8})*$/, 'Unsupported locale.'),
});
export type UpdateLocaleInput = z.infer<typeof updateLocaleSchema>;

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(256),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  // Optional because browsers send it as an httpOnly cookie instead of a body field.
  refreshToken: z.string().min(1).optional(),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

export const tokenSchema = z.object({
  token: z.string().min(1).max(512),
});
export type TokenInput = z.infer<typeof tokenSchema>;

export const requestPasswordResetSchema = z.object({ email });
export type RequestPasswordResetInput = z.infer<typeof requestPasswordResetSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(1).max(512),
  password: z.string().min(1).max(256),
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/**
 * A UUID path parameter (`/auth/sessions/:id`).
 *
 * Validated rather than passed through, so a malformed id is a `VALIDATION_FAILED` the client can
 * act on instead of a Prisma cast error surfacing as an opaque `INTERNAL`.
 */
export const uuidSchema = z.string().uuid();

/**
 * Two-factor authentication (ADR-041).
 *
 * Every **mutation** of a second factor carries the password: enrolling, enabling, disabling and
 * regenerating recovery codes are all credential changes, and a borrowed session must not be able to
 * make any of them (docs/08 §3). The one exception is verifying a login challenge, which is public
 * by definition and holds its own single-use token.
 */
export const mfaPasswordSchema = z.object({
  password: z.string().min(1).max(256),
});
export type MfaPasswordInput = z.infer<typeof mfaPasswordSchema>;

export const mfaEnableTotpSchema = z.object({
  password: z.string().min(1).max(256),
  // Six to eight digits, matching what `verifyTotp` accepts: an authenticator app is configured for
  // six, but the API tolerates the wider width rather than rejecting a code the algorithm allows.
  code: z
    .string()
    .trim()
    .regex(/^\d{6,8}$/, 'Enter the six-digit code from your app.'),
});
export type MfaEnableTotpInput = z.infer<typeof mfaEnableTotpSchema>;

export const mfaEmailToggleSchema = z.object({
  password: z.string().min(1).max(256),
  enabled: z.boolean(),
});
export type MfaEmailToggleInput = z.infer<typeof mfaEmailToggleSchema>;

/** Login-challenge follow-ups. Public: the challenge token *is* the credential at this step. */
export const mfaVerifySchema = z.object({
  challengeToken: z.string().min(1).max(512),
  // A TOTP code (6–8 digits), an emailed code (6) or a recovery code (four groups). Length only: the
  // service decides which shape it is, so a stale client cannot ask for a factor the challenge did
  // not offer.
  code: z.string().trim().min(1).max(64),
});
export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;

export const mfaChallengeSchema = z.object({
  challengeToken: z.string().min(1).max(512),
});
export type MfaChallengeInput = z.infer<typeof mfaChallengeSchema>;

/**
 * The profile screen (docs/02 §4.18). Only the display name is editable here: the email is a
 * credential change with its own confirmation flow, and the language has its own endpoint because
 * the switcher persists it without visiting this page (`updateLocaleSchema`).
 */
export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/**
 * Changing a password is a **re-authentication**, not an edit: the current password is required even
 * though the request already carries a session, because a borrowed session must not be able to lock
 * the owner out of their own account (docs/08 §3).
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  // Length bounds only; `PasswordService.validateStrength` owns the policy and its message, exactly
  // as on signup and reset.
  newPassword: z.string().min(1).max(256),
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/**
 * Starting an email change. The password is required for the same reason as above: an address is
 * half of every login, so moving it is a credential change and not a field edit.
 */
export const changeEmailSchema = z.object({
  email,
  password: z.string().min(1).max(256),
});
export type ChangeEmailInput = z.infer<typeof changeEmailSchema>;
