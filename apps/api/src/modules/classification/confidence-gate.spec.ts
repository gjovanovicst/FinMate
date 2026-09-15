import { describe, expect, it } from 'vitest';

import { DEFAULT_LANE_THRESHOLDS, laneFor, type CalibratedConfidence } from '@finmate/ai';

import { applyConfidenceGate, resolveLaneThresholds } from './confidence-gate';

/**
 * The confidence gate is **validation** in the sense of docs/10 §1 — it is what turns a calibrated
 * number into a persisted lane, and getting it wrong stores a wrong answer about money. So this spec
 * is exhaustive over the bands and the boundary values, not example-based.
 */

/** Brand a literal the same way the gate's own callers do (storage → gate). */
function calibrated(value: number): CalibratedConfidence {
  return value as CalibratedConfidence;
}

const CATEGORY = '01a0a041-0000-7000-8000-000000000001';

describe('applyConfidenceGate — docs/04 §7 bands', () => {
  it('auto-applies at and above 0.90', () => {
    for (const value of [0.9, 0.901, 0.95, 0.999, 1]) {
      const decision = applyConfidenceGate({
        categoryId: CATEGORY,
        confidence: calibrated(value),
        fromAi: true,
      });
      expect(decision.lane, `confidence ${value}`).toBe('AUTO_APPLY');
      expect(decision.needsReview, `confidence ${value}`).toBe(false);
      expect(decision.categoryId).toBe(CATEGORY);
    }
  });

  it('applies and marks the advisory lane across 0.60–0.89', () => {
    for (const value of [0.6, 0.601, 0.75, 0.899]) {
      const decision = applyConfidenceGate({
        categoryId: CATEGORY,
        confidence: calibrated(value),
        fromAi: true,
      });
      expect(decision.lane, `confidence ${value}`).toBe('VERIFY');
      // The single most important assertion in §7: the advisory lane is NOT the blocking lane, or
      // the nav badge never clears and users learn to ignore it.
      expect(decision.needsReview, `confidence ${value}`).toBe(false);
      expect(decision.advisory, `confidence ${value}`).toBe(true);
      expect(decision.categoryId).toBe(CATEGORY);
    }
  });

  it('blocks below 0.60', () => {
    for (const value of [0, 0.001, 0.3, 0.599]) {
      const decision = applyConfidenceGate({
        categoryId: CATEGORY,
        confidence: calibrated(value),
        fromAi: true,
      });
      expect(decision.lane, `confidence ${value}`).toBe('ASK');
      expect(decision.needsReview, `confidence ${value}`).toBe(true);
      expect(decision.advisory, `confidence ${value}`).toBe(false);
    }
  });

  it('treats the band edges exactly as ADR-009 states', () => {
    // Boundary values are where a band test usually lies: `>=` vs `>` flips a whole population.
    expect(applyConfidenceGate({ categoryId: CATEGORY, confidence: calibrated(0.6), fromAi: false }).lane).toBe(
      'VERIFY',
    );
    expect(applyConfidenceGate({ categoryId: CATEGORY, confidence: calibrated(0.9), fromAi: false }).lane).toBe(
      'AUTO_APPLY',
    );
    expect(
      applyConfidenceGate({ categoryId: CATEGORY, confidence: calibrated(0.599999), fromAi: false }).lane,
    ).toBe('ASK');
  });

  it('is not advisory when a rule or keyword decided inside the verify band', () => {
    // §7 derives the advisory lane from `category_source = 'AI'`. A deterministic decision at 0.6–0.89
    // is applied without a glance, so it must not appear on the review queue's secondary tab.
    const decision = applyConfidenceGate({
      categoryId: CATEGORY,
      confidence: calibrated(0.75),
      fromAi: false,
    });
    expect(decision.lane).toBe('VERIFY');
    expect(decision.advisory).toBe(false);
    expect(decision.needsReview).toBe(false);
  });
});

describe('applyConfidenceGate — a null category blocks regardless of confidence (I-8)', () => {
  it('blocks a null category at 0.99 confidence', () => {
    // This is the trap the brief names explicitly: a model that returns no category with 0.99
    // confidence must NOT be stored as "confidently uncategorised".
    const decision = applyConfidenceGate({
      categoryId: null,
      confidence: calibrated(0.99),
      fromAi: true,
    });
    expect(decision.categoryId).toBeNull();
    expect(decision.needsReview).toBe(true);
    expect(decision.advisory).toBe(false);
  });

  it('blocks a null category at every confidence, including the auto-apply band', () => {
    for (const value of [0, 0.59, 0.6, 0.89, 0.9, 1]) {
      const decision = applyConfidenceGate({
        categoryId: null,
        confidence: calibrated(value),
        fromAi: true,
      });
      expect(decision.needsReview, `confidence ${value}`).toBe(true);
      expect(decision.advisory, `confidence ${value}`).toBe(false);
    }
  });

  it('preserves the confidence on a blocked null row so §6.4 can still re-fit', () => {
    const decision = applyConfidenceGate({
      categoryId: null,
      confidence: calibrated(0.87),
      fromAi: true,
    });
    // Nulling the confidence would destroy the observation; the row is blocked by `category_id`, not
    // by a fabricated zero.
    expect(decision.confidence).toBe(0.87);
  });

  it('does not block an uncategorised row from a non-AI source any differently', () => {
    const decision = applyConfidenceGate({
      categoryId: null,
      confidence: calibrated(1),
      fromAi: false,
    });
    expect(decision.needsReview).toBe(true);
    expect(decision.advisory).toBe(false);
  });
});

