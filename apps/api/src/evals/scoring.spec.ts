import { describe, expect, it } from 'vitest';

import type { CaseScore, EvalCase, ObservedCase, ObservedFragment } from './types';
import {
  GATE_THRESHOLDS,
  evaluateGates,
  failingCases,
  p95,
  scoreCase,
  scoreFragment,
  summarise,
} from './scoring';

/**
 * The scoring rules are where an evaluation harness is most dangerous: a bug here does not crash, it
 * reports a number that is wrong in the direction somebody wants. Every arm is asserted directly.
 */

function expectation(overrides: Partial<EvalCase['expected'][number]> = {}) {
  return { description: 'Lidl', categoryPath: 'Hrana / Supermarket', ...overrides };
}

function observed(overrides: Partial<ObservedFragment> = {}): ObservedFragment {
  return {
    description: 'Lidl',
    categoryId: 'cat-1',
    categoryPath: 'Hrana / Supermarket',
    confidence: 0.92,
    decidedBy: 'KEYWORD',
    alternatives: [],
    amountMinor: '19900',
    kind: 'EXPENSE',
    occurredOn: null,
    ...overrides,
  };
}

function evalCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'merchant-0001',
    slice: 'MERCHANT',
    sourceSlice: 'MERCHANT',
    rawInput: 'Lidl 199',
    today: '2026-09-14',
    ledgerCurrency: 'RSD',
    expected: [expectation({ amountMinor: '19900', kind: 'EXPENSE' })],
    provenance: 'hand-labelled',
    addedIn: '2026-09-15',
    ...overrides,
  };
}

function observedCase(fragments: readonly ObservedFragment[], overrides: Partial<ObservedCase> = {}): ObservedCase {
  return { fragments, latencyMs: 10, usedAi: false, degraded: false, ...overrides };
}

describe('scoreFragment', () => {
  it('counts top-1 only in the >= 0.90 bucket, so a correct low-confidence hit is not accuracy', () => {
    const correctButAdvisory = scoreFragment(expectation(), observed({ confidence: 0.7 }));
    expect(correctButAdvisory.predictedPath).toBe('Hrana / Supermarket');
    expect(correctButAdvisory.top1Correct).toBeNull();
    expect(correctButAdvisory.overconfidentWrong).toBe(false);
    expect(correctButAdvisory.failure).toBe('NONE');
  });

  it('flags an auto-applied wrong category as overconfident-wrong — the metric that matters', () => {
    const score = scoreFragment(
      expectation(),
      observed({ categoryPath: 'Automobil / Gorivo', confidence: 0.95 }),
    );
    expect(score.top1Correct).toBe(false);
    expect(score.overconfidentWrong).toBe(true);
    expect(score.failure).toBe('CONFIDENT_WRONG');
  });

  it('does NOT count a wrong category below the auto-apply floor as overconfident', () => {
    const score = scoreFragment(
      expectation(),
      observed({ categoryPath: 'Automobil / Gorivo', confidence: 0.8 }),
    );
    expect(score.overconfidentWrong).toBe(false);
    expect(score.failure).toBe('WRONG_CATEGORY');
  });

  it('treats an auto-applied category on a should-ask input as overconfident-wrong', () => {
    const score = scoreFragment(
      expectation({ categoryPath: null, maxConfidence: 0.6 }),
      observed({ categoryPath: 'Hrana / Supermarket', confidence: 0.92 }),
    );
    expect(score.shouldAskOk).toBe(false);
    expect(score.overconfidentWrong).toBe(true);
    expect(score.failure).toBe('CONFIDENT_WRONG');
  });

  it('passes a should-ask input that was asked about, and fails one applied in the verify band', () => {
    const asked = scoreFragment(
      expectation({ categoryPath: null, maxConfidence: 0.6 }),
      observed({ categoryPath: null, confidence: 0, decidedBy: 'FALLBACK' }),
    );
    expect(asked.shouldAskOk).toBe(true);
    expect(asked.failure).toBe('NONE');

    const appliedInVerifyBand = scoreFragment(
      expectation({ categoryPath: null, maxConfidence: 0.6 }),
      observed({ categoryPath: 'Hrana / Supermarket', confidence: 0.7 }),
    );
    expect(appliedInVerifyBand.shouldAskOk).toBe(false);
    expect(appliedInVerifyBand.overconfidentWrong).toBe(false);
    expect(appliedInVerifyBand.failure).toBe('SHOULD_ASK');
  });

  it('counts the expected path in the alternatives as top-3, not as top-1', () => {
    const score = scoreFragment(
      expectation(),
      observed({
        categoryPath: 'Hrana / Pekara',
        confidence: 0.95,
        alternatives: [
          { categoryId: 'cat-1', categoryPath: 'Hrana / Supermarket', confidence: 0.4 },
        ],
      }),
    );
    expect(score.top1Correct).toBe(false);
    expect(score.top3Correct).toBe(true);
  });

  it('reports a missing category distinctly from a wrong one', () => {
    const missing = scoreFragment(
      expectation(),
      observed({ categoryId: null, categoryPath: null, confidence: 0, decidedBy: 'FALLBACK' }),
    );
    expect(missing.failure).toBe('MISSING_CATEGORY');

    const wrong = scoreFragment(
      expectation(),
      observed({ categoryPath: 'Hrana / Pekara', confidence: 0.8 }),
    );
    expect(wrong.failure).toBe('WRONG_CATEGORY');
  });

  it('always checks the description, and only asserts the parsing fields the case pinned', () => {
    // The description is what the parser produced, so it is checked on every observed fragment.
    expect(scoreFragment(expectation(), observed()).extractionOk).toBe(true);
    expect(
      scoreFragment(expectation(), observed({ description: 'Maxi' })).extractionOk,
    ).toBe(false);

    // `amountMinor: null` is an assertion that there is no amount; a missing key asserts nothing.
    const pinnedNull = scoreFragment(
      expectation({ amountMinor: null }),
      observed({ amountMinor: null }),
    );
    expect(pinnedNull.extractionOk).toBe(true);
    const violated = scoreFragment(expectation({ amountMinor: null }), observed());
    expect(violated.extractionOk).toBe(false);
    expect(violated.failure).toBe('EXTRACTION');

    // A fragment the pipeline never produced: segmentation has already failed the case, so there is
    // nothing to assert about its extraction.
    expect(scoreFragment(expectation(), undefined).extractionOk).toBeNull();
  });

  it('compares money as strings, never as floats (ADR-003)', () => {
    const score = scoreFragment(
      expectation({ amountMinor: '200000' }),
      observed({ amountMinor: '200000' }),
    );
    expect(score.extractionOk).toBe(true);
  });
});

