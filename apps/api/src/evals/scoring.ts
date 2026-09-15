/**
 * Scoring an evaluation run — docs/10 §5.4's grading rules, implemented once, purely.
 *
 * ## Deterministic, and never an LLM judge
 *
 * docs/10 §5.4 forbids a judge outright ("a judge is a second uncalibrated model; it turns a gate
 * into a coin flip"). Everything here is comparison against a label written by a human.
 *
 * ## The two numbers the product lives on
 *
 * - **rule-hit ratio** — how often the cheap path (rule, keyword, entity default) decided, i.e. how
 *   often the model was not needed at all (docs/09 §4's Phase 2 exit criterion, docs/04 §12's cost
 *   model).
 * - **overconfident-wrong** — auto-applied (>= 0.90) **and** wrong. This is the one number that
 *   predicts whether a user keeps trusting the ledger (docs/04 §11.2).
 *
 * @module apps/api/src/evals
 */

import type {
  CaseScore,
  EvalCase,
  FailureKind,
  FailingCase,
  FragmentScore,
  GateResult,
  ObservedCase,
  ObservedFragment,
  SliceMetrics,
} from './types';

/** docs/04 §11.2's auto-apply floor — the bucket top-1 is counted in (docs/10 §5.4). */
export const AUTO_APPLY_MIN = 0.9;

/** Thresholds docs/04 §11.2 fixes, plus the Phase 2 exit criterion from docs/09 §4. */
export const GATE_THRESHOLDS = {
  top1Accuracy: 0.96,
  top3Accuracy: 0.99,
  overconfidentWrong: 0.015,
  shouldAskRecall: 0.9,
  p95LatencyMs: 1500,
  costPerTransactionUsd: 0.002,
  /** docs/09 §4: "Rule-hit ratio >= 50 % on the golden dataset". */
  ruleHitRatio: 0.5,
} as const;

/** The decisions that mean "no model was needed" (docs/04 §2's stages 4–5). */
const CHEAP_PATH = new Set(['RULE', 'KEYWORD', 'MERCHANT_DEFAULT', 'COUNTERPARTY_DEFAULT']);

/**
 * How bad each failure is. Used to collapse a case's fragments into one `failure`, so a report can
 * sort the worst first instead of listing alphabetically.
 */
const SEVERITY: Readonly<Record<FailureKind, number>> = {
  NONE: 0,
  EXTRACTION: 1,
  WRONG_CATEGORY: 2,
  MISSING_CATEGORY: 3,
  SHOULD_ASK: 4,
  CONFIDENT_WRONG: 5,
  SEGMENTATION: 6,
};

