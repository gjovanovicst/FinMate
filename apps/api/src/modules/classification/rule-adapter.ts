/**
 * Adapters from this module's inputs to the two pure packages' shapes.
 *
 * Two things live here, both for the same reason: **a boundary that has to be crossed in exactly one
 * place**.
 *
 * 1. **{@link PIPELINE_TEXT_FOLDER}** — `packages/rules-engine` may not import `@finmate/nlp`
 *    (AGENTS.md, `eslint.config.mjs`), so the product's single fold is *injected*. A local fold here
 *    would be the second implementation AGENTS.md forbids, so this delegates to `@finmate/nlp`
 *    verbatim.
 * 2. **{@link toPipelineRule}** — a `rules` row is JSONB written by a user, so `conditions` and
 *    `actions` are *untrusted documents*, not a typed value. The engine validates on every evaluation
 *    and throws {@link RuleDocumentError} on a bad one. A capture request must not 500 because a rule
 *    typed last month is malformed, so this maps the row and the caller skips the ones the engine
 *    refuses — loudly, because a silently dropped rule is a rule the user thinks is working.
 *
 * @module apps/api/src/modules/classification
 */

import { foldForMatching, foldTokens } from '@finmate/nlp';
import {
  validateRule,
  type CategoryKeyword,
  type Rule,
  type RuleActions,
  type RuleOrigin,
  type TextFolder,
} from '@finmate/rules-engine';

/** The product's one fold and tokenizer, injected into the rules engine. */
export const PIPELINE_TEXT_FOLDER: TextFolder = Object.freeze({
  fold: (value: string): string => foldForMatching(value),
  tokens: (value: string): readonly string[] => foldTokens(value),
});

/** The `rules` columns the **engine** needs. */
export const RULE_ENGINE_SELECT = {
  id: true,
  name: true,
  priority: true,
  is_active: true,
  stop_on_match: true,
  conditions: true,
  actions: true,
  origin: true,
  created_at: true,
} as const;

/** The `category_keywords` columns the engine's implicit priority-1000 tier needs. */
export const KEYWORD_SELECT = {
  id: true,
  category_id: true,
  keyword: true,
  polarity: true,
  match_mode: true,
  weight: true,
} as const;

/** One `category_keywords` row as selected above. */
export interface KeywordRow {
  readonly id: string;
  readonly category_id: string;
  readonly keyword: string;
  readonly polarity: string;
  readonly match_mode: string;
  readonly weight: unknown;
}

/**
 * A keyword row → the engine's shape.
 *
 * `weight` is `numeric(4,2)`, a **score and not money**, so the Decimal→`number` conversion is
 * correct here (ADR-003 governs `amount_minor`; see `CategoryKeyword.weight` in the engine's types).
 * Shared by the pipeline and by `RulesService`'s conflict check so the two cannot score keywords
 * differently — which would have made the guardrail's answer disagree with the pipeline's.
 */
export function toPipelineKeyword(row: KeywordRow): CategoryKeyword {
  return {
    id: row.id,
    categoryId: row.category_id,
    keyword: row.keyword,
    polarity: row.polarity as CategoryKeyword['polarity'],
    matchMode: row.match_mode as CategoryKeyword['matchMode'],
    weight: Number(row.weight),
  };
}

/** The `rules` row as Prisma returns it. Structurally typed so this file needs no generated import. */
export interface RuleRow {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly is_active: boolean;
  readonly stop_on_match: boolean;
  readonly conditions: unknown;
  readonly actions: unknown;
  readonly origin: string;
  readonly created_at: Date;
}

/** `rules.origin` CHECK (docs/03). An unknown value is mapped to `SYSTEM` rather than trusted. */
function toOrigin(value: string): RuleOrigin {
  return value === 'USER' || value === 'LEARNED' || value === 'IMPORT' ? value : 'SYSTEM';
}

/**
 * Map a `rules` row to the engine's {@link Rule}.
 *
 * The JSONB columns are cast **without being believed** — {@link validateRule} is the check, and the
 * caller decides what to do with a refusal. Casting rather than parsing is deliberate: the engine's
 * validator is the single definition of a well-formed rule, so a second structural check here would
 * be free to disagree with it.
 */
export function toPipelineRule(row: RuleRow): Rule {
  return {
    id: row.id,
    name: row.name,
    priority: row.priority,
    isActive: row.is_active,
    stopOnMatch: row.stop_on_match,
    conditions: row.conditions as Rule['conditions'],
    actions: row.actions as RuleActions,
    origin: toOrigin(row.origin),
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Load the Household's rules, dropping the ones the engine refuses.
 *
 * Returns the accepted rules plus the ids of the refused ones so the caller can log them. Dropping is
 * the right call for the **request path**: `captureParse` is a keystroke-debounced read, and a
 * malformed rule written months ago must not make capture unavailable. It is *not* silent — the ids
 * are returned and the service logs a warning — because a user whose rule quietly stopped applying
 * has a real bug to be told about.
 */
export function loadRules(rows: readonly RuleRow[]): {
  readonly rules: readonly Rule[];
  readonly rejected: readonly string[];
} {
  const rules: Rule[] = [];
  const rejected: string[] = [];

  for (const row of rows) {
    try {
      const rule = toPipelineRule(row);
      validateRule(rule);
      rules.push(rule);
    } catch {
      rejected.push(row.id);
    }
  }

  return { rules, rejected };
}
