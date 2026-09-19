import { describe, expect, it } from 'vitest';

import { copyIntlLocale, pick, resolveCopyLocale, tr } from './copy';

/**
 * The server copy layer (ADR-040).
 *
 * The two properties worth guarding are the ones a caller can violate silently: the **fallback**
 * (anything unrecognised is English, the product's primary language — it used to be the other way
 * round, which is how a Serbian default reached an English reader) and the **order** of transliteration
 * and interpolation, which decides whether a Household's own Category name is rewritten.
 */
describe('resolveCopyLocale', () => {
  it('maps a Serbian tag to a script, and everything else to English', () => {
    expect(resolveCopyLocale('sr-Latn-RS')).toBe('sr-Latn');
    expect(resolveCopyLocale('sr-Cyrl-RS')).toBe('sr-Cyrl');
    expect(resolveCopyLocale('sr')).toBe('sr-Latn');
    expect(resolveCopyLocale('en-US')).toBe('en');
    expect(resolveCopyLocale('de-DE')).toBe('en');
    expect(resolveCopyLocale('de-DE', 'sr-Latn')).toBe('sr-Latn');
  });

  it('treats absent, empty and null as the fallback', () => {
    // `KEY=` in `.env` is a present variable holding `''`, which is the shape that bit the push sender
    // (docs/15) — so an empty tag must not be read as a locale.
    expect(resolveCopyLocale(undefined)).toBe('en');
    expect(resolveCopyLocale(null)).toBe('en');
    expect(resolveCopyLocale('')).toBe('en');
    expect(resolveCopyLocale(undefined, 'sr-Cyrl')).toBe('sr-Cyrl');
  });

  it('is case-insensitive, because an HTTP header and a client tag do not agree on case', () => {
    expect(resolveCopyLocale('SR-LATN-RS')).toBe('sr-Latn');
    expect(resolveCopyLocale('sr-cyrl')).toBe('sr-Cyrl');
  });
});

describe('tr', () => {
  const pair = { en: 'You spent {amount}.', sr: 'Potrošio si {amount}.' };

  it('renders each language and interpolates', () => {
    expect(tr('en', pair, { amount: '100' })).toBe('You spent 100.');
    expect(tr('sr-Latn', pair, { amount: '100' })).toBe('Potrošio si 100.');
    expect(tr('sr-Cyrl', pair, { amount: '100' })).toBe('Потрошио си 100.');
  });

  it('leaves an unknown placeholder in place rather than rendering nothing', () => {
    expect(tr('en', pair)).toContain('{amount}');
    expect(tr('en', pair, { other: 'x' })).toContain('{amount}');
  });

  it('transliterates the template and never the interpolated value', () => {
    // The order is the contract: a Household's own Category name is data, and rewriting `Hrana` into
    // `Храна` would put a script the reader never typed into their own ledger.
    expect(tr('sr-Cyrl', pair, { amount: 'Hrana / Supermarket' })).toBe('Потрошио си Hrana / Supermarket.');
  });
});

describe('pick', () => {
  it('selects by language and derives Cyrillic from the Serbian variant', () => {
    // `pick` is for values that are not plain strings — a list, a label set. Cyrillic is the Serbian
    // variant's own job to transliterate per string, so `pick` returns it unchanged.
    expect(pick('en', { en: ['a'], sr: ['b'] })).toEqual(['a']);
    expect(pick('sr-Latn', { en: ['a'], sr: ['b'] })).toEqual(['b']);
    expect(pick('sr-Cyrl', { en: ['a'], sr: ['b'] })).toEqual(['b']);
  });
});

describe('copyIntlLocale', () => {
  it('gives every copy locale a tag for money formatting', () => {
    // A Serbian sentence must not contain an amount grouped for English (docs/15).
    expect(copyIntlLocale('en')).toBe('en-US');
    expect(copyIntlLocale('sr-Latn')).toBe('sr-Latn-RS');
    expect(copyIntlLocale('sr-Cyrl')).toBe('sr-Cyrl-RS');
  });
});
