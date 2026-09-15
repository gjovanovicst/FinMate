/**
 * Confidence calibration — docs/04-categorization-and-ai-engine.md §6.4, docs/10 §5.7, ADR-009.
 *
 * A model's self-reported confidence is not a probability, so it is never the number the gates
 * consume. This module fits an isotonic — monotone non-decreasing — map from raw confidence to
 * observed acceptance, and applies it. {@link laneFor} then accepts only a
 * {@link CalibratedConfidence}, which makes gating on the raw number a compile error rather than a
 * code-review catch.
 *
 * ## Pure and I/O-free on purpose
 *
 * Logging `(raw_confidence, was_accepted)` pairs and persisting or re-fitting the map are the
 * caller's job: the classification module (task 2.2.3) writes the observations, the weekly job
 * re-fits from `corrections` + `classification_decisions`. `scope:ai` has no database dependency and
 * must not grow one (`eslint.config.mjs`), so this module only *computes* from samples it is handed
 * and *applies* a map it is handed. That also keeps the arithmetic unit-testable at the level where
 * a wrong mapping moves money between the auto-apply and ask lanes.
 *
 * ## The map is plain, serialisable data
 *
 * A {@link CalibrationMap} is JSON-safe: numbers, strings and arrays of `{ raw, calibrated }`. The
 * weekly re-fit writes one per `(task, model, prompt_version)` and the request path reads it back
 * through {@link parseCalibrationMap}. Nothing here is a class, a function, a `Map` or a `Date`, so
 * `JSON.stringify`/`JSON.parse` round-trips it exactly.
 *
 * ## Below 200 samples the shrink is load-bearing
 *
 * §6.4: when there is insufficient data, `calibrated = raw × 0.85`. That is the conservative
 * direction and it is the property that stops an uncalibrated model from silently auto-applying to
 * money: a raw `0.95` becomes `0.8075`, which lands in the *verify* lane, not auto-apply.
 *
 * @module @finmate/ai
 */

import type { PromptRef, Task } from './provider';
import { TASKS } from './provider';
import { clampConfidence } from './validation';

/**
 * docs/04 §6.4's threshold: below this many observations the isotonic fit is not used and the
 * conservative shrink applies instead.
 */
export const MIN_CALIBRATION_SAMPLES = 200;

/**
 * docs/04 §6.4's conservative shrink factor. Deliberately below 1: it moves a raw confidence that
 * merely *looks* gate-crossing down into the verify lane (`0.95 × 0.85 = 0.8075 < 0.90`).
 */
export const SHRINK_FACTOR = 0.85;

/** Bumped when the serialised {@link CalibrationMap} shape changes; a stored map of another version is rejected. */
export const CALIBRATION_MAP_VERSION = 1;

/** AGENTS.md rule 8 / ADR-009: `≥ 0.90` auto-applies. */
export const AUTO_APPLY_MIN = 0.9;

/** AGENTS.md rule 8 / ADR-009: `0.60 – 0.89` is applied but marked for verification. */
export const VERIFY_MIN = 0.6;

// --- the two confidences ------------------------------------------------------------------------

declare const RAW_CONFIDENCE: unique symbol;
declare const CALIBRATED_CONFIDENCE: unique symbol;

/**
 * A confidence exactly as the model reported it.
 *
 * Branded so it cannot be confused with, or silently substituted for, a calibrated one. The brand
 * symbol is module-private, so outside this module the only way to obtain one is
 * {@link asRawConfidence} (which clamps into `0..1`) — a visible conversion.
 */
export type RawConfidence = number & { readonly [RAW_CONFIDENCE]: 'raw' };

/**
 * A confidence that has been through a {@link CalibrationMap} and is therefore admissible to the
 * gates. Constructed only by {@link calibrate}, {@link applyCalibrationMap} or
 * {@link calibratedConfidenceFromStorage}.
 */
export type CalibratedConfidence = number & { readonly [CALIBRATED_CONFIDENCE]: 'calibrated' };

/**
 * Clamp a model-reported confidence into `0..1` and brand it.
 *
 * A value outside the range is *handled*, not propagated: `1.4` becomes `1`, `-0.2` becomes `0`
 * and a non-number becomes `0` (the ask lane, never a confident lie). Delegates to
 * {@link clampConfidence} so there is exactly one clamp in the package.
 */
