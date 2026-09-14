/**
 * Keyword scoring — docs/04 §5.4. Every expected number below is hand-computed in a comment.
 *
 * @module @finmate/rules-engine
 */

import { describe, expect, it } from 'vitest';

import {
  KEYWORD_CONFIDENCE_MAX,
  KEYWORD_CONFIDENCE_MIN,
  MATCH_MODE_WEIGHT,
  OVERBROAD_PENALTY_PER_TOKEN,
  RuleDocumentError,
  isKeywordMatchMode,
  isKeywordPolarity,
  keywordConfidence,
  scoreKeywords,
} from './index';
import type { CategoryKeyword, EvaluationContext, KeywordScoreResult } from './index';
import { createRecordingFolder, createTextFolder } from './testing/text-folder';

const folder = createTextFolder();
const options = { folder };

interface KeywordOverrides {
  readonly id?: string;
  readonly polarity?: CategoryKeyword['polarity'];
  readonly matchMode?: CategoryKeyword['matchMode'];
  readonly weight?: number;
}

function keyword(
  categoryId: string,
  value: string,
  overrides: KeywordOverrides = {},
): CategoryKeyword {
  return {
    id: overrides.id ?? `${categoryId}:${value}`,
    categoryId,
    keyword: value,
    polarity: overrides.polarity ?? 'INCLUDE',
    matchMode: overrides.matchMode ?? 'WORD',
    weight: overrides.weight ?? 1,
  };
}

function context(text: string): EvaluationContext {
  return { text };
}

function score(categoryId: string, result: KeywordScoreResult): number {
  const candidate = result.candidates.find((entry) => entry.categoryId === categoryId);
  if (candidate === undefined) throw new Error(`category ${categoryId} has no candidate`);
  return candidate.score;
}

describe('the §5.4 formula on a hand-computed example', () => {
  //  A: lidl   WORD w=1.5 → 1.5 × 1.0 × +1 = 1.5
  //     market WORD w=1.0 → 1.0 × 1.0 × +1 = 1.0
  //     numerator 2.5, matchedTokens 2
  //     denominator 1 + 0.15 × (2 − 1) = 1.15
  //     score 2.5 / 1.15 = 2.1739130434782608695…
  //  B: maxi   WORD w=1.0 → 1.0, matchedTokens 1, denominator 1 → score 1.0
  //  top ≥ 2.0 and margin 1.173913… ≥ 1.0 ⇒ decision A
  //  confidence = 0.90 + 0.07 × ((1.173913… − 1.0) / 3) = 0.9040579710144928
  const keywords = [
    keyword('A', 'lidl', { weight: 1.5 }),
    keyword('A', 'market', { weight: 1 }),
    keyword('B', 'maxi', { weight: 1 }),
  ];
  const result = scoreKeywords(keywords, context('lidl market maxi'), options);

  it('computes the numerator, the over-broad denominator and the score', () => {
    expect(score('A', result)).toBeCloseTo(2.5 / 1.15, 12);
    expect(score('A', result)).toBeCloseTo(2.1739130434782608, 12);
    expect(score('B', result)).toBeCloseTo(1, 12);
    expect(result.candidates[0]?.categoryId).toBe('A');
    expect(result.candidates[0]?.matchedTokens).toBe(2);
    expect(result.candidates[1]?.matchedTokens).toBe(1);
  });

  it('decides and maps the margin to a confidence inside 0.90–0.97', () => {
    const decision = result.decision;
    expect(decision?.categoryId).toBe('A');
    expect(decision?.runnerUpScore).toBeCloseTo(1, 12);
    expect(decision?.margin).toBeCloseTo(2.5 / 1.15 - 1, 12);
    expect(decision?.confidence).toBeCloseTo(0.9040579710144928, 12);
    expect(decision?.confidence).toBeGreaterThanOrEqual(KEYWORD_CONFIDENCE_MIN);
    expect(decision?.confidence).toBeLessThanOrEqual(KEYWORD_CONFIDENCE_MAX);
  });

  it('records every match with its contribution and polarity', () => {
    expect(result.matches).toHaveLength(3);
    const lidl = result.matches.find((match) => match.keyword === 'lidl');
    expect(lidl?.matchMode).toBe('WORD');
    expect(lidl?.contribution).toBe(1.5);
    expect(lidl?.tokenIndices).toEqual([0]);
  });
});

