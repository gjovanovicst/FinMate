import { describe, expect, it } from 'vitest';

import { foldTokens } from './normalize';
import { CYRILLIC_TO_LATIN, foldForMatching, transliterateToLatin } from './transliterate';

describe('transliterateToLatin', () => {
  it('maps every character in the docs/04 §3.1 table, in both cases', () => {
    for (const [cyrillic, latin] of Object.entries(CYRILLIC_TO_LATIN)) {
      expect(transliterateToLatin(cyrillic)).toBe(latin);
      // Uppercase is derived from the same table so the two cases cannot disagree.
      expect(transliterateToLatin(cyrillic.toLocaleUpperCase('sr-Cyrl-RS'))).toBe(
        latin.toLocaleUpperCase('sr-Latn-RS'),
      );
    }
  });

  it('maps the Serbian letters that are not one-to-one', () => {
    expect(transliterateToLatin('ђ')).toBe('dj');
    expect(transliterateToLatin('ћ')).toBe('c');
    expect(transliterateToLatin('џ')).toBe('dz');
    expect(transliterateToLatin('љ')).toBe('lj');
    expect(transliterateToLatin('њ')).toBe('nj');
    expect(transliterateToLatin('ј')).toBe('j');
  });

  it('leaves Latin and non-Serbian characters untouched', () => {
    expect(transliterateToLatin('Lidl Đorđe 42!')).toBe('Lidl Đorđe 42!');
    // Serbian Cyrillic has no щ; inventing a mapping would fold a character nobody types.
    expect(transliterateToLatin('щ')).toBe('щ');
  });

  it('never mutates the input', () => {
    const input = 'Љубав';
    expect(transliterateToLatin(input)).toBe('LJubav');
    expect(input).toBe('Љубав');
  });
});

describe('foldForMatching', () => {
  it('transliterates Cyrillic to Latin', () => {
    expect(foldForMatching('Лиди')).toBe('lidi');
    expect(foldForMatching('Лиди 2000')).toBe('lidi 2000');
  });

  it('folds Latin diacritics, including đ which NFD alone cannot', () => {
    expect(foldForMatching('Đorđe')).toBe('dorde');
    expect(foldForMatching('ĐAK')).toBe('dak');
    expect(foldForMatching('Septička')).toBe('septicka');
    expect(foldForMatching('Šećer')).toBe('secer');
    expect(foldForMatching('Žuta')).toBe('zuta');
    // `dj` is a legitimate Latin spelling and stays as typed; only đ folds to d.
    expect(foldForMatching('Djordje')).toBe('djordje');
  });

  it('folds a Cyrillic word and its Latin spelling to the same form', () => {
    // docs/04 §3.1's example is `Лиди 2000` vs `Lidl 2000`. With the table in the same section
    // (и:'i', д:'d') `Лиди` is the transliteration of `Lidi`, so the literal example only holds for
    // the correct Cyrillic spelling of Lidl, `Лидл`. Both properties are asserted so neither the
    // table nor the intent is silently lost.
    expect(foldForMatching('Лидл')).toBe(foldForMatching('Lidl'));
    expect(foldTokens('Лидл 2000')).toEqual(foldTokens('Lidl 2000'));
    expect(foldForMatching('Лиди')).toBe(foldForMatching('Lidi'));
    expect(foldTokens('Лиди 2000')).toEqual(['lidi', '2000']);
  });

  it('folds the domestic `ks` and the foreign `x` to one form', () => {
    // A-10. Serbian has no `x`, so the brand spelling and the domestic one must meet: the whole point
    // is that a Household's stored `maxi` keyword and a typed `Maksi 2000` resolve together.
    expect(foldForMatching('Maxi')).toBe('maksi');
    expect(foldForMatching('Maksi')).toBe('maksi');
    expect(foldForMatching('taxi')).toBe('taksi');
    expect(foldForMatching('Univerexport')).toBe(foldForMatching('Univereksport'));
    // `Maksiju` is an inflected form and stays distinct — the fold only canonicalises the pair, so the
    // planner's case-ending rung is what then recognises it (query-planner.spec.ts).
    expect(foldForMatching('Maksiju')).toBe('maksiju');
  });

  it('collapses a run of `x` to one `ks`, because a doubled `xx` is styling', () => {
    // `Cineplexx` is the brand's own spelling; `Cinepleks` is how the market writes it. Folding each
    // character would give `cinepleksks` and match neither.
    expect(foldForMatching('Cineplexx')).toBe('cinepleks');
    expect(foldForMatching('Cineplexx')).toBe(foldForMatching('Cinepleks'));
    expect(foldForMatching('X')).toBe('ks');
  });

  it('lower-cases, collapses whitespace and trims', () => {
    expect(foldForMatching('LIDL')).toBe('lidl');
    expect(foldForMatching('  Lidl   Dorćol  ')).toBe('lidl dorcol');
    expect(foldForMatching('a\t\nb')).toBe('a b');
    expect(foldForMatching('   ')).toBe('');
    expect(foldForMatching('')).toBe('');
  });

  it('is idempotent, so re-normalising on every write cannot drift', () => {
    const cases = ['Đorđe', 'Šećer  Lidl', 'Лиди 2000', '  a\tb ', 'Љубав', 'Maxi', 'Cineplexx', 'Maksi 2000'];
    for (const value of cases) {
      const once = foldForMatching(value);
      expect(foldForMatching(once)).toBe(once);
    }
  });

  it('is idempotent over a generated corpus (property)', () => {
    // Exhaustive over the table plus its Latin output, rather than a random sample: the fold is a
    // pure function of characters, so the interesting inputs are exactly the mapped ones.
    const characters = [
      ...Object.keys(CYRILLIC_TO_LATIN),
      ...Object.values(CYRILLIC_TO_LATIN),
      ...Object.keys(CYRILLIC_TO_LATIN).map((character) =>
        character.toLocaleUpperCase('sr-Cyrl-RS'),
      ),
      // A-10's substitution is not in the transliteration table, so it is named explicitly: if the
      // `x` rule ever produced a form containing another `x`, this is what would catch it.
      'x',
      'X',
    ];
    for (const character of characters) {
      const once = foldForMatching(character);
      expect(foldForMatching(once)).toBe(once);
    }
  });
});
