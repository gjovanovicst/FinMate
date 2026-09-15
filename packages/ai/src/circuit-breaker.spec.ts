/**
 * The circuit breaker — docs/04 §9 ("open circuit ⇒ fall through to the next provider ⇒ then to
 * rules-only degradation"), task brief "circuit breaker (3 pd, F-07)".
 *
 * The cooldown is tested by moving an injected clock, never by sleeping: a spec that sleeps is a
 * spec that flakes on a loaded CI box, which this repository has already been bitten by on the
 * money path.
 *
 * @module @finmate/ai
 */

import { describe, expect, it } from 'vitest';

import {
  CircuitBreaker,
  CircuitBreakers,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_OPEN_MS,
} from './circuit-breaker';
import { counterClock } from './testing/stubs';

describe('defaults', () => {
  it('opens after three consecutive failures', () => {
    expect(DEFAULT_FAILURE_THRESHOLD).toBe(3);
  });

  it('stays open for the documented minute', () => {
    expect(DEFAULT_OPEN_MS).toBe(60_000);
  });

  it('refuses a nonsense threshold or cooldown', () => {
    expect(() => new CircuitBreaker('LOCAL', { failureThreshold: 0 })).toThrow(RangeError);
    expect(() => new CircuitBreaker('LOCAL', { failureThreshold: 2.5 })).toThrow(RangeError);
    expect(() => new CircuitBreaker('LOCAL', { openMs: -1 })).toThrow(RangeError);
    expect(() => new CircuitBreaker('LOCAL', { openMs: Number.NaN })).toThrow(RangeError);
  });
});

