/**
 * Rung 5's decision — docs/04 §4 — as pure functions.
 *
 * The ladder itself stays in `packages/nlp` (rungs 1–4, pure). Rung 5 is the I/O one, so its *math and
 * its tie-breaking* live here, next to the pipeline that calls it, and its *vectors* come from
 * `EntityEmbeddingsService`. Splitting it that way keeps the part that can be wrong silently —
 * the threshold, the bandwidth mapping, the choice between two close neighbours — testable without a
 * database or a model.
 *
 * ## The numbers are docs/04 §4's, and the mapping mirrors rung 4's
 *
 * §4 fixes `cosine > 0.82` and the band `0.60–0.85`, and it fixes rung 4's interpolation as
 * "linear and monotonic from the threshold to certainty". Rung 5 uses the same shape so the two rungs
 * cannot disagree about what a given similarity is worth:
 *
 * ```text
 * t          = clamp((cosine - 0.82) / (1 - 0.82), 0, 1)
 * confidence = 0.60 + t * (0.85 - 0.60)
 * ```
 *
 * **This rung never auto-applies.** 0.90 is outside the band entirely, which is the safe reading of
 * ADR-009 and the reason the band tops out at 0.85: a nearest neighbour is evidence, not a decision,
 * and rung 5's whole failure mode is a confident-looking wrong neighbour.
 *
 * @module apps/api/src/modules/classification
 */

import type { EmbeddingOwnerType } from './embedding-provider';

/** docs/04 §4: `cosine > 0.82`. A cosine *similarity*, not pgvector's `<=>` distance. */
export const EMBEDDING_MIN_COSINE = 0.82;

/** docs/04 §4's band for this rung. Below 0.60 there is nothing worth showing the user. */
export const EMBEDDING_CONFIDENCE_MIN = 0.6;
export const EMBEDDING_CONFIDENCE_MAX = 0.85;

/** How many neighbours to fetch before picking one. Enough to break a tie without pulling the table. */
export const EMBEDDING_NEIGHBOUR_LIMIT = 5;

/**
 * Cosine similarity of two vectors, or `0` when they cannot be compared.
 *
 * `0` — not a throw and not `NaN` — because a dimension mismatch means a **model changed** and the
 * stored vector is stale, which is an ordinary state in a system where the model is configuration.
 * Zero is below every threshold, so a stale vector simply stops matching, which is the correct
 * degradation: it fails to rung 4 rather than to a wrong entity.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] as number;
    const right = b[index] as number;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** pgvector's `<=>` returns cosine **distance**; this converts the query's output back to similarity. */
export function cosineFromDistance(distance: number): number {
  return 1 - distance;
}

/**
 * Map a cosine into docs/04 §4's confidence band, clamped at both ends.
 *
 * Monotonic, so a closer neighbour is never *less* confident than a further one — the property a
 * `pick` function relies on, and the one a piecewise table would quietly break.
 */
export function confidenceForCosine(cosine: number): number {
  const span = 1 - EMBEDDING_MIN_COSINE;
  const t = Math.min(Math.max((cosine - EMBEDDING_MIN_COSINE) / span, 0), 1);
  return EMBEDDING_CONFIDENCE_MIN + t * (EMBEDDING_CONFIDENCE_MAX - EMBEDDING_CONFIDENCE_MIN);
}

/** One candidate row as the k-NN query returns it, already converted to a similarity. */
export interface EmbeddingNeighbour {
  readonly ownerId: string;
  readonly ownerType: EmbeddingOwnerType;
  /** The entity's display name, for the audit blob and the tie-break. */
  readonly name: string;
  readonly cosine: number;
  /** The entity's default Category, so a rung-5 hit can categorise like any other entity (docs/04 §4). */
  readonly defaultCategoryId: string | null;
}

/**
 * The best neighbour above the threshold, or `null`.
 *
 * **Tie-breaking follows docs/04 §4's global rule**: highest confidence first, then the more specific
 * match (longer name), then `id` ascending so the order is total. Without the last two, two entities
 * with the same cosine would resolve by whatever order the database returned — a match that changes
 * between runs.
 *
 * A `MERCHANT` wins an exact tie because docs/04 §4 gives "retail semantics" to the Merchant side and
 * the pipeline's entity-default stage already prefers a Merchant when both resolve; this keeps the two
 * consistent instead of inventing a second precedence.
 */
export function pickEmbeddingNeighbour(
  neighbours: readonly EmbeddingNeighbour[],
  threshold: number = EMBEDDING_MIN_COSINE,
): EmbeddingNeighbour | null {
  const eligible = neighbours.filter((neighbour) => neighbour.cosine > threshold);
  if (eligible.length === 0) return null;

  return [...eligible].sort((left, right) => {
    if (right.cosine !== left.cosine) return right.cosine - left.cosine;
    if (right.name.length !== left.name.length) return right.name.length - left.name.length;
    if (left.ownerType !== right.ownerType) return left.ownerType === 'MERCHANT' ? -1 : 1;
    return left.ownerId < right.ownerId ? -1 : left.ownerId > right.ownerId ? 1 : 0;
  })[0]!;
}

/**
 * The text a stored vector is built from.
 *
 * The name **and** its aliases, because rung 5 replaces rung 3's failure mode: `Dejan 2000` should
 * reach an entity named `Dejan rođa`, and an entity whose aliases are embedded is reachable by any of
 * them. Deterministic and sorted, so re-embedding the same entity produces the same row rather than a
 * new one every sync.
 */
export function embeddingSourceText(name: string, aliases: readonly string[]): string {
  return [name, ...[...aliases].sort()].filter((part) => part.trim() !== '').join(' | ');
}
