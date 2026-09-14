import { Injectable, Logger } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * Password hashing — argon2id, as required by docs/08 §3.
 *
 * Two deliberate implementation choices:
 *
 *  - **`@node-rs/argon2`, not `argon2`.** The `argon2` npm package compiles a C++20 native addon,
 *    which fails on the Ubuntu 20.04 toolchain (g++ 9.4 has no `-std=gnu++20`). `@node-rs/argon2`
 *    ships prebuilt binaries, so it works on this machine *and* in CI without a compiler. The
 *    algorithm and output format are the same (`$argon2id$v=19$…`).
 *  - **Parameters match the OWASP recommendation** (m=19456 KiB, t=2, p=1). These are recorded on
 *    the hash itself, so `needsRehash` can transparently upgrade existing passwords when the
 *    parameters are raised — no forced reset needed.
 */
@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);

  /** OWASP baseline: 19 MiB memory, 2 iterations, parallelism 1. */
  private readonly options = {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  } as const;

  /**
   * Lower bounds from docs/08 §3. Length is the only property that reliably matters in practice,
   * so the rule is "long or long" rather than a character-class checklist.
   */
  static readonly MIN_PASSWORD_LENGTH = 12;
  static readonly MAX_PASSWORD_LENGTH = 256;

  async hashPassword(plain: string): Promise<string> {
    return hash(plain, this.options);
  }

  /**
   * Verify a password. Returns `false` rather than throwing on a malformed stored hash, so a
   * corrupt row cannot be distinguished from a wrong password by an attacker.
   */
  async verifyPassword(storedHash: string, plain: string): Promise<boolean> {
    try {
      return await verify(storedHash, plain, this.options);
    } catch (error) {
      this.logger.warn(
        `password verification failed on a malformed hash: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /** True when the stored hash used weaker parameters than we now use. */
  needsRehash(storedHash: string): boolean {
    const memory = /m=(\d+)/.exec(storedHash)?.[1];
    const time = /t=(\d+)/.exec(storedHash)?.[1];
    if (!memory || !time) return true;
    return Number(memory) < this.options.memoryCost || Number(time) < this.options.timeCost;
  }

  /**
   * Reject passwords that are too short. Called before hashing so the cost is not paid for input
   * that will be rejected anyway.
   *
   * A breach-list check (HaveIBeenPwned k-anonymity) belongs here in Phase 5 — it is a network
   * call on a security-critical path, so it needs its own timeout and fallback policy.
   */
  validateStrength(plain: string): { ok: true } | { ok: false; reason: string } {
    if (plain.length < PasswordService.MIN_PASSWORD_LENGTH) {
      return {
        ok: false,
        reason: `Password must be at least ${PasswordService.MIN_PASSWORD_LENGTH} characters.`,
      };
    }
    if (plain.length > PasswordService.MAX_PASSWORD_LENGTH) {
      return {
        ok: false,
        reason: `Password must be at most ${PasswordService.MAX_PASSWORD_LENGTH} characters.`,
      };
    }
    return { ok: true };
  }
}