describe('CLOSED → OPEN → HALF_OPEN → CLOSED', () => {
  it('starts closed and admits calls', () => {
    const breaker = new CircuitBreaker('LOCAL');
    expect(breaker.snapshot().state).toBe('CLOSED');
    expect(breaker.canAttempt()).toBe(true);
    expect(breaker.snapshot().consecutiveFailures).toBe(0);
  });

  it('does not open before the threshold', () => {
    const breaker = new CircuitBreaker('LOCAL');
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.snapshot().state).toBe('CLOSED');
    expect(breaker.snapshot().consecutiveFailures).toBe(2);
    expect(breaker.canAttempt()).toBe(true);
  });

  it('opens on the threshold-th consecutive failure', () => {
    const clock = counterClock();
    const breaker = new CircuitBreaker('LOCAL', { now: clock.now });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.recordFailure()).toBe('OPEN');
    expect(breaker.snapshot().state).toBe('OPEN');
    expect(breaker.snapshot().opensUntil).toBe(clock.now() + DEFAULT_OPEN_MS);
  });

  it('short-circuits every attempt while open', () => {
    const clock = counterClock();
    const breaker = new CircuitBreaker('LOCAL', { now: clock.now });
    for (let attempt = 0; attempt < DEFAULT_FAILURE_THRESHOLD; attempt += 1) breaker.recordFailure();

    expect(breaker.canAttempt()).toBe(false);
    expect(breaker.canAttempt()).toBe(false);

    clock.advance(DEFAULT_OPEN_MS - 1);
    expect(breaker.canAttempt()).toBe(false);
  });

  it('half-opens after the cooldown and admits exactly one probe', () => {
    const clock = counterClock();
    const breaker = new CircuitBreaker('LOCAL', { now: clock.now });
    for (let attempt = 0; attempt < DEFAULT_FAILURE_THRESHOLD; attempt += 1) breaker.recordFailure();

    clock.advance(DEFAULT_OPEN_MS);
    expect(breaker.canAttempt()).toBe(true);
    expect(breaker.snapshot().state).toBe('HALF_OPEN');
    // A second caller arriving while the probe is in flight is refused rather than piling load on.
    expect(breaker.canAttempt()).toBe(false);
  });

  it('closes and forgets its history when the probe succeeds', () => {
    const clock = counterClock();
    const breaker = new CircuitBreaker('LOCAL', { now: clock.now });
    for (let attempt = 0; attempt < DEFAULT_FAILURE_THRESHOLD; attempt += 1) breaker.recordFailure();
    clock.advance(DEFAULT_OPEN_MS);
    expect(breaker.canAttempt()).toBe(true);

    breaker.recordSuccess();
    expect(breaker.snapshot().state).toBe('CLOSED');
    expect(breaker.snapshot().consecutiveFailures).toBe(0);
    expect(breaker.snapshot().opensUntil).toBeNull();
    expect(breaker.canAttempt()).toBe(true);
  });

  it('reopens for a fresh full cooldown when the probe fails', () => {
    const clock = counterClock();
    const breaker = new CircuitBreaker('LOCAL', { now: clock.now });
    for (let attempt = 0; attempt < DEFAULT_FAILURE_THRESHOLD; attempt += 1) breaker.recordFailure();
    clock.advance(DEFAULT_OPEN_MS);
    expect(breaker.canAttempt()).toBe(true);

    clock.advance(500);
    expect(breaker.recordFailure()).toBe('OPEN');
    expect(breaker.snapshot().state).toBe('OPEN');
    // The cooldown restarts from the probe's failure, not from the original open.
    expect(breaker.snapshot().opensUntil).toBe(clock.now() + DEFAULT_OPEN_MS);

    // And it is no longer half-open, so a caller cannot slip through during the new cooldown.
    expect(breaker.canAttempt()).toBe(false);
    clock.advance(DEFAULT_OPEN_MS);
    expect(breaker.canAttempt()).toBe(true);
  });

  it('clears a success streak on the first failure', () => {
    const breaker = new CircuitBreaker('LOCAL');
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.snapshot().state).toBe('CLOSED');
    expect(breaker.snapshot().consecutiveFailures).toBe(2);
  });

  it('honours a tuned threshold and cooldown', () => {
    const clock = counterClock();
    const breaker = new CircuitBreaker('LOCAL', { failureThreshold: 1, openMs: 100, now: clock.now });
    breaker.recordFailure();
    expect(breaker.snapshot().state).toBe('OPEN');
    clock.advance(100);
    expect(breaker.canAttempt()).toBe(true);
  });

  it('never reports opensUntil while closed', () => {
    const breaker = new CircuitBreaker('LOCAL');
    breaker.recordFailure();
    expect(breaker.snapshot().opensUntil).toBeNull();
  });
});

describe('CircuitBreakers — one breaker per endpoint', () => {
  it('returns the same instance for the same endpoint and different ones across endpoints', () => {
    const breakers = new CircuitBreakers();
    expect(breakers.for('LOCAL')).toBe(breakers.for('LOCAL'));
    expect(breakers.for('LOCAL')).not.toBe(breakers.for('DEEPSEEK_EU'));
  });

  it('keeps state per endpoint: one open circuit does not stop the fallback', () => {
    const breakers = new CircuitBreakers();
    for (let attempt = 0; attempt < DEFAULT_FAILURE_THRESHOLD; attempt += 1) {
      breakers.for('LOCAL').recordFailure();
    }
    expect(breakers.for('LOCAL').canAttempt()).toBe(false);
    expect(breakers.for('DEEPSEEK_EU').canAttempt()).toBe(true);
  });

  it('snapshots only the endpoints that have been used', () => {
    const breakers = new CircuitBreakers();
    breakers.for('LOCAL');
    expect(breakers.snapshots()).toEqual([
      { endpoint: 'LOCAL', state: 'CLOSED', consecutiveFailures: 0, opensUntil: null },
    ]);
  });

  it('propagates its options to every breaker it creates', () => {
    const breakers = new CircuitBreakers({ failureThreshold: 1, openMs: 5 });
    breakers.for('LOCAL').recordFailure();
    expect(breakers.for('LOCAL').snapshot().state).toBe('OPEN');
  });
});
