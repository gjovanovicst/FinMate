import { describe, expect, it } from 'vitest';

import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateEmailLoginCode,
  generateRecoveryCode,
  generateRecoveryCodes,
  hashMfaCode,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
} from './mfa';

/** A valid 32-byte key, base64, as `decodeMfaKey` requires. */
const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');

describe('TOTP secret encryption', () => {
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

  it('round-trips the secret', () => {
    expect(decryptTotpSecret(encryptTotpSecret(secret, KEY), KEY)).toBe(secret);
  });

  it('never leaves the plaintext in the ciphertext', () => {
    const payload = encryptTotpSecret(secret, KEY);
    expect(payload).not.toContain(secret);
    expect(payload.startsWith('v1.')).toBe(true);
  });

  it('uses a fresh IV, so the same secret encrypts differently every time', () => {
    expect(encryptTotpSecret(secret, KEY)).not.toBe(encryptTotpSecret(secret, KEY));
  });

  it('refuses the wrong key', () => {
    const payload = encryptTotpSecret(secret, KEY);
    expect(() => decryptTotpSecret(payload, OTHER_KEY)).toThrow();
  });

  it('detects a tampered ciphertext rather than returning a wrong secret', () => {
    const payload = encryptTotpSecret(secret, KEY);
    const parts = payload.split('.');
    // Flip one character of the payload; GCM's auth tag is what makes this fail closed.
    const data = parts[3]!;
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]}.${data.startsWith('A') ? 'B' : 'A'}${data.slice(1)}`;
    expect(() => decryptTotpSecret(tampered, KEY)).toThrow();
  });

  it('refuses a malformed payload', () => {
    expect(() => decryptTotpSecret('nonsense', KEY)).toThrow(/malformed/);
    expect(() => decryptTotpSecret('v2.a.b.c', KEY)).toThrow(/malformed/);
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => encryptTotpSecret(secret, Buffer.alloc(16, 1).toString('base64'))).toThrow();
  });
});

describe('recovery codes', () => {
  it('are four groups of four, drawn from the unambiguous alphabet', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
    // The pairs a person misreads: no I/O/0/1 anywhere.
    expect(code).not.toMatch(/[IO01]/);
  });

  it('mints a full set of distinct codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
  });

  it('normalises what a person types before hashing', () => {
    expect(normalizeRecoveryCode('abcd-efgh ijkl-mnop')).toBe('ABCDEFGHIJKLMNOP');
    expect(hashMfaCode(normalizeRecoveryCode('abcd-efgh ijkl-mnop'))).toBe(
      hashMfaCode('ABCDEFGHIJKLMNOP'),
    );
  });
});

describe('emailed login codes', () => {
  it('are six digits, zero-padded', () => {
    for (let index = 0; index < 50; index += 1) {
      expect(generateEmailLoginCode()).toMatch(/^\d{6}$/);
    }
  });

  it('hash deterministically', () => {
    expect(hashMfaCode('000042')).toBe(hashMfaCode('000042'));
    expect(hashMfaCode('000042')).not.toBe(hashMfaCode('000043'));
    expect(hashMfaCode('000042')).toMatch(/^[0-9a-f]{64}$/);
  });
});