describe('scoreCase', () => {
  it('marks a segmentation mismatch as the case failure, whatever the fragments say', () => {
    const testCase = evalCase({
      slice: 'BULK',
      rawInput: 'Lidl 2000, gorivo 3500',
      expected: [expectation(), expectation({ description: 'gorivo', categoryPath: 'Automobil / Gorivo' })],
    });
    const score = scoreCase(testCase, observedCase([observed()]));
    expect(score.segmentationOk).toBe(false);
    expect(score.failure).toBe('SEGMENTATION');
  });

  it('passes a case whose fragments all match', () => {
    const score = scoreCase(evalCase(), observedCase([observed()]));
    expect(score.failure).toBe('NONE');
    expect(score.segmentationOk).toBe(true);
  });
});

describe('summarise', () => {
  const scores: readonly CaseScore[] = [
    scoreCase(evalCase({ id: 'a' }), observedCase([observed()])),
    scoreCase(
      evalCase({ id: 'b' }),
      observedCase([observed({ categoryPath: 'Automobil / Gorivo', confidence: 0.95 })]),
    ),
    scoreCase(
      evalCase({ id: 'c', slice: 'SHOULD_ASK', expected: [expectation({ categoryPath: null, maxConfidence: 0.6 })] }),
      observedCase([observed({ categoryPath: null, confidence: 0, decidedBy: 'FALLBACK' })]),
    ),
  ];

  it('computes the rule-hit ratio over cheap-path decisions', () => {
    const metrics = summarise(scores);
    const merchant = metrics.find((slice) => slice.slice === 'MERCHANT');
    expect(merchant?.ruleHitRatio).toBe(1);
    expect(merchant?.top1Bucket).toBe(2);
    expect(merchant?.top1Accuracy).toBe(0.5);
    expect(merchant?.overconfidentWrong).toBe(0.5);
  });

  it('separates the should-ask slice and measures its recall', () => {
    const shouldAsk = summarise(scores).find((slice) => slice.slice === 'SHOULD_ASK');
    expect(shouldAsk?.shouldAskRecall).toBe(1);
    expect(shouldAsk?.top1Accuracy).toBeNull();
    expect(shouldAsk?.segmentationAccuracy).toBe(1);
  });

  it('returns null rather than zero for a rate the slice cannot speak to', () => {
    const onlyUnlabelled = summarise([
      scoreCase(
        evalCase({ slice: 'SHOULD_ASK', expected: [expectation({ categoryPath: null, maxConfidence: 0.6 })] }),
        observedCase([observed({ categoryPath: null, confidence: 0 })]),
      ),
    ]);
    // No fragment carries a category label, so there is no accuracy to report — `null`, not `0`,
    // because `0 %` would read as a total failure of something that was never measured.
    expect(onlyUnlabelled[0]?.top1Accuracy).toBeNull();
    expect(onlyUnlabelled[0]?.top3Accuracy).toBeNull();
    expect(onlyUnlabelled[0]?.top1Bucket).toBe(0);
  });
});

