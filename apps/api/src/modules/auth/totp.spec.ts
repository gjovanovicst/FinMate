import { describe, expect, it } from 'vitest';

import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  otpauthUri,
  totpCode,
  verifyTotp,
} from './totp';

/**
 * RFC 6238, against RFC 6238's own vectors.
 *
 * The value of implementing TOTP in-repo (ADR-041) is that every line can be checked, and this is the
 * check: Appendix B publishes the expected code for a known secret at six known times, so a mistake
 * in the base32 alphabet, the big-endian counter, the HMAC or the dynamic truncation shows up here
 * rather than as "my authenticator app says the code is wrong".
 */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('base32 (RFC 4648)', () => {
  it('encodes the RFC example without padding', () => {
    expect(base32Encode(Buffer.from('foobar', 'ascii'))).toBe('MZXW6YTBOI');
  });

  it('round-trips arbitrary bytes', () => {
    for (const length of [1, 5, 10, 20, 32, 64]) {
      const bytes = Buffer.from(Array.from({ length }, (_, index) => (index * 37) % 256));
      expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    }
  });

  it('accepts lowercase, spaces and padding on input', () => {
    expect(base32Decode('mzxw 6ytboi==').toString('ascii')).toBe('foobar');
  });

  it('refuses a character outside the alphabet rather than guessing', () => {
    // `1` is not in the alphabet; silently dropping it would produce a secret whose codes never match.
    expect(() => base32Decode('MZXW6YTB1')).toThrow(/Invalid base32/);
  });
});

describe('totpCode (RFC 6238 Appendix B, SHA-1, 8 digits)', () => {
  it.each([
    [59, '94287082'],
    [1_111_111_109, '07081804'],
    [1_111_111_111, '14050471'],
    [1_234_567_890, '89005924'],
    [2_000_000_000, '69279037'],
    [20_000_000_000, '65353130'],
  ])('T=%i produces %s', (seconds, expected) => {
    expect(totpCode(RFC_SECRET, Math.floor(seconds / 30), 8)).toBe(expected);
  });
});

describe('verifyTotp', () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000; // fixed, so the test is not a race with the clock

  it('generates a 160-bit secret that decodes back to 20 bytes', () => {
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(base32Decode(secret)).toHaveLength(20);
  });

  it('accepts the code for the current step', () => {
    const code = totpCode(secret, Math.floor(now / 1000 / 30));
    expect(verifyTotp(secret, code, now)).toBe(Math.floor(now / 1000 / 30));
  });

  it('accepts one step either side, for clock skew', () => {
    const counter = Math.floor(now / 1000 / 30);
    expect(verifyTotp(secret, totpCode(secret, counter - 1), now)).toBe(counter - 1);
    expect(verifyTotp(secret, totpCode(secret, counter + 1), now)).toBe(counter + 1);
  });

  it('refuses a code two steps away', () => {
    const counter = Math.floor(now / 1000 / 30);
    expect(verifyTotp(secret, totpCode(secret, counter + 2), now)).toBeNull();
  });

  it('refuses anything that is not six to eight digits', () => {
    expect(verifyTotp(secret, '12345', now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
    expect(verifyTotp(secret, '', now)).toBeNull();
  });

  it('tolerates spaces in a typed code', () => {
    const code = totpCode(secret, Math.floor(now / 1000 / 30));
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotp(secret, spaced, now)).not.toBeNull();
  });
});

describe('otpauthUri', () => {
  it('carries the secret, the issuer twice and the documented parameters', () => {
    const uri = otpauthUri({ secret: 'ABCDEF', issuer: 'FinMate', account: 'a@b.c' });
    expect(uri.startsWith('otpauth://totp/FinMate:a%40b.c?')).toBe(true);
    const query = new URLSearchParams(uri.slice(uri.indexOf('?') + 1));
    expect(query.get('secret')).toBe('ABCDEF');
    // Twice on purpose: some apps read the label, others read the parameter.
    expect(query.get('issuer')).toBe('FinMate');
    expect(query.get('algorithm')).toBe('SHA1');
    expect(query.get('digits')).toBe('6');
    expect(query.get('period')).toBe('30');
  });
});
