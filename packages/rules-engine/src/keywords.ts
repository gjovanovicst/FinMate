/**
 * Keyword scoring — docs/04-categorization-and-ai-engine.md §5.4 (the implicit priority-1000 tier).
 *
 * ## The formula, verbatim
 *
 * ```text
 * score = Σ (matchedKeyword.weight × matchModeWeight × polaritySign)
 *         ÷ (1 + 0.15 × (matchedTokens - 1))          // penalise over-broad matches
 * ```
 *
 * - `polarity INCLUDE` adds, `EXCLUDE` subtracts **and hard-blocks that category**, so a category
 *   with an `EXCLUDE` hit can never win a keyword decision no matter how high the rest of its score.
 * - `matchModeWeight`: `WORD` 1.0, `PREFIX` 0.8, `SUBSTRING` 0.5.
 * - The decision gate: top ≥ **2.0** *and* leading the runner-up by ≥ **1.0**.
 *
 * ## Definitions docs/04 leaves open (derived, documented, tested)
 *
 * - **`matchedTokens`** is the number of **distinct content tokens** matched by that category's
 *   keywords, counting both polarities and counting a token once even when several keywords hit it.
 *   That is what makes the divisor a measure of how *broad* the match was rather than of how many
 *   keywords exist.
 * - **Matching runs on the folded token list.** `WORD` is a contiguous token sequence (so a
 *   multi-word keyword such as `pražnjenje jame` works); `PREFIX` is the same sequence with the
 *   **last** token matched as a prefix, which is where Serbian inflection lands
 *   (`jame` / `jami` / `jamu`); `SUBSTRING` is the folded keyword anywhere in the folded text and
 *   deliberately contributes a single matched token. Only the first occurrence of a keyword counts.
 * - **The runner-up** is the highest-scoring **eligible** (non-blocked) category other than the
 *   winner. When there is none, the runner-up score is treated as `0`, so an unopposed score ≥ 2.0
 *   decides. A blocked category is not a competitor.
 *
 * ## The confidence mapping (the second derived formula)
 *
 * docs/04 §5.4 says only "confidence mapped to 0.90–0.97". {@link keywordConfidence} maps the margin
 * linearly from the 1.0 decision floor to a 4.0 saturation point, then clamps:
 *
 * ```text
 * progress = clamp((margin − 1.0) / (4.0 − 1.0), 0, 1)
 * confidence = 0.90 + 0.07 × progress
 * ```
 *
 * Why: the margin is the only quantity §5.4 names as the gate, so it is the only honest input. A
 * margin of exactly the floor is the weakest decision the gate permits (`0.90`, still the auto-apply
 * threshold of ADR-009) and the mapping saturates at `0.97`, keeping the whole band inside the stated
 * range and monotone in the margin.
 *
 * @module @finmate/rules-engine
 */

import { RuleDocumentError } from './errors';

import type {
  CategoryKeyword,
  EvaluationContext,
  KeywordCandidate,
  KeywordDecision,
  KeywordMatch,
  KeywordMatchMode,
  KeywordPolarity,
  KeywordScoreResult,
  TextFolderOptions,
} from './types';

/** docs/04 §5.4 `matchModeWeight`. */
export const MATCH_MODE_WEIGHT: Readonly<Record<KeywordMatchMode, number>> = Object.freeze({
  WORD: 1.0,
  PREFIX: 0.8,
  SUBSTRING: 0.5,
});

/** docs/04 §5.4 over-broad penalty per matched token beyond the first. */
export const OVERBROAD_PENALTY_PER_TOKEN = 0.15;

/** docs/04 §5.4 decision gate. */
export const KEYWORD_DECISION_MIN_SCORE = 2.0;
export const KEYWORD_DECISION_MIN_MARGIN = 1.0;

/** The stated confidence band (docs/04 §5.4). */
export const KEYWORD_CONFIDENCE_MIN = 0.9;
export const KEYWORD_CONFIDENCE_MAX = 0.97;

/** The margin at which the mapping reaches {@link KEYWORD_CONFIDENCE_MAX}. Derived; see the header. */
export const KEYWORD_CONFIDENCE_SATURATION_MARGIN = 4.0;

