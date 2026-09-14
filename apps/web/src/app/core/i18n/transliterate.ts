/**
 * Serbian Cyrillic, derived from Serbian Latin.
 *
 * ADR-019: `sr-Cyrl` is **generated** from `sr-Latn` rather than hand-maintained, because Serbian
 * is close to a 1:1 script mapping and two hand-written catalogues drift apart. Generating it means
 * a new string can never be missing from the Cyrillic locale.
 *
 * Two things make this safe rather than naive:
 *
 *  1. **Digraphs are matched first.** `lj`, `nj` and `dž` are single Cyrillic letters (љ, њ, џ), so a
 *     character-by-character pass produces nonsense. The same applies to `dj` → `ђ`, which is a
 *     transliteration convention rather than a Serbian digraph but is what people actually type.
 *  2. **A whitelist is exempted.** Product names, currency codes and acronyms must not be
 *     transliterated — "RSD" is not "РСД", and a brand keeps its spelling. Same for placeholders
 *     like `{name}` and anything inside a URL.
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
  'Email',
  'email',
]);

/** Ordered longest-first so `lj` is tried before `l` and `j`. */
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
  ['dj', 'ђ'],
  ['Dj', 'Ђ'],
  ['DJ', 'Ђ'],
];

const SINGLE: Readonly<Record<string, string>> = {
  a: 'а', b: 'б', c: 'ц', č: 'ч', ć: 'ћ', d: 'д', đ: 'ђ', e: 'е', f: 'ф', g: 'г', h: 'х',
  i: 'и', j: 'ј', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п', r: 'р', s: 'с',
  š: 'ш', t: 'т', u: 'у', v: 'в', z: 'з', ž: 'ж',
  A: 'А', B: 'Б', C: 'Ц', Č: 'Ч', Ć: 'Ћ', D: 'Д', Đ: 'Ђ', E: 'Е', F: 'Ф', G: 'Г', H: 'Х',
  I: 'И', J: 'Ј', K: 'К', L: 'Л', M: 'М', N: 'Н', O: 'О', P: 'П', R: 'Р', S: 'С',
  Š: 'Ш', T: 'Т', U: 'У', V: 'В', Z: 'З', Ž: 'Ж',
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

  while (index < word.length) {
    const two = word.slice(index, index + 2);
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
