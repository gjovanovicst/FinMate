/**
 * ADR-009's confidence bands, defined **once** for the whole client.
 *
 * docs/04 §7 is the specification: `>= 0.90` auto-applies, `0.60–0.89` is the advisory (verify)
 * band, `< 0.60` is blocked, and a `null` category blocks at any confidence (invariant I-8). Two
 * screens render that gate — the capture preview (§3) and the review queue (§4.6) — and the server
 * is the authority for all of it. This module exists so the *labelling* of the gate has one
 * definition: a second copy of `0.60`/`0.90` is how one screen starts drawing a row yellow while
 * the other draws it red, which is exactly the kind of disagreement that teaches a user the badge
 * means nothing.
 *
 * The bands are a **label**, never a decision. Nothing here gates a write; the API's
 * `classification_decisions` and `transactions.needs_review` are what the ledger acts on.
 *
 * @module apps/web/src/app/shared
 */

/** docs/04 §7's auto-apply floor. */
export const AUTO_APPLY_MIN = 0.9;

/** docs/04 §7's verify floor — below this a row is blocking, not advisory. */
export const VERIFY_MIN = 0.6;

/**
 * `NONE` is the honest arm for "no confidence was ever recorded".
 *
 * The API distinguishes `confidence: null` from `0` on purpose (docs/06 §4.2): `null` means the
 * pipeline recorded no decision for this row, while `0` is a decision the model was certain was
 * wrong. Drawing both as `0 %` would present a missing fact as a measurement.
 */
export type ConfidenceBand = 'NONE' | 'AUTO' | 'VERIFY' | 'ASK';

/** Classify a calibrated confidence into docs/04 §7's bands. */
export function confidenceBand(confidence: number | null): ConfidenceBand {
  if (confidence === null) return 'NONE';
  if (confidence >= AUTO_APPLY_MIN) return 'AUTO';
  if (confidence >= VERIFY_MIN) return 'VERIFY';
  return 'ASK';
}