const MATCH_MODES: ReadonlySet<string> = new Set(['WORD', 'PREFIX', 'SUBSTRING']);
const POLARITIES: ReadonlySet<string> = new Set(['INCLUDE', 'EXCLUDE']);

/**
 * Map a decision margin into `[0.90, 0.97]`, monotone increasing and saturating at a margin of
 * {@link KEYWORD_CONFIDENCE_SATURATION_MARGIN}. Never returns outside the band, even for a margin
 * below the floor (used only defensively).
 */
export function keywordConfidence(margin: number): number {
  const span = KEYWORD_CONFIDENCE_SATURATION_MARGIN - KEYWORD_DECISION_MIN_MARGIN;
  const progress = (margin - KEYWORD_DECISION_MIN_MARGIN) / span;
  const clamped = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  return KEYWORD_CONFIDENCE_MIN + (KEYWORD_CONFIDENCE_MAX - KEYWORD_CONFIDENCE_MIN) * clamped;
}

/**
 * Validate the keyword rows. Structurally invalid data is refused loudly, the same way a rule
 * document is: it means the caller's mapping from `category_keywords` is wrong.
 */
export function validateKeywords(keywords: readonly CategoryKeyword[]): void {
  keywords.forEach((keyword, index) => {
    const path = `keywords[${index}]`;
    if (typeof keyword.id !== 'string' || keyword.id.length === 0) {
      throw new RuleDocumentError('INVALID_VALUE', 'keyword id must be a non-empty string', `${path}.id`);
    }
    if (typeof keyword.categoryId !== 'string' || keyword.categoryId.length === 0) {
      throw new RuleDocumentError(
        'INVALID_VALUE',
        'categoryId must be a non-empty string',
        `${path}.categoryId`,
      );
    }
    if (typeof keyword.keyword !== 'string' || keyword.keyword.length === 0) {
      throw new RuleDocumentError('INVALID_VALUE', 'keyword must be a non-empty string', `${path}.keyword`);
    }
    if (!POLARITIES.has(keyword.polarity)) {
      throw new RuleDocumentError(
        'INVALID_VALUE',
        `polarity must be INCLUDE or EXCLUDE, got ${JSON.stringify(keyword.polarity)}`,
        `${path}.polarity`,
      );
    }
    if (!MATCH_MODES.has(keyword.matchMode)) {
      throw new RuleDocumentError(
        'INVALID_VALUE',
        `matchMode must be WORD, PREFIX or SUBSTRING, got ${JSON.stringify(keyword.matchMode)}`,
        `${path}.matchMode`,
      );
    }
    if (typeof keyword.weight !== 'number' || !Number.isFinite(keyword.weight) || keyword.weight < 0) {
      throw new RuleDocumentError(
        'INVALID_VALUE',
        `weight must be a finite non-negative number (numeric(4,2)), got ${JSON.stringify(keyword.weight)}`,
        `${path}.weight`,
      );
    }
  });
}

