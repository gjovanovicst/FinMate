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
});
export type SignupInput = z.infer<typeof signupSchema>;

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