export function asRawConfidence(value: unknown): RawConfidence {
  return clampConfidence(value) as RawConfidence;
}

/**
 * Brand a calibrated confidence read back from storage, e.g. `classification_decisions.confidence`
 * (docs/06 §"the confidence is the calibrated value").
 *
 * **The only legitimate input is a value this module previously produced and a caller persisted.**
 * Never pass a model's raw number here: that is precisely the raw-gating footgun
 * {@link calibrate} exists to make impossible. The loud name is the guard — it is greppable, and it
 * appears nowhere the request path can reach by accident. Still clamps, so a corrupt stored value
 * cannot escape `0..1`.
 */
export function calibratedConfidenceFromStorage(value: unknown): CalibratedConfidence {
  return clampConfidence(value) as CalibratedConfidence;
}

// --- the key ------------------------------------------------------------------------------------

/**
 * docs/04 §6.4: observations are logged and a map is fitted per `(task, model, prompt_version)`.
 *
 * A prompt edit or a model swap invalidates the mapping, so the key is a first-class value here
 * rather than three loose columns that a caller might flatten together.
 */
export interface CalibrationKey {
  readonly task: Task;
  /** The provider's model id as sent, e.g. `deepseek-chat`. */
  readonly model: string;
  /** `templateId@version`, so a template change and a version bump are both new keys. */
  readonly promptVersion: string;
}

/**
 * Build the key for a classify/parse/ocr call from its {@link PromptRef}.
 *
 * `promptVersion` composes the template id with its revision: §6.4 names only `prompt_version`, but
 * two templates can share a version number, and a template *change* invalidates the map just as a
 * revision does.
 */
export function calibrationKeyFromPrompt(
  task: Task,
  model: string,
  prompt: PromptRef,
): CalibrationKey {
  return { task, model, promptVersion: `${prompt.templateId}@${prompt.version}` };
}

/**
 * A collision-free string id for a key, for use as an index into a {@link CalibrationTable}.
 *
 * `JSON.stringify` of a fixed-order tuple rather than a `|`-joined string: key parts are free-form
 * (a template id or model id may contain any separator), and a collision here would silently share
 * one mapping between two keys — the exact failure the key exists to prevent.
 */
export function calibrationKeyId(key: CalibrationKey): string {
  return JSON.stringify([key.task, key.model, key.promptVersion]);
}

// --- samples and the fitted map -----------------------------------------------------------------

/** One observed outcome: the raw confidence the model reported, and whether the user accepted it. */
export interface CalibrationSample {
  readonly raw: number;
  /** An accepted suggestion (not corrected) is the positive class. */
  readonly accepted: boolean;
}

/** One point of the fitted lookup table: the block's lowest raw value and its pooled acceptance rate. */
export interface CalibrationPoint {
  readonly raw: number;
  readonly calibrated: number;
}

/** `shrink` = `raw × shrinkFactor`; `isotonic` = the fitted lookup table. */
export type CalibrationStrategy = 'shrink' | 'isotonic';

/**
 * A fitted mapping for one {@link CalibrationKey}. Plain, JSON-safe data by design — the weekly job
 * serialises it and the request path deserialises it, with no code shared beyond this shape.
 */
export interface CalibrationMap {
  readonly version: typeof CALIBRATION_MAP_VERSION;
  readonly key: CalibrationKey;
  readonly strategy: CalibrationStrategy;
  /** Observations the fit saw. Below {@link MIN_CALIBRATION_SAMPLES} the strategy is `shrink`. */
  readonly sampleCount: number;
  readonly acceptedCount: number;
  readonly shrinkFactor: number;
  /**
   * The isotonic lookup table, ascending by `raw`, strictly-increasing `raw`, non-decreasing
   * `calibrated`. Empty for `shrink`, whose mapping is the formula, not a table.
   */
  readonly points: readonly CalibrationPoint[];
}

/** All fitted maps, indexed by {@link calibrationKeyId}. This is what a caller loads from storage. */
export type CalibrationTable = Readonly<Record<string, CalibrationMap>>;