/** Score candidate categories — the whole of docs/04 §5.4. Pure; writes nothing and mutates nothing. */
export function scoreKeywords(
  keywords: readonly CategoryKeyword[],
  context: EvaluationContext,
  options: TextFolderOptions,
): KeywordScoreResult {
  validateKeywords(keywords);

  const folder = options.folder;
  // One text, deliberately: joining `text` and `description` would double every token and inflate
  // `matchedTokens`, making the over-broad penalty depend on how the caller split the input.
  const source = context.text ?? context.description ?? '';
  const folded = folder.fold(source);
  const tokens = folder.tokens(source);

  const byCategory = new Map<string, KeywordMatch[]>();
  for (const keyword of keywords) {
    const tokenIndices = matchKeyword(keyword, folded, tokens, folder);
    if (tokenIndices === null) continue;

    const polaritySign = keyword.polarity === 'INCLUDE' ? 1 : -1;
    const match: KeywordMatch = {
      keywordId: keyword.id,
      categoryId: keyword.categoryId,
      keyword: keyword.keyword,
      polarity: keyword.polarity,
      matchMode: keyword.matchMode,
      weight: keyword.weight,
      contribution: keyword.weight * MATCH_MODE_WEIGHT[keyword.matchMode] * polaritySign,
      tokenIndices,
    };
    const existing = byCategory.get(keyword.categoryId);
    if (existing === undefined) byCategory.set(keyword.categoryId, [match]);
    else existing.push(match);
  }

  const candidates: KeywordCandidate[] = [];
  for (const [categoryId, matches] of byCategory) {
    const matchedTokenIndices = new Set<number>();
    let numerator = 0;
    for (const match of matches) {
      numerator += match.contribution;
      for (const index of match.tokenIndices) matchedTokenIndices.add(index);
    }
    const matchedTokens = matchedTokenIndices.size;
    const denominator = 1 + OVERBROAD_PENALTY_PER_TOKEN * Math.max(0, matchedTokens - 1);
    candidates.push({
      categoryId,
      score: numerator / denominator,
      matchedTokens,
      blocked: matches.some((match) => match.polarity === 'EXCLUDE'),
      matches,
    });
  }

  // Total order: score DESC, then categoryId ASC, so equal scores are deterministic.
  candidates.sort((a, b) => b.score - a.score || compareStrings(a.categoryId, b.categoryId));

  const eligible = candidates.filter((candidate) => !candidate.blocked);
  let decision: KeywordDecision | null = null;
  const top = eligible[0];
  if (top !== undefined && top.score >= KEYWORD_DECISION_MIN_SCORE) {
    const runnerUp = eligible[1];
    const runnerUpScore = runnerUp === undefined ? null : runnerUp.score;
    const margin = top.score - (runnerUpScore ?? 0);
    if (margin >= KEYWORD_DECISION_MIN_MARGIN) {
      decision = {
        categoryId: top.categoryId,
        score: top.score,
        runnerUpScore,
        margin,
        confidence: keywordConfidence(margin),
        matches: top.matches,
      };
    }
  }

  return {
    candidates,
    blocked: candidates.filter((candidate) => candidate.blocked).map((candidate) => candidate.categoryId),
    matches: candidates.flatMap((candidate) => candidate.matches),
    decision,
  };
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * The token indices a keyword covers in this text, or `null` when it does not match.
 *
 * Only the first occurrence counts: repeated occurrences of the same keyword are the same evidence
 * and counting them again would turn a long description into an over-broad penalty by accident.
 */
function matchKeyword(
  keyword: CategoryKeyword,
  foldedText: string,
  tokens: readonly string[],
  folder: TextFolderOptions['folder'],
): readonly number[] | null {
  const keywordTokens = folder.tokens(keyword.keyword);
  if (keywordTokens.length === 0) return null;

  if (keyword.matchMode === 'WORD') return findSequence(tokens, keywordTokens, 'exact');
  if (keyword.matchMode === 'PREFIX') return findSequence(tokens, keywordTokens, 'last-prefix');

  const start = foldedText.indexOf(folder.fold(keyword.keyword));
  if (start < 0) return null;
  return [tokenIndexAt(foldedText, tokens, start)];
}

function findSequence(
  tokens: readonly string[],
  keywordTokens: readonly string[],
  mode: 'exact' | 'last-prefix',
): readonly number[] | null {
  const length = keywordTokens.length;
  for (let start = 0; start + length <= tokens.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < length; offset += 1) {
      const token = tokens[start + offset] as string;
      const needle = keywordTokens[offset] as string;
      const isLast = offset === length - 1;
      const ok = mode === 'exact' || !isLast ? token === needle : token.startsWith(needle);
      if (!ok) {
        matched = false;
        break;
      }
    }
    if (matched) {
      const indices: number[] = [];
      for (let offset = 0; offset < length; offset += 1) indices.push(start + offset);
      return indices;
    }
  }
  return null;
}

/** Which token contains character `position` of the folded text. */
function tokenIndexAt(foldedText: string, tokens: readonly string[], position: number): number {
  let offset = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    const found = foldedText.indexOf(token, offset);
    if (found < 0) continue;
    if (position < found + token.length) return index;
    offset = found + token.length;
  }
  return Math.max(0, tokens.length - 1);
}

/** Narrowing helper used by callers that read `match_mode` from Prisma as `string`. */
export function isKeywordMatchMode(value: string): value is KeywordMatchMode {
  return MATCH_MODES.has(value);
}

/** Narrowing helper used by callers that read `polarity` from Prisma as `string`. */
export function isKeywordPolarity(value: string): value is KeywordPolarity {
  return POLARITIES.has(value);
}
