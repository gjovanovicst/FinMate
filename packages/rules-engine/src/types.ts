/**
 * The rule surface: conditions, actions, contexts and results.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §5, docs/03-domain-model.md (`rules`,
 * `category_keywords`).
 *
 * Nothing here imports `@finmate/nlp`. The fold is injected as {@link TextFolder} because the
 * boundary rule (eslint.config.mjs, `scope:rules`) forbids the edge and a second fold would drift
 * — see docs/04 §3.1 and AGENTS.md.
 *
 * @module @finmate/rules-engine
 */

import type { MinorUnits } from '@finmate/domain';

/**
 * The fold + tokenizer the caller supplies from `@finmate/nlp` (`foldForMatching` / `foldTokens`).
 *
 * This package needs **no** dependency on `@finmate/nlp` and holds **no** copy of it: the single
 * product fold stays single (AGENTS.md, docs/04 §3.1).
 */
export interface TextFolder {
  /** Fold a whole string for comparison (Cyrillic → Latin, case, diacritics, whitespace). */
  fold(value: string): string;
  /** Fold and split into content tokens. */
  tokens(value: string): readonly string[];
}

/** Options every entry point needs: the injected fold. It is deliberately **required**. */
export interface TextFolderOptions {
  readonly folder: TextFolder;
}

/** Category keywords, evaluated as the implicit priority-1000 tier (docs/04 §5.3.4, §5.4). */
export interface CategoryKeyword {
  readonly id: string;
  readonly categoryId: string;
  /** Folded or raw — the engine folds it again through the injected folder. */
  readonly keyword: string;
  readonly polarity: KeywordPolarity;
  readonly matchMode: KeywordMatchMode;
  /**
   * `category_keywords.weight`, `numeric(4,2)`.
   *
   * **This is a score, not money, so a Decimal→`number` conversion at the boundary is correct
   * here** — the ADR-003 bigint rule governs `amount_minor`, not weights. The value is still
   * validated finite and non-negative before use.
   */
  readonly weight: number;
}

/** `category_keywords.polarity`. */
export type KeywordPolarity = 'INCLUDE' | 'EXCLUDE';

/** `category_keywords.match_mode`. */
export type KeywordMatchMode = 'WORD' | 'PREFIX' | 'SUBSTRING';

/**
 * Engine options. `folder` is required; everything else is opt-in.
 */
export interface RuleEngineOptions extends TextFolderOptions {
  /**
   * Enables the `regex` operator (docs/04 §5.2: enterprise-only). **Default false**, so a rule that
   * carries a `regex` condition is reported as non-matching **and flagged**, never evaluated
   * silently and never thrown over (docs/04 §5.2; see {@link RuleFlag}).
   */
  readonly allowRegex?: boolean;
  /**
   * Category keywords to run as the implicit priority-1000 tier (docs/04 §5.3.4). Omit for an
   * explicit-rules-only evaluation; `decidedBy` can then never be `KEYWORD`.
   */
  readonly keywords?: readonly CategoryKeyword[];
}

// ---------------------------------------------------------------- conditions

/** `rules.origin` CHECK (docs/03). */
export type RuleOrigin = 'USER' | 'LEARNED' | 'SYSTEM' | 'IMPORT';

/** `transactions.kind`. Direction is never a sign on the amount (ADR-003). */
export type RuleKind = 'EXPENSE' | 'INCOME';

/** A minor-unit amount, as `bigint` or as a decimal string (JSONB carries no bigint). */
export type AmountValue = MinorUnits | string;

/** Text fields for `contains`, `not_contains`, `equals`, `starts_with`, `regex`, `in`. */
export type TextConditionField = 'text' | 'description';

/** Identifier fields for `eq`, `in`, `is_null`. */
export type EntityConditionField = 'merchant' | 'counterparty' | 'account';

/** Day-of-week / day-of-month fields for `in`, `between`. */
export type OrdinalConditionField = 'dayOfWeek' | 'dayOfMonth';

/** Enum fields for `eq`. */
export type EnumConditionField = 'kind' | 'source';

export type ConditionField =
  | TextConditionField
  | EntityConditionField
  | 'amount'
  | OrdinalConditionField
  | EnumConditionField;

export type TextOperator =
  | 'contains'
  | 'not_contains'
  | 'equals'
  | 'starts_with'
  | 'regex'
  | 'in';

