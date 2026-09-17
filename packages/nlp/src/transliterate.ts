/**
 * Cyrillic → Latin transliteration and the match fold.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §3.1.
 *
 * `foldForMatching` is the single fold the whole product compares with: category keywords, Merchant
 * aliases, Counterparty aliases and Transaction text all pass through it. The API keeps its
 * `normaliseForMatching` name but delegates here, and the browser imports this directly, so the two
 * sides cannot drift (docs/05 §5.3).
 *
 * @module @finmate/nlp
 */

/**
 * The Serbian Cyrillic → Latin table, reproduced verbatim from docs/04 §3.1.
 *
 * Deliberately **not** an exhaustive Slavic table: Serbian Cyrillic has no `щ`, `ъ`, `ы`, `э`, `ю`
 * or `я`, and inventing mappings for them would fold characters this market does not type.
 */
export const CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = Object.freeze({
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  ђ: 'dj',
  е: 'e',
  ж: 'z',
  з: 'z',
  и: 'i',
  ј: 'j',
  к: 'k',
  л: 'l',
  љ: 'lj',
  м: 'm',
  н: 'n',
  њ: 'nj',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  ћ: 'c',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'c',
  џ: 'dz',
  ш: 's',
});

/**
 * The uppercase half of the table, derived rather than hand-written so the two cases can never
 * disagree. Digraphs stay correct because lower-casing happens after transliteration: `Љ` → `LJ`
 * → `lj`.
 */
const CYRILLIC_UPPERCASE_TO_LATIN: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(CYRILLIC_TO_LATIN).map(([cyrillic, latin]) => [
      cyrillic.toLocaleUpperCase('sr-Cyrl-RS'),
      latin.toLocaleUpperCase('sr-Latn-RS'),
    ]),
  ),
);

/**
 * Replace every Serbian Cyrillic letter with its Latin counterpart, leaving everything else
 * (including Latin diacritics) untouched.
 */
export function transliterateToLatin(value: string): string {
  let result = '';
  for (const character of value) {
    result +=
      CYRILLIC_TO_LATIN[character] ??
      CYRILLIC_UPPERCASE_TO_LATIN[character] ??
      character;
  }
  return result;
}

/**
 * Fold text to the form matching compares against.
 *
 * Order matters and is fixed by docs/04 §3.1: **transliterate, then case, then diacritics, then the
 * orthographic `x` fold, then whitespace**. Doing case first would leave uppercase Cyrillic unmapped;
 * doing diacritics first would leave Cyrillic alone entirely.
 *
 * This is for comparison **only** — it must never be used to rewrite displayed text, or a user who
 * typed `Septička` would be shown `septicka`.
 */
export function foldForMatching(value: string): string {
  return transliterateToLatin(value)
    .trim()
    .toLocaleLowerCase('sr-Latn-RS')
    .normalize('NFD')
    // Combining marks cover č, ć, š, ž — but NOT đ (U+0111), which has no canonical decomposition
    // and so would survive every fold. That left `Đorđe` unmatchable against a description typed
    // `Djordje`; the explicit replacement below closes it.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    // Serbian has no letter `x`: it is a typographic variant of `ks` (`Maxi` ≡ `Maksi`, `taxi` ≡
    // `taksi`, `Univerexport` ≡ `Univereksport`), so a foreign or brand spelling must meet the
    // domestic one. A **run** folds to a single `ks`, because a doubled `xx` is brand styling and not
    // a longer sound (`Cineplexx` ≡ `Cinepleks`). Both sides of every comparison pass through here,
    // which is what makes a typed `Maksi 2000` meet a stored `maxi` keyword. Found by the A-4 battery
    // (`koliko sam potrošio u Maksiju`) — see docs/04 §3.1 and docs/06 §8.8.
    .replace(/x+/g, 'ks')
    .replace(/\s+/g, ' ');
}
