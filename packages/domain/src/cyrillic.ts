/**
 * Serbian Latin → Cyrillic, for generating the `sr-Cyrl` copy of a catalogue.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §3.1 (transliteration) and **ADR-019**, which decides
 * that the Cyrillic locale is **derived** rather than hand-maintained — two hand-written catalogues
 * drift, and a generated one can never be missing a key.
 *
 * This lives in `@finmate/domain` rather than in one consumer because **both sides need it**: the
 * browser generates its `sr-Cyrl` catalogue from `sr-Latn` at runtime, and the API transliterates the
 * server-rendered copy it sends (assistant answers, notifications, email). A second copy in either
 * place is how the two scripts stop agreeing.
 *
 * ## Why it is not in `@finmate/nlp`
 *
 * It was, and that broke the bundle budget: `core/i18n/translations/index.ts` is on the **eager** path
 * (the shell renders a title before any route loads), so importing `@finmate/nlp` from it dragged the
 * whole package — `extract`, `segment`, `resolve`, the fold — into the initial chunk. The shell went
 * from ~141 KB to 159.8 KB and `packages/nlp (isolated)` from a few KB to 106.2 KB, both over budget.
 * docs/07 §11 is explicit that `packages/nlp` is **"one chunk, fetched with the first route that needs
 * it — not eagerly"**, so the inert data table belongs in the one shared package the shell already
 * loads, and the matcher stays lazy. If a shared i18n package ever exists, this is what should move
 * into it.
 *
 * Two things make this safe rather than naive:
 *
 *  1. **Digraphs are matched first.** `lj`, `nj` and `dž` are single Cyrillic letters (љ, њ, џ), so a
 *     character-by-character pass produces nonsense. The same applies to `dj` → `ђ`, which is a
 *     transliteration convention rather than a Serbian digraph but is what people actually type.
 *  2. **A whitelist is exempted.** Product names, currency codes and acronyms must not be
 *     transliterated — `RSD` is not `РСД`, and a brand keeps its spelling. Same for placeholders like
 *     `{name}` and anything inside a URL, so a value interpolated *after* transliteration is untouched.
 *
 * The contract this must keep: transliterate the **template**, then interpolate. Transliterating a
 * rendered string would rewrite a user's own Category or Merchant name, which is their data.
 *
 * @module @finmate/domain
 */

/** Words and tokens that must survive transliteration unchanged. */
const PRESERVE = new Set([
  // Brand and product
  'FinMate',
  'Lidl',
  'Maxi',
  'Idea',
  'Shell',
  'OMV',
  'EPS',
  'SBB',
  'MTS',
  'Yettel',
  'Netflix',
  'Spotify',
  'iPhone',
  'iPad',
  'Safari',
  // Codes and acronyms
  'RSD',
  'EUR',
  'USD',
  'IBAN',
  'CSV',
  'JSON',
  'PDF',
  'AI',
  'OCR',
  'PIN',
  'SMS',
  // Data formats and units, which have no Serbian spelling worth inventing
  'RFC',
  'JPEG',
  'PNG',
  'HEIC',
  'WebP',
  'MiB',
  // Keyboard keys, printed on the keycaps people are looking at
  'Ctrl',
  'Enter',
  'Alt',
  // `email` is a loanword the catalogue uses inflected (`emaila`, `emailu`), and an exact-token list
  // cannot see an inflection — so the forms the copy actually contains are named here too.
  'Email',
  'email',
  'Emaila',
  'emaila',
  'Emailu',
  'emailu',
  'Emailom',
  'emailom',
]);

/**
 * Ordered longest-first so `lj` is tried before `l` and `j`.
 *
 * `dj` is **not** here: it is a stand-in for `đ` in most positions, but the two are separate letters
 * where a prefix ends in `d` and the next morpheme starts with `j` — {@link DJ_AS_TWO_LETTERS} decides
 * which. A blanket positional rule corrupted real words: `Odjavi se` (the sign-out action) became
 * `Ођави се`, `odjavljuje` `ођављује`, and `predjelo` `пређело`.
 *
 * ⚠️ `lj` and `nj` are still matched positionally, which is wrong for a handful of words where a
 * prefix ends in a consonant or `n` meets a separate `j` (`injekcija`, `konjugacija`). No string in the
 * shipped catalogue hits it, and the correct rule is morphological rather than orthographic; a future
 * reader should know this is a known limit, not an oversight.
 */
