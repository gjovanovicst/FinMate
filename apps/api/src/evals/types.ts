/**
 * The Phase 2 evaluation harness — shapes.
 *
 * Owner: docs/10-testing-and-quality.md §5 (the harness), docs/04 §11 (the dataset and the gates).
 *
 * ## What this harness is, and what it is not
 *
 * It is **layer 6** of docs/10 §1 reduced to what Phase 2 can honestly measure: the real pipeline,
 * the real seeded knowledge, deterministic scoring, no LLM judge, no network. It is *not* the nightly
 * `evals.nightly` runner: that needs live providers, the full 1 300-case composition, the `evals`
 * schema and trends over 60 runs (docs/10 §5.4–§5.7). This one runs in CI in seconds and answers the
 * two Phase 2 exit questions that the deterministic suite cannot:
 *
 * 1. **How often does the cheap path decide?** — the rule-hit ratio (docs/09 §4).
 * 2. **How often is it confidently wrong?** — the overconfident-wrong rate (docs/04 §11.2).
 *
 * ## The dataset is the v1 golden set plus labels, not a copy of it
 *
 * The 300 v1 cases and their *parsing* expectations live in `packages/nlp/test/golden/fixtures/` and
 * are read here as data. This harness adds only what parsing cannot state: the category a human
 * labelled from the text alone. One document, two views of it — so the two can never drift into
 * disagreeing about what a case says.
 *
 * @module apps/api/src/evals
 */

/** docs/10 §5.1's slice vocabulary, restricted to the slices v1 actually ships. */
export type EvalSlice = 'MERCHANT' | 'AMOUNT_FORMAT' | 'BULK' | 'SHOULD_ASK';

/** The slice a case came from in the v1 golden dataset. */
export type GoldenSliceName = 'MERCHANT' | 'AMOUNT_FORMAT' | 'BULK';

/** One fragment's expectation, parsed from the two documents that describe it. */
export interface EvalFragmentExpectation {
  /** The folded description `@finmate/nlp` extracts — the key the labelling table is written in. */
  readonly description: string;
  /** The category a human named from the text alone, or `null` when the case is a should-ask. */
  readonly categoryPath: string | null;
  /**
   * Present only on a should-ask fragment: the calibrated-confidence ceiling it must stay under
   * (docs/04 §7's verify floor). Absent means "no confidence requirement".
   */
  readonly maxConfidence?: number;
  /** Parsing expectations, copied from the v1 case so extraction is graded from the same run. */
  readonly amountMinor?: string | null;
  readonly kind?: 'EXPENSE' | 'INCOME' | 'UNKNOWN';
  readonly occurredOn?: string | null;
}

/** One scoreable case: a fragment list expectation plus the input that produced it. */
export interface EvalCase {
  /** The v1 golden id (`merchant-0042`), stable forever. */
  readonly id: string;
  readonly slice: EvalSlice;
  readonly sourceSlice: GoldenSliceName;
  /** Exactly what the user typed. */
  readonly rawInput: string;
  /** The day relative dates resolve against. The harness never reads the clock. */
  readonly today: string;
  /** Household ledger currency, used when the text names none. */
  readonly ledgerCurrency: string;
  readonly expected: readonly EvalFragmentExpectation[];
  /** Why a label is what it is — mandatory on should-ask cases. */
  readonly note?: string;
  readonly provenance: 'hand-labelled' | 'synthetic';
  readonly addedIn: string;
}

/** One fragment as the pipeline actually decided it. */
export interface ObservedFragment {
  readonly description: string;
  readonly categoryId: string | null;
  /** Resolved from the seeded tree, so scoring compares paths and not opaque ids. */
  readonly categoryPath: string | null;
  /** The **calibrated** confidence (ADR-009) — the gates never look at a raw number. */
  readonly confidence: number;
  readonly decidedBy: string;
  /** The losing candidates, in order, for top-3 scoring. */
  readonly alternatives: readonly {
    readonly categoryId: string;
    readonly categoryPath: string | null;
    readonly confidence: number;
  }[];
  readonly amountMinor: string | null;
  readonly kind: 'EXPENSE' | 'INCOME' | 'UNKNOWN';
  readonly occurredOn: string | null;
}

/** One case as the pipeline actually handled it. */
export interface ObservedCase {
  readonly fragments: readonly ObservedFragment[];
  readonly latencyMs: number;
  readonly usedAi: boolean;
  readonly degraded: boolean;
}

