/**
 * Cost accounting — docs/04 §9 (`cost_micros`) and §12 (the cost model).
 *
 * The two properties that matter: the result is an **integer** (a float in a running cost total is
 * the ADR-003 mistake in a smaller place), and an unknown model is a **visible hole** rather than a
 * silent zero that makes a Household look free.
 *
 * @module @finmate/ai
 */

import { describe, expect, it } from 'vitest';

import { MODEL_PRICES, costMicros } from './pricing';

describe('costMicros', () => {
  it('prices a known model proportionally to its tokens', () => {
    // deepseek-chat is 0.27 / 1.1 USD per million tokens, so micros are the weighted token count.
    const result = costMicros('deepseek-chat', 1_000_000, 1_000_000);
    expect(result.priced).toBe(true);
    expect(result.costMicros).toBe(270_000 + 1_100_000);
  });

  it('rounds to an integer', () => {
    const result = costMicros('deepseek-chat', 3, 7);
    expect(Number.isInteger(result.costMicros)).toBe(true);
  });

  it('prices the two directions separately', () => {
    expect(costMicros('gpt-4o-mini', 1_000_000, 0).costMicros).toBe(150_000);
    expect(costMicros('gpt-4o-mini', 0, 1_000_000).costMicros).toBe(600_000);
  });

  it('treats a missing token count as zero rather than guessing', () => {
    expect(costMicros('deepseek-chat', null, null).costMicros).toBe(0);
    expect(costMicros('deepseek-chat', 100, null).costMicros).toBe(
      costMicros('deepseek-chat', 100, 0).costMicros,
    );
  });

  it('reports an unknown model as unpriced, not as free', () => {
    const local = costMicros('qwen2.5:3b-instruct', 10_000, 1_000);
    expect(local.costMicros).toBe(0);
    expect(local.priced).toBe(false);
  });

  it('reports a null model as unpriced', () => {
    expect(costMicros(null, 10, 10)).toEqual({ costMicros: 0, priced: false });
  });

  it('is a pure function of its inputs', () => {
    expect(costMicros('deepseek-chat', 10, 20)).toEqual(costMicros('deepseek-chat', 10, 20));
  });

  it('publishes a price entry for every model the factories default to', () => {
    for (const model of ['gpt-4o-mini', 'deepseek-chat']) {
      expect(MODEL_PRICES[model]).toBeDefined();
    }
  });
});
