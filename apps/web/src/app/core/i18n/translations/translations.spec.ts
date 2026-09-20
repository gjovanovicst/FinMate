import { describe, expect, it } from 'vitest';

import { LOCALES } from '../locales';
import { deriveCyrillic, en, loadableLocales, loadCatalogue, type Catalogue } from './index';

/**
 * Catalogue integrity.
 *
 * These are the guards docs/10 §12 asks for: a key present in one language and missing from another
 * is a build failure, not a surprise in production. The TypeScript type already makes a missing key a
 * compile error; these tests catch the runtime consequences the type cannot see — an empty value, a
 * placeholder that exists in one language and not another, or a catalogue that is simply the English
 * one under another name.
 *
 * ADR-044 widened this from a hardcoded three locales to **the registry itself**, which is the point:
 * a language added to `LOCALES` is checked by this file without editing it. The one thing that cannot
 * be inferred is which languages have been reviewed by a native speaker, and that is asserted, not
 * assumed — see the machine-assisted guard at the bottom.
 */
describe('translation catalogues', () => {
  const englishKeys = Object.keys(en).sort();

  /** Every catalogue, loaded on demand. `en` is eager; the rest are lazy chunks (ADR-044). */
  const all = async (): Promise<readonly (readonly [string, Catalogue])[]> => {
    const entries: (readonly [string, Catalogue])[] = [['en', en]];
    for (const locale of LOCALES) {
      if (locale.code === 'en') continue;
      const catalogue = await loadCatalogue(locale.code);
      if (catalogue !== null) entries.push([locale.code, catalogue]);
    }
    return entries;
  };

  it('has English as the primary catalogue with a meaningful key count', () => {
    expect(englishKeys.length).toBeGreaterThan(50);
  });

  it('gives every locale in the picker a catalogue this build can load', async () => {
    // A `LOCALES` entry with no module would render a language the app cannot speak. This is the
    // completeness rule that keeps the picker and the loader from drifting.
    const missing: string[] = [];
    for (const locale of LOCALES) {
      if (locale.code === 'en') continue;
      if ((await loadCatalogue(locale.code)) === null) missing.push(locale.code);
    }
    expect(missing).toEqual([]);
  });

  it('registers a loader for every locale the picker offers, and no more', () => {
    const registered = LOCALES.map((locale) => locale.code).filter((code) => code !== 'en');
    expect([...loadableLocales()].sort()).toEqual([...registered].sort());
  });

  it('has a catalogue for every loadable locale and vice versa', async () => {
    expect((await all()).length).toBe(LOCALES.length);
  });

  it.each(LOCALES.map((locale) => locale.code))('locale "%s" has exactly the English key set', async (code) => {
    const catalogue = code === 'en' ? en : await loadCatalogue(code);
    expect(catalogue).not.toBeNull();
    expect(Object.keys(catalogue!).sort()).toEqual(englishKeys);
  });

  it.each(LOCALES.map((locale) => locale.code))('locale "%s" has no empty or whitespace-only value', async (code) => {
    const catalogue = code === 'en' ? en : await loadCatalogue(code);
    const empties = Object.entries(catalogue!)
      .filter(([, value]) => value.trim().length === 0)
      .map(([key]) => key);
    expect(empties).toEqual([]);
  });

  it.each(LOCALES.map((locale) => locale.code))('locale "%s" keeps the same placeholders as English', async (code) => {
    // A translation that drops `{min}` renders the sentence without the number; one that invents a
    // placeholder renders the raw braces. Both are user-visible defects.
    const placeholders = (value: string): string[] =>
      [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();

    const catalogue = code === 'en' ? en : await loadCatalogue(code);
    const mismatches = englishKeys.filter((key) => {
      const expected = placeholders(en[key as keyof typeof en]);
      const actual = placeholders(catalogue![key as keyof typeof en]);
      return JSON.stringify(expected) !== JSON.stringify(actual);
    });

    expect(mismatches).toEqual([]);
  });

  it('keeps the product name untranslated in every locale', async () => {
    // The name is not final (ADR-014), and a transliterated brand is a rename in disguise.
    for (const [code, catalogue] of await all()) {
      expect(`${code}:${catalogue['app.name']}`).toBe(`${code}:FinMate`);
    }
  });

  it('derives Serbian Cyrillic from Serbian Latin rather than storing it', async () => {
    // The derivation is what stops Cyrillic from lagging behind a new string: a generated catalogue
    // cannot be missing a key.
    const latin = await loadCatalogue('sr-Latn');
    expect(latin).not.toBeNull();
    const cyrillic = deriveCyrillic(latin!);
    const stored = await loadCatalogue('sr-Cyrl');
    expect(stored).toEqual(cyrillic);
    expect(stored!['accounts.title']).not.toBe(latin!['accounts.title']);
    expect(stored!['accounts.title']).toMatch(/[\u0400-\u04FF]/);
  });

  it('does not transliterate currency codes or acronyms in Cyrillic', async () => {
    const latin = (await loadCatalogue('sr-Latn'))!;
    const cyrillic = (await loadCatalogue('sr-Cyrl'))!;
    for (const key of englishKeys) {
      const value = cyrillic[key as keyof typeof cyrillic];
      for (const token of ['RSD', 'IBAN', 'CSV', 'AI']) {
        if (latin[key as keyof typeof latin].includes(token)) {
          expect(value).toContain(token);
        }
      }
    }
  });

  /**
   * The wrong-language guard, for the language it has actually caught a defect in.
   *
   * A value copied from one catalogue into another is invisible to every other test here — the key
   * sets match, the placeholders match, nothing is empty — and it is exactly the defect that shipped:
   * `onboarding.accounts.defaultName` was `Gotovina` in **English**, so a new English account was named
   * in Serbian. Serbian had the same string, which is what made it look translated.
   *
   * So identity is not assumed: a value that is byte-for-byte the same in both languages must be named
   * in {@link IDENTICAL_BY_DESIGN} with a reason. A new one fails this test until somebody decides,
   * which is the point — the alternative is a human reading 1 317 pairs in a diff.
   *
   * ⚠️ This guard is **Serbian-only on purpose**. Serbian was hand-written, so an unexplained identity
   * is evidence of a copy-paste. German, Spanish, French and Arabic are machine-assisted
   * (see the next test), and their cognates — `Total`, `Status`, `Push` — are legitimately identical
   * without being mistakes, so a per-key allowlist there would be noise pretending to be rigour.
   */
  it('only repeats a value across Serbian and English when that repetition is deliberate', async () => {
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

    const serbian = (await loadCatalogue('sr-Latn'))!;
    const unexplained = englishKeys.filter(
      (key) => en[key as keyof typeof en] === serbian[key as keyof typeof serbian] && !IDENTICAL_BY_DESIGN.has(key),
    );

    expect(unexplained).toEqual([]);
  });

  /**
   * The machine-assisted guard.
   *
   * German, Spanish, French and Arabic were produced from `en.ts` by a model in one pass and have
   * **not** been read by a native speaker. That is a known, recorded risk (R-37 in
   * docs/14-decisions-and-risks.md), and the honest test is not "is this good German" — a test cannot
   * answer that — but "is this German at all, or is it the English file under another name".
   *
   * A floor rather than a target: it catches a catalogue that was never translated, while tolerating
   * the cognates and loanwords that legitimately match English.
   */
  it.each(['de', 'es', 'fr', 'ar'])('locale "%s" is translated rather than copied from English', async (code) => {
    const catalogue = await loadCatalogue(code);
    expect(catalogue).not.toBeNull();
    const differing = englishKeys.filter((key) => catalogue![key as keyof typeof catalogue] !== en[key as keyof typeof en]);
    expect(differing.length / englishKeys.length).toBeGreaterThan(0.85);
  });

  it('ships a real English default account name and a Serbian one', async () => {
    // The regression the ADR-040 pass exists for, asserted by name so it cannot come back.
    const serbian = (await loadCatalogue('sr-Latn'))!;
    expect(en['onboarding.accounts.defaultName']).toBe('Cash');
    expect(serbian['onboarding.accounts.defaultName']).toBe('Gotovina');
  });
});
