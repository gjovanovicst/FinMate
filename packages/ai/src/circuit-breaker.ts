/**
 * Per-provider circuit breaker.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §9 — "Circuit breaker per provider; open circuit ⇒
 * fall through to the next provider ⇒ then to rules-only degradation."
 *
 * ## Why it exists here rather than in Redis
 *
 * ADR-013 is a single-node modular monolith, so an in-process breaker is not a compromise: it is
 * exactly the right scope. A shared breaker would add a dependency and a failure mode (the breaker
 * store itself) to protect against a problem we do not have. State is therefore module-local and
 * resets on deploy, which is correct — a deploy is usually how an outage is fixed.
 *
 * ## The three states
 *
 * ```text
 * CLOSED ──(threshold consecutive failures)──▶ OPEN
 *    ▲                                          │ (openMs elapsed)
 *    │ (probe succeeds)                         ▼
 *    └────────────────────────────────── HALF_OPEN
 *                                               │ (probe fails)
 *                                               └──▶ OPEN, full cooldown restarts
 * ```
 *
 * A half-open breaker admits **one** probe. If a second caller arrives while that probe is in
 * flight it is refused rather than piling more load onto a provider we already believe is down —
 * the fail-fast behaviour is the point.
 *
 * **Only transport failures count.** A 401 or a 400 is a credential or payload bug that a retry
 * cannot fix, and it says nothing about whether the provider is up; counting it would open a
 * breaker whose half-open probe fails forever. Only {@link AiTransientError} and, optionally,
 * malformed-response failures are recorded, and the router decides which.
 *
 * ## The clock is injected
 *
 * `Date.now()` is never read directly: tests drive the cooldown deterministically by moving a
 * clock, not by sleeping. There is no timer and no background work — the breaker transitions only
 * when a call asks it to.
 *
 * @module @finmate/ai
 */

import type { Endpoint } from './endpoints';

/** docs/04 §9 leaves the numbers open; F-07's requirement is stated as "3 pd", read as 3. */
export const DEFAULT_FAILURE_THRESHOLD = 3;

/**
 * How long an open circuit stays open before admitting a probe, in milliseconds.
 *
 * 60 s is chosen so a transient provider wobble costs one minute of fallback rather than a
 * restart, while a systematic outage recovers within a minute of being fixed without an operator
 * touching anything. It is deliberately shorter than the 429 back-off an over-retrying client
 * would earn.
 */
export const DEFAULT_OPEN_MS = 60_000;

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** The options a caller may tune; every one has a documented default. */
export interface CircuitBreakerOptions {
  readonly failureThreshold?: number;
  readonly openMs?: number;
  /** Injectable clock, in epoch milliseconds. Never called except by {@link CircuitBreaker}. */
  readonly now?: () => number;
}

/** The breaker's observable state, for tests, logs and a health endpoint. */
export interface CircuitSnapshot {
  readonly endpoint: Endpoint;
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  /** Epoch ms at which an open circuit admits a probe. `null` unless `OPEN`. */
  readonly opensUntil: number | null;
}

/**
 * One breaker per endpoint. Kept deliberately boring: no persistence, no events, no timer.
 */
export class CircuitBreaker {
  readonly endpoint: Endpoint;

  private readonly failureThreshold: number;
  private readonly openMs: number;
  private readonly now: () => number;

  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private opensUntil: number | null = null;
  private probeInFlight = false;

  constructor(endpoint: Endpoint, options: CircuitBreakerOptions = {}) {
    this.endpoint = endpoint;
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.openMs = options.openMs ?? DEFAULT_OPEN_MS;
    this.now = options.now ?? Date.now;

    if (!Number.isInteger(this.failureThreshold) || this.failureThreshold < 1) {
      throw new RangeError(
        `failureThreshold must be a positive integer, got ${String(this.failureThreshold)}`,
      );
    }
    if (!Number.isFinite(this.openMs) || this.openMs < 0) {
      throw new RangeError(`openMs must be a non-negative number, got ${String(this.openMs)}`);
    }
  }

  /**
   * May a call proceed right now?
   *
   * A `CLOSED` circuit always may. An `OPEN` circuit admits nothing until its cooldown elapses,
   * then flips to `HALF_OPEN` and admits exactly one probe. A `HALF_OPEN` circuit admits the probe
   * it is waiting for and refuses everyone else.
   *
   * This method has a side effect (the `OPEN → HALF_OPEN` transition) because the transition *is*
   * time passing; making it a separate `refresh()` call would let a caller forget it.
   */
  canAttempt(): boolean {
    if (this.state === 'OPEN') {
      if (this.opensUntil !== null && this.now() >= this.opensUntil) {
        this.state = 'HALF_OPEN';
        this.probeInFlight = true;
        return true;
      }
      return false;
    }

    if (this.state === 'HALF_OPEN') {
      if (this.probeInFlight) return false;
      this.probeInFlight = true;
      return true;
    }

    return true;
  }

  /** Record a success: the provider is healthy, so the breaker closes and its history clears. */
  recordSuccess(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.opensUntil = null;
    this.probeInFlight = false;
  }

  /**
   * Record a failure. Returns the state after recording, so a caller can log the transition
   * without reading private state.
   *
   * A failure in `HALF_OPEN` reopens immediately — the probe answered the question, and the answer
   * was "still down". A failure in `CLOSED` opens only on the threshold-th consecutive one.
   */
  recordFailure(): CircuitState {
    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.opensUntil = this.now() + this.openMs;
      this.probeInFlight = false;
      // The count is kept at the threshold: it is the evidence for how the breaker got here, and
      // the half-open probe is not a fourth consecutive failure of the same run.
      this.consecutiveFailures = Math.max(this.consecutiveFailures, this.failureThreshold);
      return this.state;
    }

    this.consecutiveFailures += 1;
    this.probeInFlight = false;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.opensUntil = this.now() + this.openMs;
    }
    return this.state;
  }

  /** The current state without transitioning it. Reading never mutates. */
  snapshot(): CircuitSnapshot {
    return {
      endpoint: this.endpoint,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      opensUntil: this.state === 'OPEN' ? this.opensUntil : null,
    };
  }
}

/** A lazily-created breaker per endpoint, so the router needs no wiring and no module state. */
export class CircuitBreakers {
  private readonly options: CircuitBreakerOptions;
  private readonly breakers = new Map<Endpoint, CircuitBreaker>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.options = options;
  }

  for(endpoint: Endpoint): CircuitBreaker {
    const existing = this.breakers.get(endpoint);
    if (existing !== undefined) return existing;
    const created = new CircuitBreaker(endpoint, this.options);
    this.breakers.set(endpoint, created);
    return created;
  }

  /** Snapshots of every breaker that has been used, for a health endpoint or a test. */
  snapshots(): readonly CircuitSnapshot[] {
    return [...this.breakers.values()].map((breaker) => breaker.snapshot());
  }
}