export type EntityOperator = 'eq' | 'in' | 'is_null';
export type AmountOperator = 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'between';
export type OrdinalOperator = 'in' | 'between';

/**
 * A text predicate. Both sides are folded by the engine through {@link TextFolder}: a rule value
 * `Septička` matches text `septicka`, and a Cyrillic value matches Latin text.
 *
 * `in` is **whole-value membership** (the folded text equals one of the folded values), not token
 * membership — token membership is what `contains` is for.
 */
export interface TextCondition {
  readonly field: TextConditionField;
  readonly op: TextOperator;
  readonly value: string | readonly string[];
}

/**
 * An identifier predicate (`merchant` / `counterparty` / `account`). Values are ids in practice
 * (docs/04 §5.1), but comparison runs through the fold so a caller that passes a name instead is
 * still served and never has to pre-normalise.
 */
export interface EntityCondition {
  readonly field: EntityConditionField;
  readonly op: EntityOperator;
  /** Omit or `null` for `is_null`; a single id (or a list for `in`) otherwise. */
  readonly value?: string | readonly string[] | null;
}

/**
 * A money predicate, compared in **`bigint` minor units end to end** (ADR-003).
 *
 * `eq`, `gt`, `gte`, `lt`, `lte`, `between` never pass through `Number`: a float would make
 * `amount eq` fail past `Number.MAX_SAFE_INTEGER` and `between` include the wrong rows — silently,
 * and about money. `value` is a `bigint` or a decimal **string** (JSONB has no bigint); a JS
 * `number` is refused with {@link RuleDocumentError} rather than coerced. Amounts are non-negative;
 * direction comes from `kind` (ADR-003). `between` is `[low, high]`, inclusive.
 */
export interface AmountCondition {
  readonly field: 'amount';
  readonly op: AmountOperator;
  readonly value: AmountValue | readonly AmountValue[];
}

/**
 * A calendar predicate. The values arrive **in the context**, never from `Date.now()`: a rule that
 * read the clock could not be replayed and its answer would depend on when it ran.
 *
 * `dayOfWeek` is ISO-8601 (`1` = Monday … `7` = Sunday); `dayOfMonth` is `1`–`31`. `between` is
 * inclusive.
 */
export interface OrdinalCondition {
  readonly field: OrdinalConditionField;
  readonly op: OrdinalOperator;
  readonly value: number | readonly number[];
}

export interface KindCondition {
  readonly field: 'kind';
  readonly op: 'eq';
  readonly value: RuleKind;
}

export interface SourceCondition {
  readonly field: 'source';
  readonly op: 'eq';
  readonly value: string;
}

export type Condition =
  | TextCondition
  | EntityCondition
  | AmountCondition
  | OrdinalCondition
  | KindCondition
  | SourceCondition;

/** `all` = AND, `any` = OR, `none` = NOR (docs/04 §5.2). */
export interface AllCondition {
  readonly all: readonly ConditionNode[];
}

export interface AnyCondition {
  readonly any: readonly ConditionNode[];
}

export interface NoneCondition {
  readonly none: readonly ConditionNode[];
}

export type CompositeCondition = AllCondition | AnyCondition | NoneCondition;

/**
 * One node of the condition tree.
 *
 * Depth is capped at 3 (docs/04 §5.2), measured as the number of nested `all` / `any` / `none`
 * levels: a bare leaf is 0, `all(leaf)` is 1 and `all(any(none(leaf)))` is 3 and allowed. A fourth
 * composite is refused with a `RuleDocumentError`.
 */
export type ConditionNode = Condition | CompositeCondition;

/** The `rules.conditions` JSONB document. */
export type ConditionTree = ConditionNode;

// ------------------------------------------------------------------- actions

/**
 * `rules.actions` (docs/04 §5.1 and the docs/03 DDL comment).
 *
 * An **absent** field means "untouched"; an **explicit `null`** means "clear it" and, once set,
 * cannot be overwritten by a later, lower-priority rule (docs/04 §5.3.3).
 *
 * `setKind` and `setAccountId` are deliberately absent: neither §5.1 nor the DDL defines them, and
 * `updateTransaction` cannot change `kind` anyway.
 */
