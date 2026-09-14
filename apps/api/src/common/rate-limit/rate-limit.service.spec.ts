import { describe, expect, it } from 'vitest';

import { RateLimitService } from './rate-limit.service';
import type { RedisService } from '../redis/redis.service';

/**
 * A tiny in-memory stand-in for Redis, so the limiter's policy is tested without infrastructure.
 * TTLs are not simulated: window expiry is Redis's behaviour, not this class's.
 */
function fakeRedis(): { service: RedisService; store: Map<string, number>; fail: boolean } {
  const store = new Map<string, number>();
  const state = { store, fail: false };

  const service = {
    incrementWithTtl: async (key: string): Promise<number | null> => {
      if (state.fail) return null;
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return next;
    },
    ttl: async (): Promise<number | null> => 42,
    delete: async (key: string): Promise<void> => {
      store.delete(key);
    },
  } as unknown as RedisService;

  return Object.assign(state, { service }) as { service: RedisService; store: Map<string, number>; fail: boolean };
}

describe('RateLimitService (docs/08 §9)', () => {
  it('allows requests up to the limit', async () => {
    const { service } = fakeRedis();
    const limiter = new RateLimitService(service);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const verdict = await limiter.consume('login', 'a@b.com', 3, 900);
      expect(verdict.allowed).toBe(true);
    }
  });

  it('blocks the request that exceeds the limit', async () => {
    const { service } = fakeRedis();
    const limiter = new RateLimitService(service);

    await limiter.consume('login', 'a@b.com', 3, 900);
    await limiter.consume('login', 'a@b.com', 3, 900);
    await limiter.consume('login', 'a@b.com', 3, 900);
    const blocked = await limiter.consume('login', 'a@b.com', 3, 900);

    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBe(42);
  });

  it('reports the remaining allowance', async () => {
    const { service } = fakeRedis();
    const limiter = new RateLimitService(service);
    await expect(limiter.consume('login', 'a@b.com', 5, 900)).resolves.toMatchObject({
      allowed: true,
      remaining: 4,
    });
  });

  it('counts subjects independently', async () => {
    const { service } = fakeRedis();
    const limiter = new RateLimitService(service);

    await limiter.consume('login', 'a@b.com', 1, 900);
    const other = await limiter.consume('login', 'c@d.com', 1, 900);
    expect(other.allowed).toBe(true);
  });

  it('counts scopes independently', async () => {
    const { service } = fakeRedis();
    const limiter = new RateLimitService(service);

    await limiter.consume('login:email', 'a@b.com', 1, 900);
    const otherScope = await limiter.consume('password-reset', 'a@b.com', 1, 900);
    expect(otherScope.allowed).toBe(true);
  });

  it('fails OPEN when Redis is unavailable, and does not throw', async () => {
    // Documented trade-off: argon2id already makes brute force expensive, and locking every user
    // out because a cache is down is the worse failure (docs/05 §11).
    const state = fakeRedis();
    state.fail = true;
    const limiter = new RateLimitService(state.service);

    const verdict = await limiter.consume('login', 'a@b.com', 1, 900);
    expect(verdict.allowed).toBe(true);
  });

  it('resets a counter after a successful login', async () => {
    const { service, store } = fakeRedis();
    const limiter = new RateLimitService(service);

    await limiter.consume('login:email', 'a@b.com', 5, 900);
    await limiter.reset('login:email', 'a@b.com');

    expect(store.size).toBe(0);
  });
});