describe('match modes and the over-broad penalty', () => {
  it('applies WORD 1.0 / PREFIX 0.8 / SUBSTRING 0.5', () => {
    expect(MATCH_MODE_WEIGHT).toEqual({ WORD: 1.0, PREFIX: 0.8, SUBSTRING: 0.5 });

    expect(score('word', scoreKeywords([keyword('word', 'lidl')], context('lidl'), options))).toBeCloseTo(
      1,
      12,
    );
    expect(
      score(
        'prefix',
        scoreKeywords([keyword('prefix', 'lidl', { matchMode: 'PREFIX' })], context('lidl'), options),
      ),
    ).toBeCloseTo(0.8, 12);
    expect(
      score(
        'sub',
        scoreKeywords(
          [keyword('sub', 'lidl', { matchMode: 'SUBSTRING' })],
          context('lidl'),
          options,
        ),
      ),
    ).toBeCloseTo(0.5, 12);
  });

  it('does not match a WORD inside a longer token, but a PREFIX does', () => {
    const text = context('lidlova prodavnica');
    const word = scoreKeywords([keyword('w', 'lidl')], text, options);
    const prefix = scoreKeywords([keyword('p', 'lidl', { matchMode: 'PREFIX' })], text, options);
    expect(word.candidates).toHaveLength(0);
    expect(score('p', prefix)).toBeCloseTo(0.8, 12);
  });

  it('matches a multi-word keyword as a token sequence', () => {
    const result = scoreKeywords(
      [keyword('jama', 'pražnjenje jame', { weight: 1 })],
      context('praznjenje jame'),
      options,
    );
    const candidate = result.candidates[0];
    expect(candidate?.categoryId).toBe('jama');
    expect(candidate?.matchedTokens).toBe(2);
    expect(candidate?.score).toBeCloseTo(1 / 1.15, 12);
  });

  it('lets a PREFIX match the inflected last token of a multi-word keyword', () => {
    // Serbian inflects the trailing noun: "jamu" must match the keyword "jam".
    // numerator = weight 2 × PREFIX 0.8 = 1.6 over two matched tokens → 1.6 / 1.15.
    const result = scoreKeywords(
      [keyword('jama', 'praznjenje jam', { matchMode: 'PREFIX', weight: 2 })],
      context('praznjenje jamu'),
      options,
    );
    expect(result.candidates[0]?.score).toBeCloseTo(1.6 / 1.15, 12);
  });

  it('treats a SUBSTRING as weak enough to match both oil readings', () => {
    const result = scoreKeywords([keyword('oil', 'ulje', { matchMode: 'SUBSTRING' })], context('suncokretovo ulje'), options);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.score).toBeCloseTo(0.5, 12);
  });

  it('actually reduces a score when the same weight lands on more tokens', () => {
    // both numerators are 3.0; three matched tokens cost 1 + 0.15 × 2 = 1.3.
    const result = scoreKeywords(
      [
        keyword('one', 'big', { weight: 3 }),
        keyword('many', 'alpha'),
        keyword('many', 'beta'),
        keyword('many', 'gamma'),
      ],
      context('big alpha beta gamma'),
      options,
    );
    expect(score('one', result)).toBeCloseTo(3, 12);
    expect(score('many', result)).toBeCloseTo(3 / 1.3, 12);
    expect(score('many', result)).toBeLessThan(score('one', result));
    expect(OVERBROAD_PENALTY_PER_TOKEN).toBe(0.15);
  });

  it('counts a token once even when several keywords hit it', () => {
    const result = scoreKeywords(
      [
        keyword('a', 'lidl'),
        keyword('a', 'lidl', { id: 'a:lidl-prefix', matchMode: 'PREFIX' }),
      ],
      context('lidl'),
      options,
    );
    expect(result.candidates[0]?.matchedTokens).toBe(1);
    expect(result.candidates[0]?.score).toBeCloseTo(1 + 0.8, 12);
  });
});

