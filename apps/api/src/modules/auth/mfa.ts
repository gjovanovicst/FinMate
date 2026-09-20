import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto';

import { decodeMfaKey } from '../../config/config';

/**
 * The secret material around two-factor authentication (ADR-041).
 *
 * Three separate things, deliberately in one place because they share one rule — *nothing is stored
 * in a form that is useful to a database thief*:
 *
 *  - **The TOTP shared secret is encrypted**, not hashed: verification needs the original bytes, so a
 *    digest is impossible. AES-256-GCM under `MFA_ENCRYPTION_KEY`, with a random IV per enrolment and
 *    the auth tag stored alongside, so a tampered row fails to decrypt rather than yielding a wrong
 *    secret.
 *  - **Recovery codes are hashed**, not encrypted: they are only ever compared. SHA-256 is right here
 *    because each is 80 bits of randomness — there is no dictionary — unlike a password.
 *  - **Emailed login codes are hashed** for the same reason, with six digits of entropy the attempt
 *    cap and short expiry are what make that safe (see `mfa_challenges`).
 */

const VERSION = 'v1';
const IV_BYTES = 12; // 96 bits, the GCM recommendation

/** Encrypt a TOTP secret for storage. Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function encryptTotpSecret(secret: string, keyValue: string): string {
  const key = decodeMfaKey(keyValue);
  if (key === null) throw new Error('MFA_ENCRYPTION_KEY is not a 32-byte key');

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Decrypt a stored TOTP secret.
 *
 * Throws on a wrong key, a truncated payload, or a failed auth tag. That is the intended failure:
 * a wrong secret would produce codes the user cannot generate, and refusing loudly is what turns a
 * key mistake into an error at the enrolment rather than a support ticket months later.
 */
export function decryptTotpSecret(payload: string, keyValue: string): string {
  const key = decodeMfaKey(keyValue);
  if (key === null) throw new Error('MFA_ENCRYPTION_KEY is not a 32-byte key');

  const [version, ivPart, tagPart, dataPart] = payload.split('.');
  if (version !== VERSION || !ivPart || !tagPart || !dataPart) {
    throw new Error('Stored TOTP secret is malformed');
  }

  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * The alphabet recovery codes are drawn from.
 *
 * No `I`, `O`, `0` or `1`: a recovery code is read off paper or a screenshot and typed by hand, and
 * those are the pairs people transcribe wrongly.
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** How many codes an enrolment mints. */
export const RECOVERY_CODE_COUNT = 10;

/**
 * One recovery code: 16 alphabet characters in four groups, i.e. 80 bits.
 *
 * `byte % 32` is uniform because 256 is a multiple of 32, so there is no modulo bias to correct.
 * Sixteen characters is longer than a typical eight-digit code on purpose — these are the way back
 * into an account whose authenticator is gone, and they are hashed with a fast digest rather than a
 * slow KDF.
 */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(16);
  let raw = '';
  for (const byte of bytes) raw += RECOVERY_ALPHABET[byte % 32];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

/** A fresh set of recovery codes, returned once and stored only as digests. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => generateRecoveryCode());
}

/** Six digits, uniformly drawn — the code mailed when the email factor is on. */
export function generateEmailLoginCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * SHA-256, hex.
 *
 * Used for both code kinds. It is **not** stretched, and that is correct: neither input is a
 * password. A recovery code is 80 random bits, and an emailed code is defended by its short expiry
 * and the challenge's attempt cap rather than by the cost of a hash.
 */
export function hashMfaCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * Normalise a user-typed recovery code before hashing.
 *
 * Case, surrounding spaces and the group dashes are presentation: a person reading `A B C D - E F`
 * off a printout should not be told their code is wrong because of a space.
 */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]+/g, '').toUpperCase();
}
