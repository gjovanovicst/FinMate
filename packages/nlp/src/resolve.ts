/**
 * Stage 3 entity resolution: the pure ladder of docs/04 §4, steps 1–4.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §4.
 *
 * ## The ladder
 *
 * ```text
 * 1. Exact alias match        (merchant_aliases / counterparty_aliases)  → confidence 1.00
 * 2. Normalized exact match   (lowercase, unaccented, transliterated)    → confidence 0.98
 * 3. Prefix / token match     ("lidl prodavnica" → "lidl")               → confidence 0.90
 * 4. Trigram similarity       pg_trgm similarity > 0.55                  → confidence 0.55–0.85
 * 5. (embedding k-NN — task 2.3.4, NOT here)
 * 6. No match                                                            → unresolved
 * ```
 *
 * ## The boundary this module draws
 *
 * **Steps 1–4 are pure.** They are text matching that reuses the fold this package already owns
 * ({@link foldForMatching} / {@link foldTokens}), so they live here. **Step 5 is I/O** — it queries
 * `pgvector` for a Household's own vectors — and belongs to the API/worker layer in task 2.3.4; this
 * module neither implements it nor imports anything from `apps/`. **Loading a Household's Merchants,
 * Counterparties and their aliases is I/O too**, and stays with the caller: {@link resolveEntity}
 * takes candidates as data.
 *
 * ## What the caller still owns
 *
 * The result names the rung, the confidence and the losing candidates, but it is **not** a decision.
 * §4 stops at the first rung *with a hit*; the confidence that hit carries is what ADR-009 turns into
 * a lane. A rung-4 hit near the threshold is in the "ask" lane and must not auto-apply — do not add a
 * second gate in front of this function.
 *
 * **Merchant vs. Counterparty disambiguation is deliberately not here.** §4's final paragraph
 * (retail semantics, transaction counts, amount brackets, the LLM deciding once) needs data this
 * pure function does not have; it attaches in the 2.2.3 classification module. See the module report.
 *
 * @module @finmate/nlp
 */

import { foldTokens } from './normalize';
import { foldForMatching } from './transliterate';
import {
  TRIGRAM_SIMILARITY_THRESHOLD,
  pgTrigramSimilarity,
  trigramConfidence,
  type TrigramSimilarity,
} from './trigram';

/** `merchants` / `counterparties` — the two entity kinds Stage 3 resolves. */
export type EntityKind = 'MERCHANT' | 'COUNTERPARTY';

/** `counterparties.type` CHECK (docs/03). */
export type CounterpartyType = 'PERSON' | 'COMPANY' | 'GOVERNMENT' | 'OTHER';

/**
 * One resolution candidate: a Merchant or a Counterparty with its aliases, as the caller loaded it.
 *
 * The fields mirror docs/03's DDL without importing Prisma types. `id`, `kind`, `name` and `aliases`
 * are the columns Stage 3 matches on; the rest are carried through so the winner can be handed
 * straight to the caller without a second lookup.
 */
export interface EntityCandidate {
  /** `merchants.id` / `counterparties.id`. */
  readonly id: string;
  readonly kind: EntityKind;
  /** `merchants.name` / `counterparties.name` — display text, never rewritten. */
  readonly name: string;
  /** `merchant_aliases.alias` / `counterparty_aliases.alias`, in load order. */
  readonly aliases: readonly string[];
  /** `merchants.default_category_id` / `counterparties.default_category_id`. */
  readonly defaultCategoryId?: string | null;
  /** `merchants.is_global` — a shipped, read-only seed row. */
  readonly isGlobal?: boolean;
  /** `merchants.ai_hint`. */
  readonly aiHint?: string | null;
  /** `counterparties.type`. */
  readonly counterpartyType?: CounterpartyType;
  /** `counterparties.note`. */
  readonly note?: string | null;
}

/** Which rung resolved the text (or `UNRESOLVED`). Mirrors `classification_decisions.decided_by`'s Stage-3 subset. */
export type ResolutionRung = 'EXACT' | 'NORMALIZED' | 'PREFIX' | 'TRIGRAM' | 'UNRESOLVED';

/** The rungs in evaluation order, cheapest first (docs/04 §4). */
export const RESOLUTION_LADDER = Object.freeze([
  'EXACT',
  'NORMALIZED',
  'PREFIX',
  'TRIGRAM',
] as const);

/**
 * The confidence docs/04 §4 fixes for each exact rung. The trigram rung is a band, not a point —
 * use {@link trigramConfidence} for it. Exported so the caller and the tests share one definition.
 */
export const RUNG_CONFIDENCE = Object.freeze({
  /** Rung 1: the trimmed input equals a stored alias or the canonical name, character for character. */
  EXACT: 1.0,
  /** Rung 2: the folded input equals a folded alias or name. */
  NORMALIZED: 0.98,
  /** Rung 3: a name/alias token sequence occurs among the input's tokens. */
  PREFIX: 0.9,
});

