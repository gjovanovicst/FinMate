import { describe, expect, it } from 'vitest';

import { CATALOGUES, en, srCyrl, srLatn } from './index';

/**
 * Catalogue integrity.
 *
 * These are the guards docs/10 §12 asks for: a key present in one language and missing from another
 * is a build failure, not a surprise in production. The TypeScript type already makes a missing key
 * a compile error; these tests catch the runtime consequences the type cannot see — an empty
 * string, or a placeholder that exists in one language and not another.
 */
describe('translation catalogues', () => {
  const locales = Object.keys(CATALOGUES) as (keyof typeof CATALOGUES)[];
  const englishKeys = Object.keys(en).sort();

  it('has English as the primary catalogue with a meaningful key count', () => {
    expect(englishKeys.length).toBeGreaterThan(50);
  });

  it.each(locales)('locale "%s" has exactly the English key set', (locale) => {
    expect(Object.keys(CATALOGUES[locale]).sort()).toEqual(englishKeys);
  });

  it.each(locales)('locale "%s" has no empty or whitespace-only value', (locale) => {
    const empties = Object.entries(CATALOGUES[locale])
      .filter(([, value]) => value.trim().length === 0)
      .map(([key]) => key);
    expect(empties).toEqual([]);
  });

  it.each(locales)('locale "%s" keeps the same placeholders as English', (locale) => {
    // A translation that drops `{min}` renders the sentence without the number; one that invents a
    // placeholder renders the raw braces. Both are user-visible defects.
    const placeholders = (value: string): string[] =>
      [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();

    const mismatches = englishKeys.filter((key) => {
      const expected = placeholders(en[key as keyof typeof en]);
      const actual = placeholders(CATALOGUES[locale][key as keyof typeof en]);
      return JSON.stringify(expected) !== JSON.stringify(actual);
    });

    expect(mismatches).toEqual([]);
  });

  it('keeps the product name untranslated in every locale', () => {
    // The name is not final (ADR-014), and a transliterated brand is a rename in disguise.
    expect(en['app.name']).toBe('FinMate');
    expect(srLatn['app.name']).toBe('FinMate');
    expect(srCyrl['app.name']).toBe('FinMate');
  });

  it('does not transliterate currency codes or acronyms in Cyrillic', () => {
    for (const key of englishKeys) {
      const value = srCyrl[key as keyof typeof srCyrl];
      for (const token of ['RSD', 'IBAN', 'CSV', 'AI']) {
        if (srLatn[key as keyof typeof srLatn].includes(token)) {
          expect(value).toContain(token);
        }
      }
    }
  });

  it('produces Cyrillic for Cyrillic-script keys and Latin elsewhere', () => {
    // A sanity check that the derivation actually ran rather than silently copying Latin.
    expect(srCyrl['accounts.title']).not.toBe(srLatn['accounts.title']);
    expect(srCyrl['accounts.title']).toMatch(/[\u0400-\u04FF]/);
  });
});
