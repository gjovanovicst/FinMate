import { describe, expect, it } from 'vitest';

import {
  EMBEDDING_CONFIDENCE_MAX,
  EMBEDDING_CONFIDENCE_MIN,
  EMBEDDING_MIN_COSINE,
  confidenceForCosine,
  cosineFromDistance,
  cosineSimilarity,
  embeddingSourceText,
  pickEmbeddingNeighbour,
  type EmbeddingNeighbour,
} from './embedding-resolver';

/**
 * Rung 5's arithmetic and its tie-break (docs/04 §4).
 *
 * The failures this guards against are all quiet ones. A threshold that is off by a hair changes which
 * entity a name resolves to, and the result still *looks* like a resolution. A non-monotonic
 * confidence mapping makes a closer neighbour score lower than a further one, so the pipeline picks
 * the wrong one while every individual number is in range. A tie-break without a total order makes
 * resolution depend on the order Postgres happened to return rows, which changes between runs.
 *
 * The band is also the safety property: rung 5 **never auto-applies**, because 0.90 is outside it.
 */

function neighbour(over: Partial<EmbeddingNeighbour> = {}): EmbeddingNeighbour {
  return {
    ownerId: 'entity-a',
    ownerType: 'COUNTERPARTY',
    name: 'Dejan rođa',
    cosine: 0.9,
    defaultCategoryId: null,
    ...over,
  };
}

