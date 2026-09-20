import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords — RFC 6238 — in-repo, on `node:crypto` (ADR-041).
 *
 * ## Why this is not a dependency, and not in `packages/domain`
 *
 * It is ~80 lines of HMAC and base32, and the one thing an authenticator app must get exactly right
 * is the algorithm, so it is worth being able to read and test every line against RFC 6238's own
 * vectors (`totp.spec.ts` does). It lives in the **API** rather than `@finmate/domain` because it
 * needs `node:crypto`: the domain package is bundled into the browser, where that import would break
 * the build. The web never computes a code — it renders the `otpauth://` URI the API hands it.
 *
 * ## What it deliberately does not do
 *
 * It does not track the last used step per account. TOTP codes are valid for a whole 30-second step,
 * so the same code could be presented twice within it; the **challenge** is what is single-use
 * (ADR-041 decision 4), and replay of a whole login is therefore impossible. A per-step denylist
 * would add a write on every verification for a window a one-time challenge already closes.
 */

/** RFC 4648 base32, without padding — what authenticator apps expect. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** The step size and digit count every authenticator app defaults to. */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

/** Encode bytes as unpadded base32. */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/**
 * Decode unpadded base32.
 *
 * Throws on a character outside the alphabet rather than guessing: a secret that silently decodes
 * to different bytes produces codes that never match, which is far harder to diagnose than an error.
 */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh 160-bit secret, the length RFC 4226 §4 recommends for HMAC-SHA1. */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

/**
 * The code for one counter (a step number), per RFC 4226's dynamic truncation.
 *
 * `digits` is a parameter because RFC 6238's test vectors are eight digits while every authenticator
 * app defaults to six; the vectors are only usable if the width can vary.
 */
export function totpCode(secretBase32: string, counter: number, digits = TOTP_DIGITS): string {
  const key = base32Decode(secretBase32);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Verify a code, allowing a one-step clock skew on each side.
 *
 * Returns the matched step, or `null`. The caller stores nothing from it today (see the module
 * header), but returning it keeps the door open for a per-step check without changing this contract.
 * Comparison is constant-time so a timing difference cannot reveal how many leading digits were
 * right — a six-digit code is only a million possibilities, and a prefix oracle shrinks it fast.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  nowMs: number = Date.now(),
  window = 1,
  stepSeconds = TOTP_PERIOD_SECONDS,
): number | null {
  const normalized = code.replace(/[\s-]+/g, '');
  if (!/^\d{6,8}$/.test(normalized)) return null;

  const counter = Math.floor(nowMs / 1000 / stepSeconds);
  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = totpCode(secretBase32, counter + offset, normalized.length);
    if (constantTimeEquals(candidate, normalized)) return counter + offset;
  }
  return null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * The `otpauth://` URI an authenticator app scans, per the Key URI Format.
 *
 * The issuer appears twice — in the label and as a parameter — on purpose: the label is what some
 * apps display and the parameter is what others do, and a URI that carries only one shows up as
 * "account" with no service in the app that reads the other.
 */
export function otpauthUri(params: {
  secret: string;
  issuer: string;
  account: string;
  digits?: number;
}): string {
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.account)}`;
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(params.digits ?? TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