/** How a case failed, in the order the product cares about. */
export type FailureKind =
  | 'NONE'
  /** Segmentation produced a different number of fragments than the case expects. */
  | 'SEGMENTATION'
  /** Amount, kind or date differed from the expectation. */
  | 'EXTRACTION'
  /** Confident (>= 0.90) **and** the wrong category — the metric that matters (docs/04 §11.2). */
  | 'CONFIDENT_WRONG'
  /** Applied a category where none can be defended from the text (should-ask failed). */
  | 'SHOULD_ASK'
  /** No category at all where the case labels one. */
  | 'MISSING_CATEGORY'
  /** A category, but the wrong one, below the auto-apply floor. */
  | 'WRONG_CATEGORY';

/** One fragment's score. `null` for a metric the case cannot speak to. */
export interface FragmentScore {
  readonly description: string;
  readonly expectedPath: string | null;
  readonly predictedPath: string | null;
  readonly confidence: number;
  readonly decidedBy: string;
  /** docs/10 §5.4: top-1 is counted only in the calibrated `>= 0.90` bucket. */
  readonly top1Correct: boolean | null;
  readonly top3Correct: boolean | null;
  readonly overconfidentWrong: boolean;
  /** `null` when the fragment is not a should-ask. */
  readonly shouldAskOk: boolean | null;
  /** `null` when the fragment was not produced at all — segmentation has already failed the case. */
  readonly extractionOk: boolean | null;
  readonly failure: FailureKind;
}

/** One case's score, with its fragments. */
export interface CaseScore {
  readonly id: string;
  readonly slice: EvalSlice;
  readonly sourceSlice: GoldenSliceName;
  /** `BULK` cases assert how many fragments segmentation produced. */
  readonly segmentationOk: boolean;
  readonly latencyMs: number;
  readonly fragments: readonly FragmentScore[];
  /** The most serious failure across the case's fragments, or `NONE`. */
  readonly failure: FailureKind;
}

/** The whole run, ready to serialise and to gate on. */
export interface EvalReport {
  readonly runId: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly commitSha: string;
  /** The pinned triple docs/10 §5.4 requires. `none` here is a fact, not a placeholder. */
  readonly pinned: {
    readonly promptTemplateId: string | null;
    readonly promptVersion: number | null;
    readonly aiProvider: string;
    readonly aiModel: string;
  };
  readonly cases: number;
  readonly slices: readonly SliceMetrics[];
  readonly gates: readonly GateResult[];
  readonly passed: boolean;
  /** The cases that failed, worst first — `evals.failing_case`'s stand-in (docs/10 §5.7). */
  readonly failing: readonly FailingCase[];
}

/** Per-slice aggregate. Every rate is `null` when the slice has no fragment that speaks to it. */
export interface SliceMetrics {
  readonly slice: EvalSlice;
  readonly cases: number;
  readonly fragments: number;
  /** Fragments the cheap path decided: rule, keyword, merchant/counterparty default. */
  readonly ruleHitRatio: number;
  readonly top1Bucket: number;
  readonly top1Accuracy: number | null;
  readonly top3Accuracy: number | null;
  readonly overconfidentWrong: number;
  readonly shouldAskRecall: number | null;
  readonly extractionAccuracy: number | null;
  readonly segmentationAccuracy: number | null;
  readonly p95LatencyMs: number;
  readonly decidedBy: Readonly<Record<string, number>>;
}

/** One gate from docs/04 §11.2, and whether it could be evaluated at all. */
export interface GateResult {
  readonly metric: string;
  readonly threshold: string;
  readonly value: number | null;
  readonly passed: boolean | null;
  /** Why a gate is `null`: a feature it depends on does not exist in this build. */
  readonly skipped?: string;
  /**
   * The gate needs a configured model to mean what docs/04 §11.2 says it means, so it is measured but
   * not enforced while `pinned.aiProvider` is `none`. The measured value is still reported: a harness
   * that hid the number would be worse than one that gates it too early.
   */
  readonly requiresProvider?: true;
  readonly source: string;
}

/** One failing case, for the report and for the next prompt iteration. */
export interface FailingCase {
  readonly id: string;
  readonly slice: EvalSlice;
  readonly rawInput: string;
  readonly description: string;
  readonly expectedPath: string | null;
  readonly predictedPath: string | null;
  readonly confidence: number;
  readonly decidedBy: string;
  readonly failure: FailureKind;
}