/**
 * The conservative §6.4 map used when there is no fit for a key (or not enough data).
 *
 * Exported so the nightly job can persist an explicit "insufficient data" map rather than leaving a
 * hole, and so a caller can render the same curve in a settings screen.
 */
export function shrinkCalibrationMap(
  key: CalibrationKey,
  sampleCount = 0,
  acceptedCount = 0,
): CalibrationMap {
  return {
    version: CALIBRATION_MAP_VERSION,
    key: copyKey(key),
    strategy: 'shrink',
    sampleCount,
    acceptedCount,
    shrinkFactor: SHRINK_FACTOR,
    points: [],
  };
}

/**
 * Fit an isotonic map for `key` from observed `(raw, accepted)` pairs (docs/04 §6.4).
 *
 * Below {@link MIN_CALIBRATION_SAMPLES} observations the fit is not trusted and
 * {@link shrinkCalibrationMap} is returned instead — the conservative direction, and the reason a
 * brand-new `(task, model, prompt_version)` cannot auto-apply on day one.
 *
 * Ties in `raw` are aggregated into weighted buckets *before* pooling, so the fitted value does not
 * depend on the order the observations happened to arrive in.
 */
export function fitCalibrationMap(
  key: CalibrationKey,
  samples: readonly CalibrationSample[],
): CalibrationMap {
  const sampleCount = samples.length;
  const acceptedCount = samples.reduce((total, sample) => total + (sample.accepted ? 1 : 0), 0);

  if (sampleCount < MIN_CALIBRATION_SAMPLES) {
    return shrinkCalibrationMap(key, sampleCount, acceptedCount);
  }

  return {
    version: CALIBRATION_MAP_VERSION,
    key: copyKey(key),
    strategy: 'isotonic',
    sampleCount,
    acceptedCount,
    shrinkFactor: SHRINK_FACTOR,
    points: pavaPoints(samples),
  };
}

/** Index fitted maps by key, last one winning. The inverse of what {@link calibrate} looks up. */
export function buildCalibrationTable(maps: readonly CalibrationMap[]): CalibrationTable {
  const table: Record<string, CalibrationMap> = {};
  for (const map of maps) {
    table[calibrationKeyId(map.key)] = map;
  }
  return table;
}

// --- applying -----------------------------------------------------------------------------------

/**
 * Apply a fitted map to a raw confidence.
 *
 * For `shrink` this is literally `raw × shrinkFactor` (§6.4); for `isotonic` it is a right-continuous
 * step lookup — the pooled value of the block a raw value falls in, holding the lower block's value
 * across a gap between observed raws. A step (not an interpolation) is what PAVA actually estimates.
 *
 * The result is clamped into `0..1` unconditionally. A valid map cannot produce anything else, and a
 * hand-edited or corrupt one must not be able to inject an out-of-range number into the gate.
 */
export function applyCalibrationMap(
  raw: RawConfidence,
  map: CalibrationMap,
): CalibratedConfidence {
  if (map.strategy === 'shrink' || map.points.length === 0) {
    return clampConfidence(raw * map.shrinkFactor) as CalibratedConfidence;
  }
  return clampConfidence(stepLookup(map.points, raw)) as CalibratedConfidence;
}

/**
 * The request path: look the key's map up in a loaded table and apply it, falling back to the
 * conservative shrink when the table has nothing for that key.
 *
 * The fallback lives *inside* this function so a caller cannot forget it. A key that was never seen
 * — a new model, a bumped prompt version — therefore gets the verify-lane-biased mapping rather
 * than an uncalibrated pass-through.
 */
export function calibrate(
  raw: RawConfidence,
  key: CalibrationKey,
  table?: CalibrationTable,
): CalibratedConfidence {
  const map = table?.[calibrationKeyId(key)];
  if (map === undefined) {
    return clampConfidence(raw * SHRINK_FACTOR) as CalibratedConfidence;
  }
  return applyCalibrationMap(raw, map);
}

// --- the gate -----------------------------------------------------------------------------------

/** docs/04 §7's three lanes. `VERIFY` is the advisory lane; `ASK` is the blocking one. */
export type ConfidenceLane = 'AUTO_APPLY' | 'VERIFY' | 'ASK';