/** One candidate that cleared the firing rung. */
export interface EntityMatch {
  readonly entity: EntityCandidate;
  /** Never `UNRESOLVED` — only rung-clearing candidates are reported. */
  readonly rung: Exclude<ResolutionRung, 'UNRESOLVED'>;
  /** docs/04 §4's confidence for this rung, or the mapped band value for `TRIGRAM`. */
  readonly confidence: number;
  /** The canonical name or alias that matched, as stored (display text). */
  readonly matchedOn: string;
  /** Whether {@link matchedOn} came from `name` or from an alias row. */
  readonly matchedField: 'NAME' | 'ALIAS';
  /** Raw similarity for `TRIGRAM`; `1` for the exact rungs. Debug only — never gate on it. */
  readonly similarity: number;
}

/**
 * The whole of docs/04 §4 steps 1–4, ready for a `classification_decisions` row.
 *
 * `candidates` is the debuggable part, in the shape `rules-engine` returns its losers: the winner
 * first, then every other candidate that cleared the **same** rung. Candidates that cleared no rung
 * — including a weak trigram hit below 0.55 — are absent, so an unresolved result cannot be mistaken
 * for "the best of a bad lot".
 */
export interface EntityResolutionResult {
  readonly resolved: boolean;
  readonly rung: ResolutionRung;
  /** The winning entity, or `null` when {@link resolved} is false. */
  readonly entity: EntityCandidate | null;
  /** The winner's confidence, or `null` when {@link resolved} is false. */
  readonly confidence: number | null;
  /** The winner's matched name/alias, or `null` when {@link resolved} is false. */
  readonly matchedOn: string | null;
  /** Winner first, then the losing candidates on the same rung, in deterministic order. */
  readonly candidates: readonly EntityMatch[];
}

/** Options for {@link resolveEntity}. */
export interface ResolveEntityOptions {
  /**
   * The rung-4 similarity. Defaults to {@link pgTrigramSimilarity} (pg_trgm's own definition); the
   * API should pass SQL `similarity()` so `pg_trgm`'s index accelerates it. See `./trigram` for the
   * requirement that the two agree on the definition.
   */
  readonly similarity?: TrigramSimilarity;
  /** Overrides {@link TRIGRAM_SIMILARITY_THRESHOLD}. Present so a caller can tune per Household. */
  readonly trigramThreshold?: number;
}

/** A name or alias prepared for matching, with its folded form and tokens computed once. */
interface MatchKey {
  readonly value: string;
  readonly field: 'NAME' | 'ALIAS';
  readonly folded: string;
  readonly tokens: readonly string[];
}

/**
 * Resolve one piece of text against a Household's candidate entities.
 *
 * Rungs run cheapest first and the ladder stops at the first rung that produced a hit (docs/04 §4),
 * so a caller can rely on the reported rung being the strongest one available for the text. Inputs
 * are never mutated; the same inputs always produce a deep-equal result.
 */
export function resolveEntity(
  text: string,
  candidates: readonly EntityCandidate[],
  options: ResolveEntityOptions = {},
): EntityResolutionResult {
  const input = text.trim();
  const foldedInput = foldForMatching(input);

  if (foldedInput.length === 0 || candidates.length === 0) return unresolved();

  const inputTokens = foldTokens(input);
  const prepared = candidates.map((entity) => ({ entity, keys: matchKeysFor(entity) }));

  for (const rung of RESOLUTION_LADDER) {
    const matches =
      rung === 'TRIGRAM'
        ? trigramMatches(prepared, foldedInput, options)
        : exactRungMatches(rung, prepared, input, foldedInput, inputTokens);

    if (matches.length > 0) return resolution(rung, matches);
  }

  return unresolved();
}

/** Every name/alias of a candidate, folded and tokenized, empties dropped. */
function matchKeysFor(entity: EntityCandidate): readonly MatchKey[] {
  const keys: MatchKey[] = [];
  const add = (field: 'NAME' | 'ALIAS', value: string): void => {
    const folded = foldForMatching(value);
    // An alias that folds to nothing can never match a non-empty input; keeping it would only add a
    // phantom tie to every result.
    if (folded.length === 0) return;
    keys.push({ value, field, folded, tokens: foldTokens(value) });
  };

  add('NAME', entity.name);
  for (const alias of entity.aliases) add('ALIAS', alias);
  return keys;
}

type PreparedCandidate = { readonly entity: EntityCandidate; readonly keys: readonly MatchKey[] };