describe('EXCLUDE hard-blocks a category (§5.4)', () => {
  const keywords = [
    keyword('auto', 'gorivo', { weight: 2 }),
    keyword('auto', 'ulje', { polarity: 'EXCLUDE', weight: 1 }),
    keyword('delovi', 'ulje', { weight: 2 }),
  ];

  it('subtracts the EXCLUDE term and removes the category from the decision', () => {
    const result = scoreKeywords(keywords, context('gorivo ulje'), options);
    // auto: 2.0 − 1.0 = 1.0 over two matched tokens → 1.0 / 1.15
    expect(score('auto', result)).toBeCloseTo(1 / 1.15, 12);
    expect(result.blocked).toEqual(['auto']);
    // `ulje` must never route to Auto/Gorivo: with auto blocked, delovi wins outright.
    expect(result.decision?.categoryId).toBe('delovi');
    expect(result.decision?.score).toBeCloseTo(2, 12);
    expect(result.decision?.confidence).toBeCloseTo(keywordConfidence(2), 12);
  });

  it('never decides a category whose only hit is an EXCLUDE', () => {
    const result = scoreKeywords([keyword('auto', 'ulje', { polarity: 'EXCLUDE' })], context('ulje'), options);
    expect(score('auto', result)).toBeCloseTo(-1, 12);
    expect(result.blocked).toEqual(['auto']);
    expect(result.decision).toBeNull();
  });

  it('excludes a blocked category from the runner-up margin too', () => {
    // blocked cat has the highest score of all; the real competition is B (1.0) vs C (0.2).
    const result = scoreKeywords(
      [
        keyword('blocked', 'lidl', { weight: 9 }),
        keyword('blocked', 'maxi', { polarity: 'EXCLUDE', weight: 1 }),
        keyword('B', 'maxi', { weight: 2 }),
        keyword('C', 'idea', { weight: 0.2 }),
      ],
      context('lidl maxi idea'),
      options,
    );
    expect(result.blocked).toEqual(['blocked']);
    expect(result.decision?.categoryId).toBe('B');
    expect(result.decision?.runnerUpScore).toBeCloseTo(0.2, 12);
  });
});

describe('the decision gate', () => {
  it('decides at exactly 2.0 with exactly a 1.0 margin, confidence 0.90', () => {
    const result = scoreKeywords(
      [keyword('A', 'lidl', { weight: 2 }), keyword('B', 'maxi', { weight: 1 })],
      context('lidl maxi'),
      options,
    );
    expect(result.decision?.categoryId).toBe('A');
    expect(result.decision?.margin).toBeCloseTo(1, 12);
    expect(result.decision?.confidence).toBeCloseTo(0.9, 12);
  });

  it('decides an unopposed score ≥ 2.0', () => {
    const result = scoreKeywords([keyword('A', 'lidl', { weight: 2 })], context('lidl'), options);
    expect(result.decision?.categoryId).toBe('A');
    expect(result.decision?.runnerUpScore).toBeNull();
    expect(result.decision?.margin).toBeCloseTo(2, 12);
  });

  it('falls through when the top score is below 2.0', () => {
    const result = scoreKeywords([keyword('A', 'lidl', { weight: 1.9 })], context('lidl'), options);
    expect(result.decision).toBeNull();
    expect(result.candidates).toHaveLength(1);
  });

  it('falls through when the margin is below 1.0', () => {
    const result = scoreKeywords(
      [keyword('A', 'lidl', { weight: 2.5 }), keyword('B', 'maxi', { weight: 2 })],
      context('lidl maxi'),
      options,
    );
    expect(score('A', result)).toBeCloseTo(2.5, 12);
    expect(score('B', result)).toBeCloseTo(2, 12);
    expect(result.decision).toBeNull();
  });

  it('falls through to AI rather than guessing, keeping the candidates as context', () => {
    const result = scoreKeywords(
      [keyword('A', 'lidl', { weight: 1 }), keyword('B', 'maxi', { weight: 0.9 })],
      context('lidl maxi'),
      options,
    );
    expect(result.decision).toBeNull();
    expect(result.candidates.map((candidate) => candidate.categoryId)).toEqual(['A', 'B']);
  });

  it('returns nothing at all for empty text or no keywords', () => {
    expect(scoreKeywords([keyword('A', 'lidl')], context(''), options).decision).toBeNull();
    expect(scoreKeywords([], context('lidl'), options).candidates).toEqual([]);
  });
});

