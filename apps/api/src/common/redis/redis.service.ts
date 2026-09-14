import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';

import { CONFIG, type AppConfig } from '../../config/config';

/**
 * Redis client (docs/05 §1) — rate-limit counters now; the rule cache, idempotency keys and BullMQ
 * queues later.
 *
 * **Degradation policy:** a Redis outage must not take the API down (docs/05 §11). The connection
 * is lazy and every helper tolerates failure, so callers decide whether to fail open or closed.
 * The login limiter deliberately fails **open** — argon2id already makes brute force expensive, and
 * locking every user out because a cache is down is the worse outcome.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    this.client = new Redis(this.config.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
    });
    // Without a listener, ioredis emits an unhandled 'error' event and crashes the process.
    this.client.on('error', (error: Error) => {
      this.logger.warn(`redis error: ${error.message}`);
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
      this.logger.log('redis connection established');
    } catch (error) {
      this.logger.warn(
        `redis unavailable at boot (${error instanceof Error ? error.message : String(error)}); ` +
          `continuing without it — see the degradation policy in this class`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }

  /** True when Redis is connected and responsive. */
  async isHealthy(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * Increment a counter and return its new value, setting a TTL on first increment.
   * Returns `null` when Redis is unavailable, so the caller can choose its failure mode.
   */
  async incrementWithTtl(key: string, ttlSeconds: number): Promise<number | null> {
    try {
      const value = await this.client.incr(key);
      if (value === 1) await this.client.expire(key, ttlSeconds);
      return value;
    } catch {
      return null;
    }
  }

  /** Remaining TTL in seconds, or `null` when unavailable/has no expiry. */
  async ttl(key: string): Promise<number | null> {
    try {
      const value = await this.client.ttl(key);
      return value < 0 ? null : value;
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch {
      // Nothing to do: the key expires on its own.
    }
  }
}
