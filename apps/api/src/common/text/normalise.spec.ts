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

  it('leaves Cyrillic alone for now — transliteration is Phase 2 task 2.1.1', () => {
    // Pinned so the gap is visible rather than assumed. When this test starts failing, the
    // transliteration work has landed and the expectation should become 'lidi'.
    expect(normaliseForMatching('Лиди')).toBe('лиди');
  });

  it('returns an empty string for blank input rather than throwing', () => {
    expect(normaliseForMatching('   ')).toBe('');
    expect(normaliseForMatching('')).toBe('');
  });
});