/** docs/04 §7 makes the thresholds per-Household tunable; these are ADR-009's defaults. */
export interface LaneThresholds {
  readonly autoApplyMin: number;
  readonly verifyMin: number;
}

/** ADR-009: `≥ 0.90` auto-apply · `0.60 – 0.89` verify · `< 0.60` ask. */
export const DEFAULT_LANE_THRESHOLDS: LaneThresholds = Object.freeze({
  autoApplyMin: AUTO_APPLY_MIN,
  verifyMin: VERIFY_MIN,
});

/**
 * The lane a **calibrated** confidence falls in.
 *
 * The parameter type is the enforcement of §6.4's "gate on calibrated confidence, never raw": a
 * `number`, a `ClassifyProposal['confidence']` or a `RawConfidence` is not assignable, so an
 * accidental raw gate does not compile. The only ways in are {@link calibrate},
 * {@link applyCalibrationMap} and {@link calibratedConfidenceFromStorage}.
 */
export function laneFor(
  confidence: CalibratedConfidence,
  thresholds: LaneThresholds = DEFAULT_LANE_THRESHOLDS,
): ConfidenceLane {
  if (confidence >= thresholds.autoApplyMin) return 'AUTO_APPLY';
  if (confidence >= thresholds.verifyMin) return 'VERIFY';
  return 'ASK';
}

/**
 * True when the row belongs in the **blocking** lane only — `needs_review` in docs/04 §7 and
 * invariant I-8. The advisory (`VERIFY`) lane is **not** counted by the nav badge.
 */
export function needsReview(
  confidence: CalibratedConfidence,
  thresholds: LaneThresholds = DEFAULT_LANE_THRESHOLDS,
): boolean {
  return laneFor(confidence, thresholds) === 'ASK';
}

// --- validating a stored map --------------------------------------------------------------------

/**
 * Parse a stored map, returning `null` for anything that is not a well-formed map of the current
 * version.
 *
 * docs/10 §5.7(a): "the emitted lookup table is asserted monotone non-decreasing, so a serialiser
 * bug cannot break the property". This is that assertion at the boundary where JSON re-enters the
 * process — a non-monotone, unsorted, out-of-range or under-sampled table is refused, and the caller
 * falls back to the conservative shrink rather than gating on it.
 */
export function parseCalibrationMap(value: unknown): CalibrationMap | null {
  if (!isRecord(value)) return null;
  if (value['version'] !== CALIBRATION_MAP_VERSION) return null;

  const key = parseCalibrationKey(value['key']);
  if (key === null) return null;

  const strategy = value['strategy'];
  if (strategy !== 'shrink' && strategy !== 'isotonic') return null;

  const sampleCount = value['sampleCount'];
  if (typeof sampleCount !== 'number' || !Number.isInteger(sampleCount) || sampleCount < 0) {
    return null;
  }
  const acceptedCount = value['acceptedCount'];
  if (
    typeof acceptedCount !== 'number' ||
    !Number.isInteger(acceptedCount) ||
    acceptedCount < 0 ||
    acceptedCount > sampleCount
  ) {
    return null;
  }

  const shrinkFactor = value['shrinkFactor'];
  if (!isUnitNumber(shrinkFactor)) return null;

  if (strategy === 'shrink') {
    // A shrink map has no lookup table; the formula is the mapping.
    if (!Array.isArray(value['points']) || value['points'].length > 0) return null;
    return {
      version: CALIBRATION_MAP_VERSION,
      key,
      strategy,
      sampleCount,
      acceptedCount,
      shrinkFactor,
      points: [],
    };
  }

  if (sampleCount < MIN_CALIBRATION_SAMPLES) return null;
  const points = parseCalibrationPoints(value['points']);
  if (points === null) return null;

  return {
    version: CALIBRATION_MAP_VERSION,
    key,
    strategy,
    sampleCount,
    acceptedCount,
    shrinkFactor,
    points,
  };
}

/** True when {@link parseCalibrationMap} accepts the value. */
export function isValidCalibrationMap(value: unknown): boolean {
  return parseCalibrationMap(value) !== null;
}

