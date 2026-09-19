/**
 * Serbian natural-language normalization, segmentation, extraction and the pure half of entity
 * resolution.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §3 (normalize / segment / extract) and §4 steps 1–4
 * (exact → normalized → prefix/token → trigram). Step 5, the embedding k-NN, is I/O and lands in the
 * API/worker layer as task 2.3.4.
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

// Latin → Cyrillic, for generating the `sr-Cyrl` copy of a catalogue (ADR-019). Shared because the
// browser derives its catalogue and the API transliterates server-rendered copy with the same rules.
export { toCyrillic } from './cyrillic';

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

export {
  TRIGRAM_CONFIDENCE_MAX,
  TRIGRAM_CONFIDENCE_MIN,
  TRIGRAM_SIMILARITY_THRESHOLD,
  pgTrigramSimilarity,
  trigramConfidence,
  trigramsOf,
  type TrigramSimilarity,
} from './trigram';

export {
  RESOLUTION_LADDER,
  RUNG_CONFIDENCE,
  resolveEntity,
  type CounterpartyType,
  type EntityCandidate,
  type EntityKind,
  type EntityMatch,
  type EntityResolutionResult,
  type ResolveEntityOptions,
  type ResolutionRung,
} from './resolve';
