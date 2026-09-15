/**
 * Pins the pg_trgm claim in `./trigram` rather than asserting it.
 *
 * Every expected similarity below is **hand-computed** from pg_trgm's definition (pad each word with
 * two leading and one trailing space, take every length-3 window, `|∩| / |∪|` over the sets) and was
 * independently read back from the development database:
 *
 * ```sql
 * SELECT similarity('dejan roda', 'dejan rota');   -- 0.5714286
 * SELECT similarity('dejan roda', 'dejan rod');    -- 0.75
 * SELECT similarity('goran', 'gorana');            -- 0.625
 * ```
 *
 * If the default implementation ever drifts from `similarity()`, these break.
 */

import { describe, expect, it } from 'vitest';

import {
  TRIGRAM_CONFIDENCE_MAX,
  TRIGRAM_CONFIDENCE_MIN,
  TRIGRAM_SIMILARITY_THRESHOLD,
  pgTrigramSimilarity,
  trigramConfidence,
  trigramsOf,
} from './trigram';

/** Compare a trigram set as a sorted list, so the assertion does not depend on insertion order. */
function sortedTrigrams(value: string): string[] {
  return [...trigramsOf(value)].sort();
}

describe('trigramsOf', () => {
  it('matches pg_trgm show_trgm for a single word', () => {
    // 'lidl' pads to '  lidl ' (7 chars) → 5 windows:
    //   '  l', ' li', 'lid', 'idl', 'dl '.
    // psql: show_trgm('lidl') = {"  l"," li","dl ",idl,lid}
    expect(sortedTrigrams('lidl')).toEqual(['  l', ' li', 'dl ', 'idl', 'lid']);
  });

  it('pads each word separately, so no trigram spans the space', () => {
    // 'dejan roda': 'dejan' pads to '  dejan ' → '  d',' de','dej','eja','jan','an ';
    //               'roda'  pads to '  roda '  → '  r',' ro','rod','oda','da '.
    // 11 distinct trigrams. psql confirms 11 and the same set.
    const dejanRoda = sortedTrigrams('dejan roda');
    expect(dejanRoda).toHaveLength(11);
    expect(dejanRoda).not.toContain('n r');
    expect(dejanRoda).toEqual(
      [...sortedTrigrams('dejan'), ...sortedTrigrams('roda')].sort(),
    );
  });

  it('keeps only alphanumerics and de-duplicates', () => {
    // Punctuation is a word boundary, exactly as pg_trgm's KEEPONLYALNUM treats it.
    expect(sortedTrigrams('lidl-lidl')).toEqual(sortedTrigrams('lidl lidl'));
    expect(sortedTrigrams('dejan-roda')).toEqual(sortedTrigrams('dejan roda'));
    // A repeated trigram counts once: 'ana' is a set, not a multiset.
    const ana = sortedTrigrams('ana');
    expect(ana).toEqual([...new Set(ana)].sort());
  });

  it('has no trigrams for an empty or separator-only string', () => {
    expect(sortedTrigrams('')).toEqual([]);
    expect(sortedTrigrams('   ')).toEqual([]);
    expect(sortedTrigrams('...')).toEqual([]);
  });
});