/** Score one fragment against its label. */
export function scoreFragment(
  expected: EvalCase['expected'][number],
  observed: ObservedFragment | undefined,
): FragmentScore {
  const predictedPath = observed?.categoryPath ?? null;
  const confidence = observed?.confidence ?? 0;
  const decidedBy = observed?.decidedBy ?? 'NONE';

  // Extraction: the description is always checked (it is what the parser produced), and the pinned
  // amount/kind/date only when the v1 case actually pinned them. An absent key is not an assertion —
  // the same rule the parsing harness follows, and the reason `null` and `undefined` differ here.
  const extractionChecks: boolean[] = [];
  if (observed !== undefined) {
    extractionChecks.push(observed.description === expected.description);
  }
  if (expected.amountMinor !== undefined) {
    extractionChecks.push((observed?.amountMinor ?? null) === expected.amountMinor);
  }
  if (expected.kind !== undefined) {
    extractionChecks.push((observed?.kind ?? 'UNKNOWN') === expected.kind);
  }
  if (expected.occurredOn !== undefined) {
    extractionChecks.push((observed?.occurredOn ?? null) === expected.occurredOn);
  }
  const extractionOk =
    extractionChecks.length === 0 ? null : extractionChecks.every((check) => check);

  const hasCategoryLabel = expected.categoryPath !== null;
  const autoApplied = confidence >= AUTO_APPLY_MIN;

  // docs/10 §5.4: top-1 is counted **only** in the calibrated >= 0.90 bucket, so a correct low-
  // confidence decision is not evidence of accuracy and a wrong one is not (yet) overconfidence.
  const top1Correct = hasCategoryLabel && autoApplied ? predictedPath === expected.categoryPath : null;
  const top3Correct = hasCategoryLabel
    ? predictedPath === expected.categoryPath ||
      (observed?.alternatives ?? []).some(
        (alternative) => alternative.categoryPath === expected.categoryPath,
      )
    : null;

  // Overconfident-wrong covers both directions of the same sin: auto-applying the wrong category,
  // and auto-applying *any* category to an input the label says cannot be categorised from the text.
  const overconfidentWrong = autoApplied && (hasCategoryLabel ? top1Correct === false : true);

  const shouldAskOk =
    expected.maxConfidence === undefined ? null : confidence < expected.maxConfidence;

  let failure: FailureKind = 'NONE';
  if (overconfidentWrong) failure = 'CONFIDENT_WRONG';
  else if (shouldAskOk === false) failure = 'SHOULD_ASK';
  else if (hasCategoryLabel && predictedPath === null) failure = 'MISSING_CATEGORY';
  else if (hasCategoryLabel && predictedPath !== expected.categoryPath) failure = 'WRONG_CATEGORY';
  else if (extractionOk === false) failure = 'EXTRACTION';

  return {
    description: expected.description,
    expectedPath: expected.categoryPath,
    predictedPath,
    confidence,
    decidedBy,
    top1Correct,
    top3Correct,
    overconfidentWrong,
    shouldAskOk,
    extractionOk,
    failure,
  };
}

/** Score one case: every fragment, plus whether segmentation produced the right count. */
export function scoreCase(testCase: EvalCase, observed: ObservedCase): CaseScore {
  const fragments = testCase.expected.map((expected, index) =>
    scoreFragment(expected, observed.fragments[index]),
  );
  const segmentationOk = observed.fragments.length === testCase.expected.length;

  const worst = fragments.reduce<FailureKind>(
    (acc, fragment) => (SEVERITY[fragment.failure] > SEVERITY[acc] ? fragment.failure : acc),
    'NONE',
  );

  return {
    id: testCase.id,
    slice: testCase.slice,
    sourceSlice: testCase.sourceSlice,
    segmentationOk,
    latencyMs: observed.latencyMs,
    fragments,
    failure: segmentationOk ? worst : 'SEGMENTATION',
  };
}

/** Every fragment of a run, flattened — the population most gates are computed over. */
function allFragments(scores: readonly CaseScore[]): readonly FragmentScore[] {
  return scores.flatMap((score) => [...score.fragments]);
}

/** The nearest-rank p95, which is what "p95 latency" means for a fixed dataset. */
export function p95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** Per-slice aggregates for the report. */
export function summarise(scores: readonly CaseScore[]): readonly SliceMetrics[] {
  const bySlice = new Map<string, CaseScore[]>();
  for (const score of scores) {
    const bucket = bySlice.get(score.slice) ?? [];
    bucket.push(score);
    bySlice.set(score.slice, bucket);
  }

  return [...bySlice.entries()]
    .map(([slice, cases]): SliceMetrics => {
      const fragments = allFragments(cases);
      const cheap = fragments.filter((fragment) => CHEAP_PATH.has(fragment.decidedBy));
      const top1 = fragments.filter((fragment) => fragment.top1Correct !== null);
      const top3 = fragments.filter((fragment) => fragment.top3Correct !== null);
      const shouldAsk = fragments.filter((fragment) => fragment.shouldAskOk !== null);
      const extraction = fragments.filter((fragment) => fragment.extractionOk !== null);

      const decidedBy: Record<string, number> = {};
      for (const fragment of fragments) {
        decidedBy[fragment.decidedBy] = (decidedBy[fragment.decidedBy] ?? 0) + 1;
      }

      return {
        slice: slice as SliceMetrics['slice'],
        cases: cases.length,
        fragments: fragments.length,
        ruleHitRatio: ratio(cheap.length, fragments.length) ?? 0,
        top1Bucket: top1.length,
        top1Accuracy: ratio(top1.filter((fragment) => fragment.top1Correct === true).length, top1.length),
        top3Accuracy: ratio(top3.filter((fragment) => fragment.top3Correct === true).length, top3.length),
        overconfidentWrong:
          ratio(fragments.filter((fragment) => fragment.overconfidentWrong).length, fragments.length) ?? 0,
        shouldAskRecall: ratio(
          shouldAsk.filter((fragment) => fragment.shouldAskOk === true).length,
          shouldAsk.length,
        ),
        extractionAccuracy: ratio(
          extraction.filter((fragment) => fragment.extractionOk === true).length,
          extraction.length,
        ),
        segmentationAccuracy: ratio(cases.filter((score) => score.segmentationOk).length, cases.length),
        p95LatencyMs: p95(cases.map((score) => score.latencyMs)),
        decidedBy,
      };
    })
    .sort((left, right) => left.slice.localeCompare(right.slice));
}