describe('applyConfidenceGate — injectable thresholds (docs/04 §7)', () => {
  it('honours an aggressive override that lowers both thresholds', () => {
    const thresholds = { autoApplyMin: 0.7, verifyMin: 0.4 };
    expect(
      applyConfidenceGate({ categoryId: CATEGORY, confidence: calibrated(0.75), fromAi: true, thresholds })
        .lane,
    ).toBe('AUTO_APPLY');
    expect(
      applyConfidenceGate({ categoryId: CATEGORY, confidence: calibrated(0.5), fromAi: true, thresholds })
        .advisory,
    ).toBe(true);
    expect(
      applyConfidenceGate({ categoryId: CATEGORY, confidence: calibrated(0.39), fromAi: true, thresholds })
        .needsReview,
    ).toBe(true);
  });

  it('honours a cautious override that raises both thresholds', () => {
    const thresholds = { autoApplyMin: 0.99, verifyMin: 0.9 };
    expect(
      applyConfidenceGate({ categoryId: CATEGORY, confidence: calibrated(0.95), fromAi: true, thresholds })
        .advisory,
    ).toBe(true);
  });

  it('still blocks a null category under an aggressive override', () => {
    const thresholds = { autoApplyMin: 0.1, verifyMin: 0.05 };
    const decision = applyConfidenceGate({
      categoryId: null,
      confidence: calibrated(1),
      fromAi: true,
      thresholds,
    });
    expect(decision.needsReview).toBe(true);
  });

  it('defaults to ADR-009 exactly when no override is supplied', () => {
    expect(DEFAULT_LANE_THRESHOLDS).toEqual({ autoApplyMin: 0.9, verifyMin: 0.6 });
    expect(laneFor(calibrated(0.9))).toBe('AUTO_APPLY');
  });
});

describe('resolveLaneThresholds — the per-Household override point', () => {
  it('returns the ADR-009 defaults for absent, empty or non-object settings', () => {
    for (const settings of [undefined, null, {}, [], 'nonsense', 42]) {
      expect(resolveLaneThresholds(settings), JSON.stringify(settings)).toEqual(
        DEFAULT_LANE_THRESHOLDS,
      );
    }
  });

  it('reads a coherent override out of households.settings', () => {
    expect(
      resolveLaneThresholds({
        classificationThresholds: { autoApplyMin: 0.8, verifyMin: 0.5 },
      }),
    ).toEqual({ autoApplyMin: 0.8, verifyMin: 0.5 });
  });

  it('ignores a malformed override rather than throwing', () => {
    // Settings is operator-editable JSON; a typo there must not make capture fail.
    for (const value of [
      { classificationThresholds: 'high' },
      { classificationThresholds: { autoApplyMin: '0.9', verifyMin: 0.6 } },
      { classificationThresholds: { autoApplyMin: 0.9 } },
      { classificationThresholds: { autoApplyMin: 1.4, verifyMin: 0.6 } },
      { classificationThresholds: { autoApplyMin: 0.9, verifyMin: -0.1 } },
      { classificationThresholds: { autoApplyMin: Number.NaN, verifyMin: 0.6 } },
    ]) {
      expect(resolveLaneThresholds(value), JSON.stringify(value)).toEqual(DEFAULT_LANE_THRESHOLDS);
    }
  });

  it('ignores an inverted pair, which would make the verify band unreachable', () => {
    // 0.95 / 0.90 reads as "auto above .95, verify above .90" but a power user typing it backwards
    // would otherwise silently accept a threshold table where no row can ever be advisory.
    expect(
      resolveLaneThresholds({ classificationThresholds: { autoApplyMin: 0.9, verifyMin: 0.95 } }),
    ).toEqual(DEFAULT_LANE_THRESHOLDS);
    expect(
      resolveLaneThresholds({ classificationThresholds: { autoApplyMin: 0.6, verifyMin: 0.6 } }),
    ).toEqual(DEFAULT_LANE_THRESHOLDS);
  });

  it('accepts the extreme endpoints of the legal range', () => {
    expect(
      resolveLaneThresholds({ classificationThresholds: { autoApplyMin: 1, verifyMin: 0 } }),
    ).toEqual({ autoApplyMin: 1, verifyMin: 0 });
    expect(
      resolveLaneThresholds({ classificationThresholds: { autoApplyMin: 0.01, verifyMin: 0 } }),
    ).toEqual({ autoApplyMin: 0.01, verifyMin: 0 });
  });
});
