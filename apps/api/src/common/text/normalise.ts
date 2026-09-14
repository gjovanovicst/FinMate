/**
 * Fold a keyword or alias to the form matching compares against.
 *
 * **One definition, deliberately.** Category keywords, Merchant aliases and Counterparty aliases are
 * all stored normalised, and the classifier will compare them against normalised Transaction text.
 * If two of those three fold differently, a keyword silently stops matching — a bug that shows up as
 * unexplained misclassification rather than as an error, which is the worst way to find out.
 *
 * Three folds, each earning its place:
 *  - **case**, because a user types `Lidl`, `LIDL` and `lidl` meaning one thing;
 *  - **diacritics** (`NFD` then drop combining marks), because Serbian is written both with and
 *    without them — `septička` and `septicka` are the same word to a person;
 *  - **whitespace**, because runs of spaces survive a paste and would create near-duplicate rows.
 *
 * **Known gap, owned by Phase 2.** docs/04 §3 requires Cyrillic → Latin transliteration too
 * (`Лиди 2000` must hit the same keywords as `Lidl 2000`), and that is *not* implemented here. It is
 * task 2.1.1's job, along with moving this function into `packages/nlp` (currently an empty stub) so
 * the browser and the server share it. Doing half of it here would leave the two call sites
 * disagreeing about what "normalised" means, which is the failure this module exists to prevent.
 */
export function normaliseForMatching(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('sr-Latn-RS')
    .normalize('NFD')
    // Combining marks cover č, ć, š, ž — but NOT đ (U+0111), which has no canonical decomposition
    // and so survived every fold. That left the fold inconsistent: `septička` folded and `Đorđe`
    // did not, so a keyword typed one way never matched a description typed the other.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ');
}
