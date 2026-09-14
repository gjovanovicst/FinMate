import { describe, expect, it } from 'vitest';

import { foldTokens, normalizeFragment } from './normalize';

describe('foldTokens', () => {
  it('drops punctuation, separators and currency symbols', () => {
    expect(foldTokens('Lidl, Dorćol!')).toEqual(['lidl', 'dorcol']);
    expect(foldTokens('2.000 rsd')).toEqual(['2', '000', 'rsd']);
    expect(foldTokens('20€')).toEqual(['20']);
  });

  it('transliterates so both scripts tokenize together', () => {
    expect(foldTokens('Лиди 2000')).toEqual(['lidi', '2000']);
  });

  it('returns nothing for blank input rather than a phantom token', () => {
    expect(foldTokens('')).toEqual([]);
    expect(foldTokens('   ')).toEqual([]);
    expect(foldTokens('...')).toEqual([]);
  });
});

describe('normalizeFragment', () => {
  it('keeps the raw display text and folds only a copy', () => {
    const result = normalizeFragment('  Đorđe  Šećer  ');
    expect(result.rawText).toBe('Đorđe  Šećer');
    expect(result.foldedText).toBe('dorde secer');
    expect(result.tokens).toEqual(['dorde', 'secer']);
  });

  it('never rewrites the display text', () => {
    const result = normalizeFragment('Septička jama');
    expect(result.rawText).toBe('Septička jama');
  });
});