export interface RuleActions {
  readonly setCategoryId?: string | null;
  readonly setMerchantId?: string | null;
  readonly setCounterpartyId?: string | null;
  readonly setDescription?: string | null;
  readonly addTagIds?: readonly string[];
}

/** The action set after conflict resolution. Same shape as {@link RuleActions}; see it for `null`. */
export type MergedActions = RuleActions;

// ---------------------------------------------------------------------- rule

/** One row of `rules`, mapped to the docs/04 §5.1 shape. */
export interface Rule {
  readonly id: string;
  readonly name: string;
  /** Lower wins (docs/04 §5.3.1). */
  readonly priority: number;
  /** `is_active`. An inactive rule is validated but never evaluated. */
  readonly isActive: boolean;
  /** docs/04 §5.3.2: the first matching stop rule is the decision. */
  readonly stopOnMatch: boolean;
  readonly conditions: ConditionTree;
  readonly actions: RuleActions;
  readonly origin: RuleOrigin;
  /**
   * `created_at`, ISO-8601. **Only** a tie-break (docs/04 §5.3.1) — the engine never reads a clock,
   * and `hit_count` / `last_hit_at` are the caller's to write, not this package's.
   */
  readonly createdAt: string;
}

// ------------------------------------------------------------------- context

/**
 * Everything a rule may test, resolved by the caller.
 *
 * All of it is caller-supplied and none of it is I/O: `dayOfWeek` / `dayOfMonth` are computed from
 * the Transaction's **local** calendar date by the calling layer, so an evaluation is replayable
 * (unlike `Date.now()`).
 */
export interface EvaluationContext {
  /** Free text to match `text` conditions against; the primary source for keyword scoring too. */
  readonly text?: string;
  /** A distinct description, when the caller keeps one. Falls back to {@link text}. */
  readonly description?: string;
  readonly merchantId?: string | null;
  readonly counterpartyId?: string | null;
  readonly accountId?: string | null;
  /**
   * **`bigint` minor units.** A JS `number` here is a float in the money path (ADR-003) and is
   * refused with a {@link RuleEvaluationError}; there is no conversion.
   */
  readonly amountMinor?: MinorUnits | null;
  readonly kind?: RuleKind | null;
  readonly source?: string | null;
  /** ISO-8601 weekday, `1` = Monday … `7` = Sunday. */
  readonly dayOfWeek?: number | null;
  /** `1`–`31`, from the local calendar date. */
  readonly dayOfMonth?: number | null;
}

// --------------------------------------------------------------------- flags

/** Why a `regex` condition was not evaluated (docs/04 §5.2 — enterprise-only, and a ReDoS vector). */
export type RegexFlagCode =
  | 'REGEX_DISABLED'
  | 'REGEX_INVALID'
  | 'REGEX_UNSAFE'
  | 'REGEX_TOO_LONG'
  | 'REGEX_INPUT_TOO_LONG';

/**
 * A per-rule, non-fatal refusal. It is **visible in the result**, never silent, and it never throws:
 * one bad rule must not break a whole evaluation (docs/04 §5.2). `ruleId` is stamped by
 * {@link evaluateRules}; a direct {@link evaluateConditionTree} call leaves it `null`.
 */
export interface RuleFlag {
  readonly ruleId: string | null;
  readonly code: RegexFlagCode;
  readonly field: TextConditionField;
  readonly message: string;
}

/** Result of evaluating a whole condition tree. */
export interface ConditionOutcome {
  readonly matched: boolean;
  readonly flags: readonly RuleFlag[];
}

// -------------------------------------------------------------------- result

/** One matched rule that did **not** contribute actions — a losing candidate (docs/04 §5.3.5). */
export interface RuleCandidate {
  readonly kind: 'RULE';
  readonly ruleId: string;
  readonly name: string;
  readonly priority: number;
  readonly specificity: number;
  readonly createdAt: string;
  readonly stopOnMatch: boolean;
  readonly origin: RuleOrigin;
  readonly flags: readonly RuleFlag[];
}

/** A scored category that did **not** decide — a losing candidate from the implicit tier. */
export interface KeywordCandidateRef {
  readonly kind: 'KEYWORD';
  readonly categoryId: string;
  readonly score: number;
  readonly matchedTokens: number;
  readonly blocked: boolean;
}

