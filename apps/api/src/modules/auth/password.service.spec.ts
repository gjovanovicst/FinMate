import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../config/config';
import { PasswordService } from './password.service';

// The real validator builds the config, so these tests also exercise it.
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_SECRET: 'a'.repeat(32),
});

describe('PasswordService (docs/08 §3 — argon2id)', () => {
  const passwords = new PasswordService();

  it('produces an argon2id hash, not argon2i or argon2d', async () => {
    const hash = await passwords.hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('uses the OWASP recommended parameters', async () => {
    const hash = await passwords.hashPassword('correct horse battery staple');
    // Recorded on the hash itself, which is what makes transparent rehashing possible.
    expect(hash).toContain('m=19456');
    expect(hash).toContain('t=2');
    expect(hash).toContain('p=1');
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await passwords.hashPassword('correct horse battery staple');
    const b = await passwords.hashPassword('correct horse battery staple');
    expect(a).not.toBe(b);
  });

  it('verifies the correct password', async () => {
    const hash = await passwords.hashPassword('correct horse battery staple');
    await expect(passwords.verifyPassword(hash, 'correct horse battery staple')).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await passwords.hashPassword('correct horse battery staple');
    await expect(passwords.verifyPassword(hash, 'Correct horse battery staple')).resolves.toBe(false);
  });

  it('returns false for a malformed hash rather than throwing', async () => {
    // A corrupt row must not be distinguishable from a wrong password by an attacker, and must not
    // crash the login path.
    await expect(passwords.verifyPassword('not-a-hash', 'anything')).resolves.toBe(false);
    await expect(passwords.verifyPassword('', 'anything')).resolves.toBe(false);
  });

  describe('strength policy', () => {
    it('rejects a short password', () => {
      const result = passwords.validateStrength('short');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/at least 12/);
    });

    it('accepts a 12-character password (boundary)', () => {
      expect(passwords.validateStrength('a'.repeat(12)).ok).toBe(true);
    });

    it('rejects 11 characters (boundary)', () => {
      expect(passwords.validateStrength('a'.repeat(11)).ok).toBe(false);
    });

    it('rejects an absurdly long password, to bound hashing cost', () => {
      expect(passwords.validateStrength('a'.repeat(257)).ok).toBe(false);
    });
  });

  describe('rehash detection', () => {
    it('does not request a rehash for a current hash', async () => {
      const hash = await passwords.hashPassword('correct horse battery staple');
      expect(passwords.needsRehash(hash)).toBe(false);
    });

    it('requests a rehash when the stored parameters are weaker', () => {
      expect(passwords.needsRehash('$argon2id$v=19$m=4096,t=1,p=1$c2FsdA$aGFzaA')).toBe(true);
    });

    it('requests a rehash for a hash with no parseable parameters', () => {
      expect(passwords.needsRehash('garbage')).toBe(true);
    });
  });

  it('is deterministic about the config it depends on', () => {
    expect(config.NODE_ENV).toBe('test');
  });
});
