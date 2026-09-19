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