const DIGRAPHS: readonly (readonly [string, string])[] = [
  ['lj', 'љ'],
  ['Lj', 'Љ'],
  ['LJ', 'Љ'],
  ['nj', 'њ'],
  ['Nj', 'Њ'],
  ['NJ', 'Њ'],
  ['dž', 'џ'],
  ['Dž', 'Џ'],
  ['DŽ', 'Џ'],
];

/**
 * Prefixes after which `dj` is **`д` + `ј`**, not `ђ`.
 *
 * Serbian writes the same sound `ђ` for the convention `dj` (`Djordje` → `Ђорђе`), so a positional rule
 * is right almost everywhere. The exception is a prefix whose `d` starts one morpheme and whose `j`
 * starts the next: `od`+`javiti`, `pred`+`jelo`, `nad`+`jačati`, `ad`+`jektiv`. Matching against the
 * text **including the `d`** is what makes `predjelo` work — the letters before the `dj` are `pre`.
 */
const DJ_AS_TWO_LETTERS: readonly string[] = [
  'ad',
  'od',
  'pod',
  'nad',
  'pred',
  'bez',
  'iz',
  'raz',
  'ob',
  'sub',
];

const SINGLE: Readonly<Record<string, string>> = {
  a: 'а', b: 'б', c: 'ц', č: 'ч', ć: 'ћ', d: 'д', đ: 'ђ', e: 'е', f: 'ф', g: 'г', h: 'х',
  i: 'и', j: 'ј', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п', r: 'р', s: 'с',
  š: 'ш', t: 'т', u: 'у', v: 'в', z: 'з', ž: 'ж',
  // Letters Serbian does not use outside loanwords, brands and units. Without these a Latin `w`, `q`,
  // `x` or `y` survived **inside** Cyrillic text — `WebP` rendered as `WебП`.
  w: 'в', q: 'к', x: 'кс', y: 'ј',
  A: 'А', B: 'Б', C: 'Ц', Č: 'Ч', Ć: 'Ћ', D: 'Д', Đ: 'Ђ', E: 'Е', F: 'Ф', G: 'Г', H: 'Х',
  I: 'И', J: 'Ј', K: 'К', L: 'Л', M: 'М', N: 'Н', O: 'О', P: 'П', R: 'Р', S: 'С',
  Š: 'Ш', T: 'Т', U: 'У', V: 'В', Z: 'З', Ž: 'Ж',
  W: 'В', Q: 'К', X: 'Кс', Y: 'Ј',
};

/**
 * Transliterate Serbian Latin text to Cyrillic.
 *
 * Sentence case is preserved for the first letter of a word when the source word was capitalised and
 * is not in the preserve list, so "Računi" becomes "Рачуни" rather than "рачуни".
 */
export function toCyrillic(input: string): string {
  // Split on word boundaries, keeping the separators and any placeholder/URL runs intact.
  return input.replace(/https?:\/\/\S+|\{[^}]*\}|[\p{L}\p{M}]+/gu, (token) => {
    if (PRESERVE.has(token)) return token;
    // A placeholder ({name}) or URL is never translated.
    if (token.startsWith('{') || token.startsWith('http')) return token;
    return transliterateWord(token);
  });
}

function transliterateWord(word: string): string {
  let out = '';
  let index = 0;
  const lower = word.toLowerCase();

  while (index < word.length) {
    const two = word.slice(index, index + 2);

    // `dj` is a digraph for `ђ` except after a prefix that ends in `d` — see
    // {@link DJ_AS_TWO_LETTERS}.
    if (two.toLowerCase() === 'dj') {
      const before = lower.slice(0, index + 1);
      const separate = index > 0 && DJ_AS_TWO_LETTERS.some((prefix) => before.endsWith(prefix));
      const capital = word[index] === 'D' || word[index] === 'Đ';
      out += separate ? (capital ? 'ДЈ' : 'дј') : capital ? 'Ђ' : 'ђ';
      index += 2;
      continue;
    }

    const digraph = DIGRAPHS.find(([latin]) => latin === two);
    if (digraph) {
      out += digraph[1];
      index += 2;
      continue;
    }

    const char = word[index]!;
    out += SINGLE[char] ?? char;
    index += 1;
  }

  return out;
}
