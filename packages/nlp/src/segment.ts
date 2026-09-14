/**
 * Fragment segmentation.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §3: input is "one or more transaction fragments
 * separated by comma, newline, `;`, ` i `, `+`, or ` pa `". Each fragment is parsed independently,
 * which is what makes the bulk-capture line work.
 *
 * @module @finmate/nlp
 */

/**
 * Stands in for a comma that is a **decimal separator**, so the split below can tell `2,50` (one
 * fragment) from `2000, gorivo` (two). A NUL is used because it cannot occur in user input and is
 * not a separator itself.
 */
const DECIMAL_COMMA = '\u0000';

/**
 * One or more hard separators, or an inline conjunction surrounded by whitespace.
 *
 * - The conjunction arm requires whitespace on **both** sides, so it can never split inside a word
 *   (`pivo` contains no standalone `i`).
 * - Cyrillic `и` and `па` are accepted alongside the Latin spellings docs/04 lists, because the
 *   whole package exists to treat both scripts as one input language.
 */
const SEPARATORS = /[,;\r\n+]+|\s+(?:i|и|pa|па)\s+/giu;

/**
 * A comma is a decimal separator when it sits **directly between two digits**; anywhere else it is
 * the fragment separator docs/04 §3 names. This is the rule that keeps `2,50` whole without stopping
 * `Lidl 2000, gorivo 3500` from splitting.
 */
function protectDecimalCommas(input: string): string {
  return input.replace(/(\d),(\d)/g, `$1${DECIMAL_COMMA}$2`);
}

/** Split raw capture input into fragments, trimmed, in input order, with blanks dropped. */
export function segmentFragments(input: string): readonly string[] {
  return protectDecimalCommas(input)
    .split(SEPARATORS)
    .map((fragment) => fragment.replaceAll(DECIMAL_COMMA, ',').trim())
    .filter((fragment) => fragment.length > 0);
}