describe('the confidence mapping (derived)', () => {
  it('stays inside the stated band and is monotone in the margin', () => {
    const margins = [1, 1.2, 1.5, 2, 2.5, 3, 3.5, 4, 5, 10];
    let previous = -Infinity;
    for (const margin of margins) {
      const value = keywordConfidence(margin);
      expect(value).toBeGreaterThanOrEqual(KEYWORD_CONFIDENCE_MIN);
      expect(value).toBeLessThanOrEqual(KEYWORD_CONFIDENCE_MAX);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    expect(keywordConfidence(1)).toBeCloseTo(0.9, 12);
    expect(keywordConfidence(4)).toBeCloseTo(0.97, 12);
    expect(keywordConfidence(100)).toBeCloseTo(0.97, 12);
  });

  it('clamps rather than escaping the band for a below-floor margin', () => {
    expect(keywordConfidence(0.5)).toBeCloseTo(0.9, 12);
    expect(keywordConfidence(Number.NaN)).toBeCloseTo(0.9, 12);
  });
});

describe('folding and hygiene', () => {
  it('folds the keyword through the injected folder: Cyrillic text matches a Latin keyword', () => {
    const result = scoreKeywords(
      [keyword('jama', 'Septička', { weight: 3 })],
      context('Септичка јама'),
      options,
    );
    expect(result.candidates[0]?.categoryId).toBe('jama');
    expect(result.candidates[0]?.score).toBeCloseTo(3, 12);
  });

  it('calls the injected folder for both sides', () => {
    const recording = createRecordingFolder();
    scoreKeywords([keyword('a', 'Septička')], context('septicka'), { folder: recording });
    expect(recording.foldCalls).toContain('septicka');
    expect(recording.tokenCalls).toContain('septicka');
    expect(recording.tokenCalls).toContain('Septička');
  });

  it('is deterministic and mutates neither the keywords nor the context', () => {
    const keywords = Object.freeze([
      Object.freeze(keyword('A', 'lidl', { weight: 2 })),
      Object.freeze(keyword('B', 'maxi')),
    ]);
    const ctx = Object.freeze(context('lidl maxi'));
    const first = scoreKeywords(keywords, ctx, options);
    const second = scoreKeywords(keywords, ctx, options);
    expect(second).toEqual(first);
    expect(keywords).toHaveLength(2);
    expect(ctx.text).toBe('lidl maxi');
  });

  it('breaks a score tie by categoryId so the order never depends on input order', () => {
    const forwards = scoreKeywords(
      [keyword('B', 'lidl'), keyword('A', 'maxi')],
      context('lidl maxi'),
      options,
    );
    const backwards = scoreKeywords(
      [keyword('A', 'maxi'), keyword('B', 'lidl')],
      context('lidl maxi'),
      options,
    );
    expect(forwards.candidates.map((entry) => entry.categoryId)).toEqual(['A', 'B']);
    expect(backwards.candidates.map((entry) => entry.categoryId)).toEqual(['A', 'B']);
  });
});

describe('keyword validation', () => {
  it('refuses an invalid weight, polarity or match mode', () => {
    const cases: readonly CategoryKeyword[] = [
      { ...keyword('A', 'lidl'), weight: Number.NaN },
      { ...keyword('A', 'lidl'), weight: -1 },
      { ...keyword('A', 'lidl'), polarity: 'MAYBE' as unknown as CategoryKeyword['polarity'] },
      { ...keyword('A', 'lidl'), matchMode: 'FUZZY' as unknown as CategoryKeyword['matchMode'] },
      { ...keyword('A', 'lidl'), keyword: '' },
    ];
    for (const bad of cases) {
      expect(() => scoreKeywords([bad], context('lidl'), options)).toThrowError(RuleDocumentError);
    }
  });

  it('narrows the Prisma string columns', () => {
    expect(isKeywordMatchMode('WORD')).toBe(true);
    expect(isKeywordMatchMode('FUZZY')).toBe(false);
    expect(isKeywordPolarity('EXCLUDE')).toBe(true);
    expect(isKeywordPolarity('MAYBE')).toBe(false);
  });
});
