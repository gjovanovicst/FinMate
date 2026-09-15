/**
 * Trigram similarity for rung 4 of entity resolution, and the rung-4 confidence mapping.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §4 (steps 1–4 are pure and live here; step 5 is the
 * embedding k-NN in the API/worker layer, task 2.3.4).
 *
 * **Why a default implementation exists at all.** `pg_trgm` is installed in the product database, so
 * the API can call the indexed SQL `similarity()` for speed. A pure package cannot. The similarity is
 * therefore **injected** with the {@link pgTrigramSimilarity} default, so the 0.55 threshold is
 * defined once instead of meaning two different things depending on who computed it.
 *
 * **The two implementations must agree on the definition.** {@link pgTrigramSimilarity} is an
 * implementation *of pg_trgm's definition* — pad every word with two leading spaces and one trailing
 * space, extract every length-3 window of the padded word, and return
 * `|intersection| / |union|` over the two **sets** of trigrams. It is not a lookalike heuristic. If a
 * caller passes SQL `similarity()`, it must be the same definition over the same (folded) strings, or
 * the effective threshold drifts — an invisible mismatch would silently change which entities resolve.
 *
 * @module @finmate/nlp
 */

/**
 * Returns a value in `0..1`. Injected so a caller with `pg_trgm` can use the indexed SQL function.
 *
 * It is called with **already-folded** strings ({@link foldForMatching} of both sides), so a SQL
 * implementation reading the `alias` / `normalised` columns compares like with like. Rung 4 is only
 * consulted after rungs 1–3 missed, so an expensive implementation is not paid for an easy hit.
 */
export type TrigramSimilarity = (a: string, b: string) => number;

/** docs/04 §4 rung 4. Strictly greater than this resolves; equal to it does not. */
export const TRIGRAM_SIMILARITY_THRESHOLD = 0.55;

/**
 * docs/04 §4 rung 4's confidence band. The band's ceiling is below the ADR-009 0.90 auto-apply gate,
 * so a fuzzy match can never auto-apply: it can only verify (`>= 0.60`) or ask (`< 0.60`).
 */
export const TRIGRAM_CONFIDENCE_MIN = 0.55;
export const TRIGRAM_CONFIDENCE_MAX = 0.85;

/** pg_trgm's `LPADDING` / `RPADDING`. */
const LEADING_PAD = '  ';
const TRAILING_PAD = ' ';
const TRIGRAM_LENGTH = 3;

const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/u;

/**
 * The set of trigrams pg_trgm would extract from `value`.
 *
 * Words are split on anything non-alphanumeric (pg_trgm's `KEEPONLYALNUM`) and padded individually,
 * so `dejan roda` yields the trigrams of `dejan` and of `roda`, never a trigram spanning the space.
 * Trigrams are a **set**: a repeated trigram counts once, which is what makes
 * `|intersection| / |union|` the definition rather than a multiset ratio.
 */
export function trigramsOf(value: string): ReadonlySet<string> {
  const trigrams = new Set<string>();
  for (const word of value.split(NON_ALPHANUMERIC)) {
    if (word.length === 0) continue;
    const padded = `${LEADING_PAD}${word}${TRAILING_PAD}`;
    for (let start = 0; start + TRIGRAM_LENGTH <= padded.length; start += 1) {
      trigrams.add(padded.slice(start, start + TRIGRAM_LENGTH));
    }
  }
  return trigrams;
}

/**
 * pg_trgm's `similarity(a, b)`: `|intersection| / |union|` over the two trigram sets.
 *
 * Both sides empty returns `1` (identical — an empty string is identical to an empty string); one
 * side empty returns `0` (nothing in common).
 */
export function pgTrigramSimilarity(a: string, b: string): number {
  const left = trigramsOf(a);
  const right = trigramsOf(b);

  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const trigram of left) {
    if (right.has(trigram)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

/**
 * Map a rung-4 similarity into docs/04 §4's `0.55–0.85` confidence band.
 *
 * **Derived, not specified.** §4 gives the band but not the function, so this is a clamped linear
 * interpolation from the threshold to certainty:
 *
 * ```text
 * t          = clamp((similarity - 0.55) / (1 - 0.55), 0, 1)
 * confidence = 0.55 + t * (0.85 - 0.55)
 * ```
 *
 * Monotone non-decreasing, `0.55` at the threshold and `0.85` at an identical string. The important
 * consequence is the **safe reading of ADR-009**: a hit that only just clears the 0.55 threshold maps
 * to a confidence below the 0.60 verify gate and therefore lands in the "ask" lane. Nothing about
 * rung 4 auto-applies — `0.60` is not reached until similarity `0.625`, and `0.90` is unreachable
 * inside the band. Similarities below the threshold clamp to the band floor; they are not matches.
 */
export function trigramConfidence(similarity: number): number {
  // Clamp into `0..1` first, so `±Infinity` saturates at the band edge; `NaN` cannot be clamped and
  // falls back to the band floor. A non-finite similarity never reaches here as a hit — rung 4 skips
  // it — so this is defensive only.
  const bounded = Math.min(1, Math.max(0, similarity));
  const position = (bounded - TRIGRAM_SIMILARITY_THRESHOLD) / (1 - TRIGRAM_SIMILARITY_THRESHOLD);
  const clamped = Number.isFinite(position) ? Math.min(1, Math.max(0, position)) : 0;
  return TRIGRAM_CONFIDENCE_MIN + clamped * (TRIGRAM_CONFIDENCE_MAX - TRIGRAM_CONFIDENCE_MIN);
}