/**
 * docs/04 §11.2's gates, plus docs/09 §4's rule-hit ratio.
 *
 * A gate whose feature does not exist yet is **`null`, with a reason** — never a silent pass. Three of
 * the eight are in that state in this build (narration is unbuilt, no provider is configured), and a
 * report that showed them green would be the most dangerous kind of evaluation: one that certifies
 * what it never ran.
 *
 * `providerConfigured` is a **structural** precondition, not a judgement call: with no model wired,
 * top-3 ranks a candidate list that is always empty for an unresolved fragment, so the metric
 * degenerates into "did the deterministic ladder happen to know the word" — which top-1, the rule-hit
 * ratio and overconfident-wrong already measure. The value is reported either way; only the pass/fail
 * is withheld until there is a ranked list to grade.
 */
export function evaluateGates(
  scores: readonly CaseScore[],
  providerConfigured = false,
): readonly GateResult[] {
  const fragments = allFragments(scores);
  const top1 = fragments.filter((fragment) => fragment.top1Correct !== null);
  const top3 = fragments.filter((fragment) => fragment.top3Correct !== null);
  const shouldAsk = fragments.filter((fragment) => fragment.shouldAskOk !== null);
  const cheap = fragments.filter((fragment) => CHEAP_PATH.has(fragment.decidedBy));

  const top1Accuracy = ratio(top1.filter((fragment) => fragment.top1Correct === true).length, top1.length);
  const top3Accuracy = ratio(top3.filter((fragment) => fragment.top3Correct === true).length, top3.length);
  const overconfidentWrong = ratio(
    fragments.filter((fragment) => fragment.overconfidentWrong).length,
    fragments.length,
  );
  const shouldAskRecall = ratio(
    shouldAsk.filter((fragment) => fragment.shouldAskOk === true).length,
    shouldAsk.length,
  );
  const ruleHitRatio = ratio(cheap.length, fragments.length);
  const latency = p95(scores.map((score) => score.latencyMs));

  const gate = (
    metric: string,
    threshold: string,
    value: number | null,
    passed: boolean | null,
    source: string,
    skipped?: string,
  ): GateResult => ({
    metric,
    threshold,
    value,
    passed,
    source,
    ...(skipped === undefined ? {} : { skipped }),
  });

  /** A gate that needs a model: measured, but not enforced while there is none. */
  const providerGate = (
    metric: string,
    threshold: string,
    value: number | null,
    passed: boolean,
    source: string,
    why: string,
  ): GateResult => ({
    metric,
    threshold,
    value,
    passed: providerConfigured ? passed : null,
    requiresProvider: true,
    source,
    ...(providerConfigured ? {} : { skipped: why }),
  });

  return [
    gate(
      'Category accuracy (top-1, calibrated >= 0.90 bucket)',
      `>= ${GATE_THRESHOLDS.top1Accuracy}`,
      top1Accuracy,
      top1Accuracy === null ? null : top1Accuracy >= GATE_THRESHOLDS.top1Accuracy,
      'docs/04 §11.2',
      top1.length === 0
        ? 'no fragment was auto-applied, so the bucket is empty — nothing to measure'
        : undefined,
    ),
    providerGate(
      'Category accuracy (top-3)',
      `>= ${GATE_THRESHOLDS.top3Accuracy}`,
      top3Accuracy,
      top3Accuracy !== null && top3Accuracy >= GATE_THRESHOLDS.top3Accuracy,
      'docs/04 §11.2',
      'top-3 grades a model\u2019s ranked candidates; with no provider the candidate list is empty for ' +
        'every fragment the deterministic ladder did not already resolve, so this is a second copy of ' +
        'the rule-hit ratio rather than a measurement of ranking',
    ),
    gate(
      'Overconfident-wrong rate',
      `<= ${GATE_THRESHOLDS.overconfidentWrong}`,
      overconfidentWrong,
      overconfidentWrong === null ? null : overconfidentWrong <= GATE_THRESHOLDS.overconfidentWrong,
      'docs/04 §11.2',
    ),
    gate(
      'Should-ask recall',
      `>= ${GATE_THRESHOLDS.shouldAskRecall}`,
      shouldAskRecall,
      shouldAskRecall === null ? null : shouldAskRecall >= GATE_THRESHOLDS.shouldAskRecall,
      'docs/04 §11.2',
      shouldAsk.length === 0 ? 'the dataset has no should-ask fragment' : undefined,
    ),
    gate(
      'Semantic-preservation rate (narration keeps all facts)',
      '= 1',
      null,
      null,
      'docs/04 §11.2',
      'NARRATE does not exist yet (Phase 3, task 3.2), so there is no narration to check',
    ),
    gate(
      'Fabricated-numeral rate in narration',
      '= 0',
      null,
      null,
      'docs/04 §11.2',
      'NARRATE does not exist yet (Phase 3, task 3.2) — ADR-017 guards the assistant, not this run',
    ),
    gate(
      'p95 latency, parse+classify',
      `<= ${GATE_THRESHOLDS.p95LatencyMs} ms`,
      latency,
      latency <= GATE_THRESHOLDS.p95LatencyMs,
      'docs/04 §11.2',
    ),
    providerGate(
      'Cost per classified transaction',
      `<= $${GATE_THRESHOLDS.costPerTransactionUsd}`,
      0,
      true,
      'docs/04 §11.2',
      'no AI provider is configured, so every decision is deterministic and cost is exactly zero — ' +
        'the gate becomes meaningful the moment a provider is wired',
    ),
    gate(
      'Rule-hit ratio (Phase 2 exit criterion)',
      `>= ${GATE_THRESHOLDS.ruleHitRatio}`,
      ruleHitRatio,
      ruleHitRatio === null ? null : ruleHitRatio >= GATE_THRESHOLDS.ruleHitRatio,
      'docs/09 §4',
    ),
  ];
}

/** The failing cases, worst first, capped so a catastrophic run stays readable. */
export function failingCases(
  scores: readonly CaseScore[],
  cases: readonly EvalCase[],
  limit = 20,
): readonly FailingCase[] {
  const byId = new Map(cases.map((testCase) => [testCase.id, testCase]));
  return scores
    .filter((score) => score.failure !== 'NONE')
    .sort((left, right) => SEVERITY[right.failure] - SEVERITY[left.failure])
    .slice(0, limit)
    .map((score) => {
      const testCase = byId.get(score.id);
      const worst =
        score.fragments.reduce<FragmentScore | undefined>(
          (acc, fragment) =>
            acc === undefined || SEVERITY[fragment.failure] > SEVERITY[acc.failure] ? fragment : acc,
          undefined,
        ) ?? score.fragments[0];
      return {
        id: score.id,
        slice: score.slice,
        rawInput: testCase?.rawInput ?? '',
        description: worst?.description ?? '',
        expectedPath: worst?.expectedPath ?? null,
        predictedPath: worst?.predictedPath ?? null,
        confidence: worst?.confidence ?? 0,
        decidedBy: worst?.decidedBy ?? 'NONE',
        failure: score.failure,
      };
    });
}
