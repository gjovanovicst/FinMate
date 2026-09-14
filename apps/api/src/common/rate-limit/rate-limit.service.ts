import { Injectable, Logger } from '@nestjs/common';

import { RedisService } from '../redis/redis.service';

/**
 * Fixed-window rate limiting (docs/08 §9).
 *
 * Fixed windows are used rather than a sliding log because the goal is to blunt credential
 * stuffing and AI-quota abuse, not to be mathematically exact — and a single `INCR` is cheap
 * enough to run on the login path.
 *
 * **Failure mode: fail open.** If Redis is unavailable, requests are allowed and a warning is
 * logged. Denying every login because a cache is down is a worse outcome than a temporarily
 * unthrottled login endpoint, especially given that argon2id verification is already ~50 ms of
 * deliberate cost per attempt (docs/05 §11).
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Record a hit and report whether the caller is still within its allowance.
   *
   * @param scope  a stable namespace, e.g. `login`, `password-reset`
   * @param subject what is being limited, e.g. an email address or IP hash — never a raw secret
   */
  async consume(
    scope: string,
    subject: string,
    limit: number,
    windowSeconds: number,
  ): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number | null }> {
    const key = `ratelimit:${scope}:${subject}`;
    const count = await this.redis.incrementWithTtl(key, windowSeconds);

    if (count === null) {
      this.logger.warn(`rate limiter unavailable for scope "${scope}" — allowing the request`);
      return { allowed: true, remaining: limit, retryAfterSeconds: null };
    }

    if (count > limit) {
      const retryAfter = await this.redis.ttl(key);
      return { allowed: false, remaining: 0, retryAfterSeconds: retryAfter };
    }

    return { allowed: true, remaining: Math.max(0, limit - count), retryAfterSeconds: null };
  }

  /** Clear a counter, e.g. after a successful login. */
  async reset(scope: string, subject: string): Promise<void> {
    await this.redis.delete(`ratelimit:${scope}:${subject}`);
  }
}
