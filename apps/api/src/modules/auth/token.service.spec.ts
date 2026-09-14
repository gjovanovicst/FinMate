import { describe, expect, it } from 'vitest';

import { JwtService } from '@nestjs/jwt';

import { loadConfig, type AppConfig } from '../../config/config';
import { TokenService } from './token.service';

const config: AppConfig = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_SECRET: 'test-secret-that-is-long-enough-32',
  ACCESS_TOKEN_TTL_SECONDS: '900',
});

function service(overrides: Partial<AppConfig> = {}): TokenService {
  return new TokenService({ ...config, ...overrides }, new JwtService({}));
}

describe('TokenService', () => {
  describe('access tokens (JWT, short-lived)', () => {
    it('signs and verifies a token round-trip', async () => {
      const tokens = service();
      const token = await tokens.signAccessToken({ userId: 'user-1', sessionId: 'session-1' });
      await expect(tokens.verifyAccessToken(token)).resolves.toEqual({
        userId: 'user-1',
        sessionId: 'session-1',
      });
    });

    it('carries only identifiers — never the Household or role as authority', async () => {
      // docs/08 §3: a role change must take effect on the next request, so authority is read from
      // the database per request and must not be embedded in the token.
      const tokens = service();
      const token = await tokens.signAccessToken({ userId: 'user-1', sessionId: 'session-1' });
      const payload = JSON.parse(
        Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'),
      ) as Record<string, unknown>;

      expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'jti', 'sid', 'sub']);
      expect(payload).not.toHaveProperty('householdId');
      expect(payload).not.toHaveProperty('role');
    });

    it('gives each access token a distinct jti, so tokens are distinguishable in logs', async () => {
      const tokens = service();
      const first = await tokens.signAccessToken({ userId: 'u', sessionId: 's' });
      const second = await tokens.signAccessToken({ userId: 'u', sessionId: 's' });
      expect(first).not.toBe(second);
    });

    it('rejects a token signed with a different secret', async () => {
      const issuer = service({ JWT_SECRET: 'another-secret-that-is-long-enough' });
      const verifier = service();
      const token = await issuer.signAccessToken({ userId: 'u', sessionId: 's' });
      await expect(verifier.verifyAccessToken(token)).resolves.toBeNull();
    });

    it('rejects an expired token', async () => {
      const tokens = service({ ACCESS_TOKEN_TTL_SECONDS: -1 });
      const token = await tokens.signAccessToken({ userId: 'u', sessionId: 's' });
      await expect(tokens.verifyAccessToken(token)).resolves.toBeNull();
    });

    it('rejects a malformed token instead of throwing', async () => {
      await expect(service().verifyAccessToken('not.a.jwt')).resolves.toBeNull();
    });

    it('rejects a token whose claims are not strings', async () => {
      const jwt = new JwtService({});
      const forged = await jwt.signAsync({ sub: 123, sid: 'session-1' }, { secret: config.JWT_SECRET });
      await expect(service().verifyAccessToken(forged)).resolves.toBeNull();
    });
  });

  describe('refresh tokens (opaque, stored hashed)', () => {
    it('generates a high-entropy opaque token', () => {
      const { token } = service().generateRefreshToken();
      // 32 random bytes, base64url encoded.
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('returns the digest, never the token itself, for storage', () => {
      const tokens = service();
      const { token, hash } = tokens.generateRefreshToken();
      expect(hash).not.toBe(token);
      expect(hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
      expect(tokens.hashToken(token)).toBe(hash);
    });

    it('does not repeat', () => {
      const tokens = service();
      const generated = new Set(Array.from({ length: 500 }, () => tokens.generateRefreshToken().token));
      expect(generated.size).toBe(500);
    });

    it('uses a different generator path for email tokens but the same digest scheme', () => {
      const tokens = service();
      const { token, hash } = tokens.generateEmailToken();
      expect(tokens.hashToken(token)).toBe(hash);
    });
  });

  describe('safeEquals (constant-time comparison)', () => {
    it('is true for equal digests', () => {
      expect(service().safeEquals('abc123', 'abc123')).toBe(true);
    });

    it('is false for different digests', () => {
      expect(service().safeEquals('abc123', 'abc124')).toBe(false);
    });

    it('is false for different lengths, without throwing', () => {
      expect(service().safeEquals('abc', 'abcd')).toBe(false);
    });
  });

  describe('TTL accessors reflect configuration', () => {
    it('exposes the configured lifetimes', () => {
      const tokens = service();
      expect(tokens.accessTokenTtlSeconds()).toBe(900);
      expect(tokens.refreshTokenTtlSeconds()).toBe(config.REFRESH_TOKEN_TTL_SECONDS);
      expect(tokens.emailTokenTtlSeconds()).toBe(config.EMAIL_TOKEN_TTL_SECONDS);
    });
  });
});