describe('cosineSimilarity', () => {
  it('is 1 for a vector and itself, and 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it('is scale-invariant, which is what makes it an embedding comparison', () => {
    // A model that returns an unnormalised vector must not score differently from one that normalises.
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it('is 0 for a dimension mismatch rather than throwing', () => {
    // A mismatch means the model changed and the stored vector is stale. Zero is below every
    // threshold, so the stale row silently stops matching — the correct degradation (ADR-021).
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('is 0 for a zero vector, not NaN', () => {
    // `NaN` would propagate into the ordering and make `pickEmbeddingNeighbour`'s comparator
    // inconsistent, which is how a sort starts returning nonsense.
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });
});

describe('cosineFromDistance', () => {
  it("inverts pgvector's `<=>`, which returns a distance", () => {
    expect(cosineFromDistance(0)).toBe(1);
    expect(cosineFromDistance(0.18)).toBeCloseTo(0.82, 10);
    expect(cosineFromDistance(2)).toBe(-1);
  });
});

describe('confidenceForCosine', () => {
  it('maps the threshold to the bottom of the band and certainty to the top', () => {
    expect(confidenceForCosine(EMBEDDING_MIN_COSINE)).toBeCloseTo(EMBEDDING_CONFIDENCE_MIN, 10);
    expect(confidenceForCosine(1)).toBeCloseTo(EMBEDDING_CONFIDENCE_MAX, 10);
  });

  it('clamps below the threshold and above certainty', () => {
    // A cosine below the threshold should never be asked about, but a mapping that extrapolated would
    // return a confidence under 0.60 for a row the picker had already rejected — a value that looks
    // like a legitimate low-confidence answer.
    expect(confidenceForCosine(0)).toBe(EMBEDDING_CONFIDENCE_MIN);
    expect(confidenceForCosine(0.5)).toBe(EMBEDDING_CONFIDENCE_MIN);
    expect(confidenceForCosine(1.4)).toBe(EMBEDDING_CONFIDENCE_MAX);
  });

  it('is monotonic, so a closer neighbour is never less confident', () => {
    let previous = -1;
    for (let cosine = EMBEDDING_MIN_COSINE; cosine <= 1.0001; cosine += 0.01) {
      const confidence = confidenceForCosine(cosine);
      expect(confidence).toBeGreaterThanOrEqual(previous);
      previous = confidence;
    }
  });

  it('NEVER reaches the auto-apply gate, which is the point of the band', () => {
    // ADR-009 auto-applies at 0.90. docs/04 §4 caps rung 5 at 0.85, so a nearest neighbour can only
    // ever be a candidate the user confirms — never a decision taken on their behalf.
    expect(EMBEDDING_CONFIDENCE_MAX).toBeLessThan(0.9);
    for (const cosine of [0.82, 0.9, 0.95, 0.99, 1]) {
      expect(confidenceForCosine(cosine)).toBeLessThan(0.9);
    }
  });

  it('never lands in the ask lane, which is what makes rung 5 a different rung from rung 4', () => {
    // Rung 4's band starts at 0.55, so a marginal trigram hit scores BELOW 0.60 and the gate sends it
    // to the ask lane. Rung 5's band starts at 0.60 by construction (docs/04 §4), so even a hit that
    // only just cleared the threshold is already in the verify lane: "here is a candidate, check it"
    // rather than "I cannot decide".
    expect(confidenceForCosine(EMBEDDING_MIN_COSINE)).toBe(EMBEDDING_CONFIDENCE_MIN);
    expect(confidenceForCosine(0.83)).toBeGreaterThan(EMBEDDING_CONFIDENCE_MIN);
    for (const cosine of [0.82, 0.83, 0.9, 1]) {
      expect(confidenceForCosine(cosine)).toBeGreaterThanOrEqual(0.6);
    }
  });
});

describe('pickEmbeddingNeighbour', () => {
  it('takes the highest cosine above the threshold', () => {
    const picked = pickEmbeddingNeighbour([
      neighbour({ ownerId: 'a', cosine: 0.83 }),
      neighbour({ ownerId: 'b', cosine: 0.91 }),
      neighbour({ ownerId: 'c', cosine: 0.85 }),
    ]);
    expect(picked?.ownerId).toBe('b');
  });

  it('rejects a cosine at or below the threshold', () => {
    // docs/04 §4 says `> 0.82`, so exactly 0.82 does not qualify.
    expect(pickEmbeddingNeighbour([neighbour({ cosine: EMBEDDING_MIN_COSINE })])).toBeNull();
    expect(pickEmbeddingNeighbour([neighbour({ cosine: 0.5 })])).toBeNull();
    expect(pickEmbeddingNeighbour([])).toBeNull();
  });

  it('breaks a tie on the more specific name', () => {
    // docs/04 §4: the same confidence, the longer matched name wins. `Dejan rođa` is a better answer
    // than `Dejan` for an input that contains both.
    const picked = pickEmbeddingNeighbour([
      neighbour({ ownerId: 'short', name: 'Dejan', cosine: 0.9 }),
      neighbour({ ownerId: 'long', name: 'Dejan rođa', cosine: 0.9 }),
    ]);
    expect(picked?.ownerId).toBe('long');
  });

  it('prefers a MERCHANT when cosine and name length both tie', () => {
    // Consistent with the entity-default stage, which already prefers a Merchant when both resolve.
    const picked = pickEmbeddingNeighbour([
      neighbour({ ownerId: 'cp', ownerType: 'COUNTERPARTY', name: 'Lidl', cosine: 0.9 }),
      neighbour({ ownerId: 'm', ownerType: 'MERCHANT', name: 'Lidl', cosine: 0.9 }),
    ]);
    expect(picked?.ownerId).toBe('m');
  });

  it('is a TOTAL order, so resolution cannot depend on row order', () => {
    // Two entities with the same cosine and the same name length: without the id tiebreak the winner
    // would be whichever row Postgres returned first, which is not stable between runs.
    const left = neighbour({ ownerId: 'aaa', name: 'Lidl', cosine: 0.9 });
    const right = neighbour({ ownerId: 'bbb', name: 'Maxi', cosine: 0.9 });

    const forward = pickEmbeddingNeighbour([left, right]);
    const backward = pickEmbeddingNeighbour([right, left]);

    expect(forward?.ownerId).toBe(backward?.ownerId);
    expect(forward?.ownerId).toBe('aaa');
  });

  it('does not mutate the input order', () => {
    const input = [neighbour({ ownerId: 'b', cosine: 0.83 }), neighbour({ ownerId: 'a', cosine: 0.95 })];
    pickEmbeddingNeighbour(input);
    expect(input.map((entry) => entry.ownerId)).toEqual(['b', 'a']);
  });
});

describe('embeddingSourceText', () => {
  it('joins the name and its aliases, so the entity is reachable by any of them', () => {
    expect(embeddingSourceText('Dejan rođa', ['dejan', 'roda'])).toBe('Dejan rođa | dejan | roda');
  });

  it('is deterministic, so re-indexing an entity produces the same text', () => {
    // Otherwise a re-sync would rewrite the row with a different string every time, and `source_text`
    // would stop being an explanation of what the vector means.
    const first = embeddingSourceText('Maxi', ['maksi', 'maxi market']);
    const second = embeddingSourceText('Maxi', ['maxi market', 'maksi']);
    expect(first).toBe(second);
  });

  it('drops empty parts rather than embedding separators', () => {
    expect(embeddingSourceText('Lidl', ['', '  ', 'lidl'])).toBe('Lidl | lidl');
  });

  it('handles an entity with no aliases', () => {
    expect(embeddingSourceText('Lidl', [])).toBe('Lidl');
  });
});