describe('evaluateGates', () => {
  it('skips the narration gates instead of passing them, because NARRATE does not exist', () => {
    const gates = evaluateGates([scoreCase(evalCase(), observedCase([observed()]))]);
    const narration = gates.filter((gate) => gate.metric.includes('narration'));
    expect(narration).toHaveLength(2);
    for (const gate of narration) {
      expect(gate.passed).toBeNull();
      expect(gate.value).toBeNull();
      expect(gate.skipped).toBeTruthy();
    }
  });

  it('fails the overconfident-wrong gate when a confident decision is wrong', () => {
    const gates = evaluateGates([
      scoreCase(evalCase(), observedCase([observed({ categoryPath: 'Automobil / Gorivo', confidence: 0.95 })])),
    ]);
    const gate = gates.find((result) => result.metric.startsWith('Overconfident-wrong'));
    expect(gate?.value).toBe(1);
    expect(gate?.passed).toBe(false);
  });

  it('passes a perfect run and reports the rule-hit ratio as a Phase 2 gate', () => {
    const gates = evaluateGates([
      scoreCase(evalCase(), observedCase([observed()])),
      scoreCase(
        evalCase({ id: 'b', slice: 'SHOULD_ASK', expected: [expectation({ categoryPath: null, maxConfidence: 0.6 })] }),
        observedCase([observed({ categoryPath: null, confidence: 0, decidedBy: 'FALLBACK' })]),
      ),
    ]);
    const ruleHit = gates.find((gate) => gate.metric.startsWith('Rule-hit'));
    expect(ruleHit?.source).toBe('docs/09 §4');
    expect(ruleHit?.passed).toBe(true);
    expect(ruleHit?.value).toBe(0.5);
    expect(gates.filter((gate) => gate.passed === false)).toHaveLength(0);
  });

  it('does not count an AI decision as a rule hit', () => {
    const gates = evaluateGates([
      scoreCase(evalCase(), observedCase([observed({ decidedBy: 'AI' })])),
    ]);
    expect(gates.find((gate) => gate.metric.startsWith('Rule-hit'))?.value).toBe(0);
    expect(GATE_THRESHOLDS.ruleHitRatio).toBe(0.5);
  });

  it('measures but does not enforce a provider gate while no provider is configured', () => {
    // top-3 grades a model's ranked candidates. With no model the list is empty, so the metric is not
    // the quantity docs/04 §11.2 describes — but the number is still reported, never hidden.
    const scores = [
      scoreCase(evalCase(), observedCase([observed({ categoryPath: 'Hrana / Pekara', confidence: 0.8 })])),
    ];

    const withoutProvider = evaluateGates(scores, false);
    const top3 = withoutProvider.find((gate) => gate.metric.includes('top-3'));
    expect(top3?.requiresProvider).toBe(true);
    expect(top3?.passed).toBeNull();
    expect(top3?.value).toBe(0);
    expect(top3?.skipped).toBeTruthy();

    const withProvider = evaluateGates(scores, true);
    expect(withProvider.find((gate) => gate.metric.includes('top-3'))?.passed).toBe(false);
  });

  it('keeps the overconfident-wrong gate enforced even without a provider', () => {
    // It is the one number that does not need a model to mean something: the deterministic ladder can
    // be confidently wrong on its own, and that is exactly what the harness found on its first run.
    const gates = evaluateGates(
      [scoreCase(evalCase(), observedCase([observed({ categoryPath: 'Hrana / Pekara', confidence: 0.95 })]))],
      false,
    );
    const gate = gates.find((result) => result.metric.startsWith('Overconfident-wrong'));
    expect(gate?.requiresProvider).toBeUndefined();
    expect(gate?.passed).toBe(false);
  });
});

describe('p95', () => {
  it('uses the nearest rank, not an interpolation', () => {
    expect(p95([])).toBe(0);
    expect(p95([5])).toBe(5);
    expect(p95([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(10);
    expect(p95(Array.from({ length: 100 }, (_, index) => index + 1))).toBe(95);
  });
});

describe('failingCases', () => {
  it('sorts the worst failure first and caps the list', () => {
    const cases = [evalCase({ id: 'a' }), evalCase({ id: 'b' })];
    const scores = [
      scoreCase(cases[0]!, observedCase([observed({ categoryPath: 'Hrana / Pekara', confidence: 0.8 })])),
      scoreCase(cases[1]!, observedCase([observed({ categoryPath: 'Hrana / Pekara', confidence: 0.95 })])),
    ];
    const failing = failingCases(scores, cases);
    expect(failing.map((entry) => entry.id)).toEqual(['b', 'a']);
    expect(failing[0]?.failure).toBe('CONFIDENT_WRONG');
    expect(failingCases(scores, cases, 1)).toHaveLength(1);
  });
});
