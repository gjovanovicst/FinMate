/**
 * Serbian natural-language normalization, segmentation and extraction.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §3
 *
 * **Pure and dependency-free** (no database, no AI provider). It runs on BOTH the server and the
 * browser — docs/05 §5.3 uses it client-side so the capture preview is instant — which is why the
 * boundary rule forbids any import from `@finmate/ai` or `@finmate/rules-engine` here.
 *
 * Must handle: latin and cyrillic scripts, diacritic folding, `.`/space as thousands separators,
 * `,` as the decimal separator, `2k` shorthand, and income markers (plata, penzija, uplata).
 *
 * `foldForMatching` is the product's single match fold: the API's `normaliseForMatching` delegates to
 * it and the browser imports it directly, so stored keywords/aliases and compared text cannot drift.
 *
 * Money is delegated to `@finmate/domain`'s `parseAmount` — this package contains no second amount
 * parser, and no float ever touches an amount (ADR-003).
 */

export {
  CYRILLIC_TO_LATIN,
  foldForMatching,
  transliterateToLatin,
} from './transliterate';

export {
  foldTokens,
  normalizeFragment,
  type NormalizedFragment,
} from './normalize';

export { segmentFragments } from './segment';

export {
  extractFragment,
  extractFragments,
  INCOME_MARKERS,
  NEGATION_MARKERS,
  type ExtractOptions,
  type TransactionFragment,
} from './extract';