describe('pgTrigramSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(pgTrigramSimilarity('dejan roda', 'dejan roda')).toBe(1);
    expect(pgTrigramSimilarity('lidl', 'lidl')).toBe(1);
  });

  it('returns |∩| / |∪| — the canonical near miss', () => {
    // a = 'dejan roda' → 11 trigrams, b = 'dejan rota' → 11 trigrams.
    //   a:   d,  r,  de,  ro,  an , da , dej, eja, jan, oda, rod
    //   b:   d,  r,  de,  ro,  an ,      dej, eja, jan, ota, rot, ta
    //   common = {  d,   r,  de,  ro,  an , dej, eja, jan } = 8
    //   union  = 11 + 11 - 8 = 14
    //   similarity = 8 / 14 = 0.571428…
    // psql: 0.5714286. Clears the 0.55 threshold, so this is a rung-4 hit.
    expect(pgTrigramSimilarity('dejan roda', 'dejan rota')).toBeCloseTo(8 / 14, 10);
    expect(pgTrigramSimilarity('dejan roda', 'dejan rota')).toBeGreaterThan(
      TRIGRAM_SIMILARITY_THRESHOLD,
    );
  });

  it('returns 9 / 12 for a one-character deletion', () => {
    // a = 'dejan roda' → 11, b = 'dejan rod' → 'dejan'(6) + 'rod'(4) = 10.
    //   common = 9, union = 11 + 10 - 9 = 12, similarity = 0.75. psql: 0.75.
    expect(pgTrigramSimilarity('dejan roda', 'dejan rod')).toBeCloseTo(0.75, 10);
  });

  it('returns 5 / 8 for an appended character', () => {
    // 'goran' → 6 trigrams, 'gorana' → 7, common = 5, union = 8, similarity = 0.625. psql: 0.625.
    expect(pgTrigramSimilarity('goran', 'gorana')).toBeCloseTo(0.625, 10);
    // The same value for a different trailing letter: 5 / 8 as well.
    expect(pgTrigramSimilarity('goran', 'gorans')).toBeCloseTo(0.625, 10);
  });

  it('returns 0 when nothing is shared and 1 for two empty strings', () => {
    expect(pgTrigramSimilarity('prodavnica', 'lidl')).toBe(0);
    expect(pgTrigramSimilarity('', '')).toBe(1);
    expect(pgTrigramSimilarity('', 'lidl')).toBe(0);
    expect(pgTrigramSimilarity('lidl', '')).toBe(0);
  });

  it('is symmetric', () => {
    const pairs: [string, string][] = [
      ['dejan roda', 'dejan rota'],
      ['lidl prodavnica', 'lidl'],
      ['goran', 'gorana'],
      ['', 'lidl'],
    ];
    for (const [a, b] of pairs) {
      expect(pgTrigramSimilarity(a, b)).toBe(pgTrigramSimilarity(b, a));
    }
  });
});

describe('trigramConfidence', () => {
  it('maps the threshold to the band floor, below the 0.60 ask gate', () => {
    // The safe reading of ADR-009: a hit that only just clears 0.55 must not auto-apply, and must not
    // even reach the "verify" lane — it asks.
    expect(trigramConfidence(TRIGRAM_SIMILARITY_THRESHOLD)).toBeCloseTo(TRIGRAM_CONFIDENCE_MIN, 10);
    expect(trigramConfidence(TRIGRAM_SIMILARITY_THRESHOLD)).toBeLessThan(0.6);
  });

  it('reaches the 0.60 verify gate only at similarity 0.625', () => {
    // 0.55 + ((0.625 - 0.55) / 0.45) * 0.30 = 0.55 + 0.05 = 0.60.
    expect(trigramConfidence(0.625)).toBeCloseTo(0.6, 10);
    // The real near miss from `pgTrigramSimilarity` above stays in the ask lane.
    expect(trigramConfidence(8 / 14)).toBeLessThan(0.6);
  });

  it('maps certainty to the band ceiling', () => {
    expect(trigramConfidence(1)).toBeCloseTo(TRIGRAM_CONFIDENCE_MAX, 10);
  });

  it('is monotone non-decreasing and stays inside the band', () => {
    let previous = -Infinity;
    for (let similarity = -0.1; similarity <= 1.1; similarity += 0.005) {
      const confidence = trigramConfidence(similarity);
      expect(confidence).toBeGreaterThanOrEqual(TRIGRAM_CONFIDENCE_MIN);
      expect(confidence).toBeLessThanOrEqual(TRIGRAM_CONFIDENCE_MAX);
      expect(confidence).toBeGreaterThanOrEqual(previous);
      previous = confidence;
    }
  });

  it('clamps below the threshold, above 1, and non-finite values', () => {
    expect(trigramConfidence(0)).toBeCloseTo(TRIGRAM_CONFIDENCE_MIN, 10);
    expect(trigramConfidence(0.2)).toBeCloseTo(TRIGRAM_CONFIDENCE_MIN, 10);
    expect(trigramConfidence(2)).toBeCloseTo(TRIGRAM_CONFIDENCE_MAX, 10);
    expect(trigramConfidence(Number.NaN)).toBeCloseTo(TRIGRAM_CONFIDENCE_MIN, 10);
    expect(trigramConfidence(Number.POSITIVE_INFINITY)).toBeCloseTo(TRIGRAM_CONFIDENCE_MAX, 10);
  });

  it('never reaches the ADR-009 0.90 auto-apply gate', () => {
    expect(TRIGRAM_CONFIDENCE_MAX).toBeLessThan(0.9);
  });
});