// --- internals ----------------------------------------------------------------------------------

interface WeightedBucket {
  readonly raw: number;
  readonly n: number;
  readonly accepted: number;
}

/**
 * Weighted PAVA (pool adjacent violators) over buckets of distinct raw values.
 *
 * Buckets are aggregated first so that ties and arrival order cannot change the fit, then the
 * classic stack algorithm runs: push the next bucket, and while the previous block's pooled mean
 * exceeds the current one's, merge them. Merging can cascade leftwards. The emitted block means are
 * therefore non-decreasing by construction — the isotonic property is not checked after the fact,
 * it is what the loop produces.
 */
function pavaPoints(samples: readonly CalibrationSample[]): CalibrationPoint[] {
  const buckets = aggregateByRaw(samples);
  const blocks: { raw: number; sumW: number; sumWY: number }[] = [];

  for (const bucket of buckets) {
    blocks.push({ raw: bucket.raw, sumW: bucket.n, sumWY: bucket.accepted });

    while (blocks.length >= 2) {
      const last = blocks[blocks.length - 1];
      const previous = blocks[blocks.length - 2];
      if (last === undefined || previous === undefined) break;
      // Pool only on a *violation*; equal means are already non-decreasing.
      if (previous.sumWY / previous.sumW <= last.sumWY / last.sumW) break;
      blocks.pop();
      blocks.pop();
      blocks.push({
        raw: previous.raw,
        sumW: previous.sumW + last.sumW,
        sumWY: previous.sumWY + last.sumWY,
      });
    }
  }

  return blocks.map((block) => ({
    raw: block.raw,
    calibrated: clampConfidence(block.sumWY / block.sumW),
  }));
}

function aggregateByRaw(samples: readonly CalibrationSample[]): WeightedBucket[] {
  const buckets = new Map<number, { n: number; accepted: number }>();
  for (const sample of samples) {
    // Raw values arrive from the database; clamping here means a rogue row cannot widen the range.
    const raw = clampConfidence(sample.raw);
    const bucket = buckets.get(raw) ?? { n: 0, accepted: 0 };
    bucket.n += 1;
    if (sample.accepted) bucket.accepted += 1;
    buckets.set(raw, bucket);
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([raw, bucket]) => ({ raw, n: bucket.n, accepted: bucket.accepted }));
}

function stepLookup(points: readonly CalibrationPoint[], raw: number): number {
  // Below the smallest observed raw, the first block's value applies: the fit has nothing to say
  // about a region it never saw, and the first block is the conservative end of the mapping.
  let calibrated = points[0]?.calibrated ?? 0;
  for (const point of points) {
    if (point.raw > raw) break;
    calibrated = point.calibrated;
  }
  return calibrated;
}

function parseCalibrationKey(value: unknown): CalibrationKey | null {
  if (!isRecord(value)) return null;
  const task = value['task'];
  const model = value['model'];
  const promptVersion = value['promptVersion'];
  if (typeof task !== 'string' || !TASKS.includes(task as Task)) return null;
  if (typeof model !== 'string' || model.length === 0) return null;
  if (typeof promptVersion !== 'string' || promptVersion.length === 0) return null;
  return { task: task as Task, model, promptVersion };
}

function parseCalibrationPoints(value: unknown): CalibrationPoint[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const points: CalibrationPoint[] = [];
  let previousRaw = Number.NEGATIVE_INFINITY;
  let previousCalibrated = Number.NEGATIVE_INFINITY;

  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const raw = entry['raw'];
    const calibrated = entry['calibrated'];
    if (!isUnitNumber(raw) || !isUnitNumber(calibrated)) return null;
    // Strictly ascending raws; `fitCalibrationMap` aggregates ties into one bucket, so a repeated
    // raw here means the table was not produced by the fit.
    if (raw <= previousRaw) return null;
    if (calibrated < previousCalibrated) return null;
    points.push({ raw, calibrated });
    previousRaw = raw;
    previousCalibrated = calibrated;
  }

  return points;
}

function copyKey(key: CalibrationKey): CalibrationKey {
  return { task: key.task, model: key.model, promptVersion: key.promptVersion };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnitNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
