/**
 * Stage 6 — the confidence gate.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §7 (the two review lanes), docs/03-domain-model.md
 * invariant **I-8**, ADR-009.
 *
 * This is the **only** place a calibrated confidence becomes a persisted decision. Everything it
 * decides is an invariant about rows the user will be shown:
 *
 * | Calibrated confidence | `status` | `needs_review` | lane |
 * |---|---|---|---|
 * | `>= 0.90` | `CONFIRMED` | `false` | auto-applied |
 * | `0.60 – 0.89` | `CONFIRMED` | `false` | **advisory** (derived, never blocking) |
 * | `< 0.60` | `PENDING` | `true` | **blocking** |
 * | no category at all | `PENDING` | `true` | **blocking**, whatever the confidence |
 *
 * Three things this file exists to keep true:
 *
 * 1. **A null category is blocking regardless of confidence.** §7's table has a `null` row with no
 *    confidence condition, and I-8 says `needs_review = true` iff `confidence < 0.60` **or**
 *    `category_id IS NULL`. A model that returns no category at 0.99 confidence must not be stored as
 *    "confidently uncategorised" — it is an unanswered question. This was flagged as a 2.2.3
 *    responsibility by task 2.2.2.
 * 2. **The advisory lane is derived, never a flag.** §7 defines it as `category_source = 'AI'` AND
 *    `confidence in [0.60, 0.90)`, so it needs no column — and `needs_review` must stay the blocking
 *    lane only, or the nav badge never clears and users learn to ignore it.
 * 3. **The gate consumes a calibrated confidence and nothing else.** `laneFor` accepts only the
 *    branded `CalibratedConfidence`, so gating on the model's self-reported number is a compile
 *    error rather than a code-review catch (ADR-009, docs/04 §6.4).
 *
 * ## Thresholds are injectable
 *
 * §7: "thresholds are per-household tunable in settings (a power user may prefer aggressive
 * auto-apply). Every threshold change is recorded in `audit_log`." {@link resolveLaneThresholds}
 * reads the override from `households.settings`, which already exists — so no table was invented —
 * and falls back to ADR-009's {@link DEFAULT_LANE_THRESHOLDS}. The *write* path for a change (the
 * settings mutation plus its `audit_log` row) is not built yet and belongs to the Household settings
 * task; see the module report.
 *
 * @module apps/api/src/modules/classification
 */

import {
  DEFAULT_LANE_THRESHOLDS,
  laneFor,
  type CalibratedConfidence,
  type ConfidenceLane,
  type LaneThresholds,
} from '@finmate/ai';

/**
 * Re-exported so this module has one import site for the lane vocabulary. The *type* and
 * {@link DEFAULT_LANE_THRESHOLDS} come from `packages/ai` — a second definition of `0.90`/`0.60`
 * here would be a silent second source of truth for ADR-009.
 */
export type { ConfidenceLane, LaneThresholds };

/** `transactions.status` / `transaction_splits.status` — the two arms the gate produces. */
export type GateStatus = 'PENDING' | 'CONFIRMED';

/** The whole of docs/04 §7's table as one value. */
export interface GateDecision {
  /**
   * The category to store, or `null`. A `null` here is always {@link blocking}, and always means
   * "uncategorised", never "no category needed".
   */
  readonly categoryId: string | null;
  /** The **calibrated** confidence stored on `transactions.confidence` and the audit row. */
  readonly confidence: CalibratedConfidence;
  /** docs/04 §7's action. `ASK` is the blocking lane; `VERIFY` is the advisory one. */
  readonly lane: ConfidenceLane;
  /** `true` iff this row is in the **blocking** lane — `needs_review` and invariant I-8. */
  readonly needsReview: boolean;
  /**
   * `true` when the row is in the derived advisory lane: it was applied from an AI suggestion at
   * `0.60–0.89`. The nav badge must **not** count these (docs/04 §7), and it is derived rather than
   * stored, so a caller that wants the badge filters on `category_source = 'AI'` + confidence.
   */
  readonly advisory: boolean;
}

/** Caller-supplied context the gate needs but cannot derive from the confidence alone. */
export interface GateInput {
  /** The decided category. `null` blocks the row no matter how confident the model was (I-8). */
  readonly categoryId: string | null;
  readonly confidence: CalibratedConfidence;
  /**
   * Whether the category came from a model. The advisory lane is defined over AI suggestions, so a
   * rule or keyword decision at `0.60–0.89` is silently applied and needs no glance. Keyword
   * decisions map into `0.90–0.97` anyway, but the explicit test keeps that from being load-bearing.
   */
  readonly fromAi: boolean;
  /** ADR-009's defaults unless the Household overrode them; see {@link resolveLaneThresholds}. */
  readonly thresholds?: LaneThresholds;
}

/**
 * Apply docs/04 §7 to a calibrated confidence and a category.
 *
 * Pure. No clock, no I/O, no database — so the gate is exhaustively testable and its behaviour cannot
 * depend on where it ran.
 */
export function applyConfidenceGate(input: GateInput): GateDecision {
  const thresholds = input.thresholds ?? DEFAULT_LANE_THRESHOLDS;
  const lane = laneFor(input.confidence, thresholds);

  // The null-category arm first, and deliberately independent of `lane`. Ordering it the other way
  // (checking the lane, then nulling the category) is how a 0.99-confident null becomes an
  // auto-applied uncategorised row — the exact failure I-8 and docs/04 §7 name.
  if (input.categoryId === null) {
    return {
      categoryId: null,
      confidence: input.confidence,
      lane,
      // I-8's first disjunct, not the lane: a null category blocks at any confidence.
      needsReview: true,
      advisory: false,
    };
  }

  const blocking = lane === 'ASK';
  return {
    categoryId: input.categoryId,
    confidence: input.confidence,
    lane,
    needsReview: blocking,
    // docs/04 §7's advisory membership: `category_source = 'AI'` AND `confidence in [0.60, 0.90)`.
    advisory: !blocking && input.fromAi && lane === 'VERIFY',
  };
}

/**
 * Resolve the lane thresholds for a Household from its `households.settings` JSONB.
 *
 * docs/04 §7 makes the thresholds per-household tunable, and `households.settings` (docs/03 §4) is
 * the storage that already exists — reading it here is the override point, and inventing a table for
 * two numbers would be a migration with no data behind it.
 *
 * A malformed or absent override falls back to ADR-009's defaults rather than throwing: settings is
 * operator-editable JSON, and a typo there must not make capture fail. An override is **only**
 * accepted when it is coherent — both numbers present, both in `0..1`, and `verifyMin` strictly below
 * `autoApplyMin`. An incoherent pair (say `0.95 / 0.90`) would make a whole band unreachable or
 * invert the lanes, so it is ignored rather than honoured.
 */
export function resolveLaneThresholds(settings: unknown): LaneThresholds {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    return DEFAULT_LANE_THRESHOLDS;
  }

  const candidate = (settings as Record<string, unknown>)['classificationThresholds'];
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return DEFAULT_LANE_THRESHOLDS;
  }

  const record = candidate as Record<string, unknown>;
  const autoApplyMin = record['autoApplyMin'];
  const verifyMin = record['verifyMin'];

  if (!isUnitNumber(autoApplyMin) || !isUnitNumber(verifyMin)) return DEFAULT_LANE_THRESHOLDS;
  if (verifyMin >= autoApplyMin) return DEFAULT_LANE_THRESHOLDS;

  return { autoApplyMin, verifyMin };
}

function isUnitNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
