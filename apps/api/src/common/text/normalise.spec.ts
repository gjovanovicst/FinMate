import { describe, expect, it } from 'vitest';

import { normaliseForMatching } from './normalise';

describe('normaliseForMatching', () => {
  it('lower-cases so one word has one form', () => {
    expect(normaliseForMatching('LIDL')).toBe('lidl');
    expect(normaliseForMatching('Lidl')).toBe('lidl');
  });

  it('folds diacritics, because Serbian is written both ways', () => {
    expect(normaliseForMatching('septička')).toBe('septicka');
    expect(normaliseForMatching('Šećer')).toBe('secer');
    expect(normaliseForMatching('Žuta')).toBe('zuta');
  });

  it('folds đ, which NFD alone cannot — it has no canonical decomposition', () => {
    // The regression: a combining-mark strip covers č/ć/š/ž but leaves đ (U+0111) intact, so
    // "Đorđe" stayed "đorđe" and never matched a description typed "Djordje".
    expect(normaliseForMatching('Đorđe')).toBe('dorde');
    expect(normaliseForMatching('ĐAK')).toBe('dak');
    expect(normaliseForMatching('Djordje')).toBe('djordje');
  });

  it('collapses whitespace and trims, so a pasted value is not a near-duplicate', () => {
    expect(normaliseForMatching('  Lidl   Dorćol  ')).toBe('lidl dorcol');
    expect(normaliseForMatching('a\t\nb')).toBe('a b');
  });

  it('is idempotent: folding an already-folded value changes nothing', () => {
    // Callers re-normalise on every write, so a second pass must not drift.
    const once = normaliseForMatching('Šećer  Lidl');
    expect(normaliseForMatching(once)).toBe(once);
  });

  it('transliterates Cyrillic, the gap Phase 2 task 2.1.1 closed', () => {
    // This assertion used to pin the gap by expecting 'лиди'. `packages/nlp` now owns the fold and
    // transliterates Cyrillic to Latin (docs/04 §3.1), so both scripts fold to one form.
    expect(normaliseForMatching('Лиди')).toBe('lidi');
    expect(normaliseForMatching('Лиди 2000')).toBe('lidi 2000');
    expect(normaliseForMatching('Лидл')).toBe(normaliseForMatching('Lidl'));
  });

  it('returns an empty string for blank input rather than throwing', () => {
    expect(normaliseForMatching('   ')).toBe('');
    expect(normaliseForMatching('')).toBe('');
  });
});
