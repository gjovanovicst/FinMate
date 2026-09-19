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

  /**
   * The wrong-language guard.
   *
   * A value copied from one catalogue into another is invisible to every other test here — the key
   * sets match, the placeholders match, nothing is empty — and it is exactly the defect that shipped:
   * `onboarding.accounts.defaultName` was `Gotovina` in **English**, so a new English account was named
   * in Serbian. Serbian had the same string, which is what made it look translated.
   *
   * So identity is not assumed: a value that is byte-for-byte the same in both languages must be named
   * in {@link IDENTICAL_BY_DESIGN} with a reason. A new one fails this test until somebody decides,
   * which is the point — the alternative is a human reading 1 195 pairs in a diff.
   */
  it('only repeats a value across locales when that repetition is deliberate', () => {
    const IDENTICAL_BY_DESIGN = new Set([
      // The brand is not translated (ADR-014, and the `app.name` assertion above).
      'app.name',
      // Placeholder-only values: nothing to translate.
      'analytics.comparisonNow',
      'capture.rowError',
      // Loanwords and codes that Serbian writes the same way.
      'notifications.channel.EMAIL',
      'notifications.channel.PUSH',
      'consent.title',
      'pending.field.status',
      'role.ADMIN',
      'signIn.email',
      'reset.email',
      'signUp.email',
      'transactions.status',
      'budgets.period',
      // A merchant name and an amount: the capture example is the same input in both languages.
      'capture.example1',
    ]);

    const unexplained = englishKeys.filter(
      (key) => en[key as keyof typeof en] === srLatn[key as keyof typeof srLatn] && !IDENTICAL_BY_DESIGN.has(key),
    );

    expect(unexplained).toEqual([]);
  });

  it('ships a real English default account name and a Serbian one', () => {
    // The regression this whole pass exists for, asserted by name so it cannot come back.
    expect(en['onboarding.accounts.defaultName']).toBe('Cash');
    expect(srLatn['onboarding.accounts.defaultName']).toBe('Gotovina');
  });
});
