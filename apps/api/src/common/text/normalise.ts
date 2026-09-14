/**
 * Fold a keyword or alias to the form matching compares against.
 *
 * **One definition, deliberately.** Category keywords, Merchant aliases and Counterparty aliases are
 * all stored normalised, and the classifier will compare them against normalised Transaction text.
 * If two of those three fold differently, a keyword silently stops matching — a bug that shows up as
 * unexplained misclassification rather than as an error, which is the worst way to find out.
 *
 * The fold itself now lives in `@finmate/nlp` (`foldForMatching`), which is also what the browser
 * imports, so the two sides cannot drift (docs/05 §5.3). This module keeps its exported name so
 * callers do not change, and adds nothing: it is a delegation, not a second implementation.
 *
 * Cyrillic → Latin transliteration (docs/04 §3.1) was the documented gap here; `packages/nlp` owns it
 * now, so `Лиди` folds to `lidi` on both the API and the web path.
 */
import { foldForMatching } from '@finmate/nlp';

export function normaliseForMatching(value: string): string {
  return foldForMatching(value);
}