/**
 * Every candidate that was considered and did not decide (docs/04 §5.3.5): the non-contributing
 * rules in evaluation order, then the keyword tier's categories in score order.
 */
export type Candidate = RuleCandidate | KeywordCandidateRef;

/** The rule that decided the category, when one did. */
export interface DecidingRule {
  readonly id: string;
  readonly name: string;
  readonly origin: RuleOrigin;
  readonly priority: number;
  readonly specificity: number;
  readonly stopOnMatch: boolean;
}

/** Every category the keyword tier scored, whether or not it won (docs/04 §5.4). */
export interface KeywordCandidate {
  readonly categoryId: string;
  readonly score: number;
  /** Distinct text tokens this category's keywords matched — the over-broad denominator. */
  readonly matchedTokens: number;
  /** True when an `EXCLUDE` keyword matched: this category can never be decided by keywords. */
  readonly blocked: boolean;
  readonly matches: readonly KeywordMatch[];
}

/** One keyword hit inside one category. */
export interface KeywordMatch {
  readonly keywordId: string;
  readonly categoryId: string;
  readonly keyword: string;
  readonly polarity: KeywordPolarity;
  readonly matchMode: KeywordMatchMode;
  readonly weight: number;
  /** `weight × matchModeWeight × polaritySign` — the term added to the numerator. */
  readonly contribution: number;
  /** Indices into the folded token list that this hit covered. */
  readonly tokenIndices: readonly number[];
}

/** A keyword decision that cleared both gates (docs/04 §5.4). */
export interface KeywordDecision {
  readonly categoryId: string;
  readonly score: number;
  /** Highest-scoring *eligible* competitor, or `null` when the winner ran unopposed. */
  readonly runnerUpScore: number | null;
  /** `score - (runnerUpScore ?? 0)`. */
  readonly margin: number;
  /** Mapped into `[0.90, 0.97]` and monotone in the margin. See {@link keywordConfidence}. */
  readonly confidence: number;
  readonly matches: readonly KeywordMatch[];
}

/** The whole of docs/04 §5.4. */
export interface KeywordScoreResult {
  /** Every category with at least one hit, `score DESC` then `categoryId ASC`. */
  readonly candidates: readonly KeywordCandidate[];
  /** Category ids hard-blocked by an `EXCLUDE` hit, in candidate order. */
  readonly blocked: readonly string[];
  /** Every hit, in candidate order. */
  readonly matches: readonly KeywordMatch[];
  /** `null` means "fall through to AI with these candidates attached" (docs/04 §5.4). */
  readonly decision: KeywordDecision | null;
}

/** Who produced the category decision (the `classification_decisions.decided_by` subset §5 owns). */
export type DecidedBy = 'RULE' | 'KEYWORD' | 'NONE';

/** The whole of docs/04 §5.3, ready for a `classification_decisions` row. */
export interface RuleDecision {
  readonly decidedBy: DecidedBy;
  /** The deciding rule's id, or `null` for a `KEYWORD` / `NONE` decision. */
  readonly ruleId: string | null;
  /** The deciding rule's full detail (debug convenience; `ruleId` is the FK). */
  readonly decidingRule: DecidingRule | null;
  /** Actions after conflict resolution: absent = untouched, explicit `null` = cleared. */
  readonly actions: MergedActions;
  /** Rule ids whose actions were merged in, in the order they contributed. */
  readonly contributingRuleIds: readonly string[];
  /**
   * Every rule whose conditions matched, in evaluation order. The caller bumps `hit_count` /
   * `last_hit_at` for these — writing is I/O and belongs outside this package.
   */
  readonly matchedRuleIds: readonly string[];
  /** The keyword tier's full result, or `null` when no keywords were supplied. */
  readonly keyword: KeywordScoreResult | null;
  /** True when the keyword gates passed but an explicit rule had already set the category. */
  readonly keywordShadowed: boolean;
  /**
   * Losing candidates in order (docs/04 §5.3.5): the matched rules that contributed nothing, in
   * evaluation order, then the keyword tier's scored categories, in score order.
   */
  readonly candidates: readonly Candidate[];
  /** `1` for a rule decision (deterministic), the mapped keyword confidence, or `null` for NONE. */
  readonly confidence: number | null;
  /** Every non-fatal refusal seen while evaluating, so a skipped regex is never silent. */
  readonly flags: readonly RuleFlag[];
}
