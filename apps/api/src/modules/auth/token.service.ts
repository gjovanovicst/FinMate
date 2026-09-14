import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { uuidv7 } from '@finmate/domain';

import { CONFIG, type AppConfig } from '../../config/config';

/**
 * Token handling for sessions.
 *
 * Two different kinds of token, deliberately:
 *
 *  - **Access token — a JWT, 15 minutes.** Stateless and cheap to verify. It carries only
 *    identifiers (`sub`, `sid`); it does NOT carry the Household or role as authority, because
 *    docs/08 §3 requires a role change to take effect on the *next request*, not the next login.
 *    Those are read from the database on every request.
 *  - **Refresh token — 32 random bytes, opaque.** Never a JWT: it must be revocable, and only its
 *    SHA-256 digest is stored, so a database leak does not yield usable tokens. It is rotated on
 *    every use, and reuse of an already-used token is treated as theft.
 */
@Injectable()
export class TokenService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly jwt: JwtService,
  ) {}

  /** Mint a short-lived access token. Carries identifiers only — never authority. */
  signAccessToken(params: { userId: string; sessionId: string }): Promise<string> {
    return this.jwt.signAsync(
      {
        sub: params.userId,
        sid: params.sessionId,
        // `jti` gives every access token a distinct identity. Without it, two tokens minted in the
        // same second for the same session are byte-identical (JWT `iat` has second resolution),
        // which makes them indistinguishable in logs and would block any future denylist.
        jti: uuidv7(),
      },
      {
        secret: this.config.JWT_SECRET,
        expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS,
      },
    );
  }

  /** Verify an access token. Returns `null` for anything invalid, expired or malformed. */
  async verifyAccessToken(token: string): Promise<{ userId: string; sessionId: string } | null> {
    try {
      const payload = await this.jwt.verifyAsync<{ sub?: unknown; sid?: unknown }>(token, {
        secret: this.config.JWT_SECRET,
      });
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
      return { userId: payload.sub, sessionId: payload.sid };
    } catch {
      return null;
    }
  }

  /** Generate an opaque refresh token. The raw value is returned once and never stored. */
  generateRefreshToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: this.hashToken(token) };
  }

  /** Generate an opaque single-use token for email verification or password reset. */
  generateEmailToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: this.hashToken(token) };
  }

  /**
   * SHA-256 of an opaque token.
   *
   * A fast digest is correct here, unlike for passwords: the input is 256 bits of randomness, so
   * there is no dictionary to attack and no need for a slow KDF.
   */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Constant-time comparison for token digests.
   *
   * The database lookup already uses the hash as a key, but this guards the in-memory comparison
   * in reuse detection, where a timing difference could otherwise leak a prefix match.
   */
  safeEquals(a: string, b: string): boolean {
    const bufferA = Buffer.from(a, 'utf8');
    const bufferB = Buffer.from(b, 'utf8');
    if (bufferA.length !== bufferB.length) return false;
    return timingSafeEqual(bufferA, bufferB);
  }

  accessTokenTtlSeconds(): number {
    return this.config.ACCESS_TOKEN_TTL_SECONDS;
  }

  refreshTokenTtlSeconds(): number {
    return this.config.REFRESH_TOKEN_TTL_SECONDS;
  }

  emailTokenTtlSeconds(): number {
    return this.config.EMAIL_TOKEN_TTL_SECONDS;
  }
}