/** Rungs 1–3: raw equality, folded equality and token/prefix containment. */
function exactRungMatches(
  rung: Exclude<ResolutionRung, 'TRIGRAM' | 'UNRESOLVED'>,
  prepared: readonly PreparedCandidate[],
  input: string,
  foldedInput: string,
  inputTokens: readonly string[],
): EntityMatch[] {
  const matches: EntityMatch[] = [];
  for (const { entity, keys } of prepared) {
    const key = bestKey(keys, (candidate) => {
      switch (rung) {
        case 'EXACT':
          // Rung 1 compares the string **as supplied**. Aliases are stored normalised (docs/03), so
          // in production a stored alias usually lands on rung 2; rung 1 is what catches a typed
          // canonical name such as `Lidl` exactly as it is displayed.
          return candidate.value === input;
        case 'NORMALIZED':
          return candidate.folded === foldedInput;
        case 'PREFIX':
          // The doc's "prefix / token" example: every token of the name/alias occurs among the
          // input's tokens, so `lidl prodavnica` and `prodavnica lidl` both reach `lidl`. Word order
          // is deliberately irrelevant; a bare prefix of a *word* (`prod` → `prodavnica`) is not a
          // match, because at 0.90 that would auto-apply on an abbreviation.
          return (
            candidate.tokens.length > 0 &&
            candidate.tokens.every((token) => inputTokens.includes(token))
          );
      }
    });
    if (key === null) continue;
    matches.push({
      entity,
      rung,
      confidence: RUNG_CONFIDENCE[rung],
      matchedOn: key.value,
      matchedField: key.field,
      similarity: 1,
    });
  }
  return matches;
}

/** Rung 4: the strongest similarity above the threshold, mapped into the 0.55–0.85 band. */
function trigramMatches(
  prepared: readonly PreparedCandidate[],
  foldedInput: string,
  options: ResolveEntityOptions,
): EntityMatch[] {
  const similarity = options.similarity ?? pgTrigramSimilarity;
  const threshold = options.trigramThreshold ?? TRIGRAM_SIMILARITY_THRESHOLD;

  const matches: EntityMatch[] = [];
  for (const { entity, keys } of prepared) {
    const best = bestTrigramKey(keys, foldedInput, similarity, threshold);
    if (best === null) continue;
    matches.push({
      entity,
      rung: 'TRIGRAM',
      confidence: trigramConfidence(best.score),
      matchedOn: best.key.value,
      matchedField: best.key.field,
      similarity: best.score,
    });
  }
  return matches;
}

/** The longest, then lexicographically first, key satisfying `predicate` — a deterministic choice. */
function bestKey(keys: readonly MatchKey[], predicate: (key: MatchKey) => boolean): MatchKey | null {
  let best: MatchKey | null = null;
  for (const key of keys) {
    if (!predicate(key)) continue;
    if (best === null || compareKeys(key, best) < 0) best = key;
  }
  return best;
}

interface ScoredKey {
  readonly key: MatchKey;
  readonly score: number;
}

function bestTrigramKey(
  keys: readonly MatchKey[],
  foldedInput: string,
  similarity: TrigramSimilarity,
  threshold: number,
): ScoredKey | null {
  let best: ScoredKey | null = null;
  for (const key of keys) {
    const score = similarity(foldedInput, key.folded);
    if (!Number.isFinite(score) || score <= threshold) continue;
    const improves =
      best === null || score > best.score || (score === best.score && compareKeys(key, best.key) < 0);
    if (improves) best = { key, score };
  }
  return best;
}

/**
 * Total order on match keys: longer folded text first (the more specific alias), then folded text
 * ascending, then `NAME` before `ALIAS`. Independent of the alias array's load order, so the choice
 * of `matchedOn` is reproducible.
 */
function compareKeys(left: MatchKey, right: MatchKey): number {
  if (left.folded.length !== right.folded.length) return right.folded.length - left.folded.length;
  if (left.folded !== right.folded) return left.folded < right.folded ? -1 : 1;
  if (left.field !== right.field) return left.field === 'NAME' ? -1 : 1;
  return 0;
}

/**
 * Order the rung's matches and build the result.
 *
 * **Tie-break**, applied in order: confidence descending; then the matched name/alias's raw length
 * descending (a longer match is a more specific one); then `entity.id` ascending. The id step is the
 * one that matters and it is total, because ids are unique — two candidates that match equally always
 * order the same way, every run.
 */
function resolution(rung: Exclude<ResolutionRung, 'UNRESOLVED'>, matches: EntityMatch[]): EntityResolutionResult {
  const ordered = [...matches].sort(compareMatches);
  const winner = ordered[0]!;
  return {
    resolved: true,
    rung,
    entity: winner.entity,
    confidence: winner.confidence,
    matchedOn: winner.matchedOn,
    candidates: ordered,
  };
}

function compareMatches(left: EntityMatch, right: EntityMatch): number {
  if (left.confidence !== right.confidence) return right.confidence - left.confidence;
  if (left.matchedOn.length !== right.matchedOn.length) {
    return right.matchedOn.length - left.matchedOn.length;
  }
  // `id` is unique, so this is a total order with no further tie-break. `localeCompare` is safe here:
  // ids are UUIDs, whose character set collates identically in every locale.
  return left.entity.id.localeCompare(right.entity.id);
}

/** docs/04 §4 step 6. */
function unresolved(): EntityResolutionResult {
  return {
    resolved: false,
    rung: 'UNRESOLVED',
    entity: null,
    confidence: null,
    matchedOn: null,
    candidates: [],
  };
}
