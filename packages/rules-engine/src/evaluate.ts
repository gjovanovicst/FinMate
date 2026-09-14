/**
 * Conflict resolution — docs/04-categorization-and-ai-engine.md §5.3, in its stated order:
 *
 * 1. Sort by `priority ASC`, then `created_at DESC` (newest user intent wins ties).
 * 2. Collect all matching rules with `stop_on_match = true` → the first is the decision.
 * 3. If only non-stopping rules match, merge their actions in priority order (later rules fill gaps,
 *    they do not overwrite explicitly set fields).
 * 4. Category keywords are an implicit rules tier at **priority 1000**, so explicit user rules
 *    outrank keywords.
 * 5. A specificity score breaks remaining ties; losers are recorded for debuggability.
 *
 * Two consequences of §5.3 that the result makes explicit:
 *
 * - **A merge mixes tiers**, so the tier that produced the *category* is reported separately from the
 *   contributing rules: `decidedBy` names the category's source (`RULE` / `KEYWORD` / `NONE`), and
 *   `contributingRuleIds` names every rule whose actions were applied. A rule that set only the
 *   Merchant while a keyword set the Category is `decidedBy: 'KEYWORD'` **and** contributes a rule.
 * - **Nothing is written and no clock is read.** `matchedRuleIds` is what the caller bumps
 *   `hit_count` / `last_hit_at` for; `createdAt`, `dayOfWeek` and `dayOfMonth` all arrive in the
 *   inputs, so an evaluation is replayable.
 *
 * ## Ordering
 *
 * The sort key is `(priority ASC, specificity DESC, created_at DESC, id ASC)`. Specificity sits
 * between priority and `created_at` because §5.3.5's tie-break must be able to make an **explicit
 * rule beat a keyword at priority 1000** (the implicit tier has specificity 0), and `created_at` is
 * not a property of explicit-vs-implicit — ordering on it would let a keyword decide by insertion
 * time, which §5.3.4 forbids. `created_at DESC` remains the tie-break for otherwise-identical rules,
 * and `id ASC` is the final one so array order can never change the outcome.
 *
 * @module @finmate/rules-engine
 */

import { evaluateConditionTree, validateConditionTree } from './conditions';
import { RuleDocumentError } from './errors';
import { scoreKeywords } from './keywords';
import { specificityOf } from './specificity';

import type {
  DecidedBy,
  EvaluationContext,
  KeywordCandidateRef,
  KeywordScoreResult,
  MergedActions,
  Rule,
  RuleActions,
  RuleCandidate,
  RuleDecision,
  RuleEngineOptions,
  RuleFlag,
} from './types';

/** docs/04 §5.3.4: the priority the implicit keyword tier is compiled at. */
export const KEYWORD_TIER_PRIORITY = 1000;

interface MutableActions {
  setCategoryId?: string | null;
  setMerchantId?: string | null;
  setCounterpartyId?: string | null;
  setDescription?: string | null;
  addTagIds?: string[];
}

interface EvaluatedRule {
  readonly rule: Rule;
  readonly specificity: number;
  readonly flags: readonly RuleFlag[];
}

interface TierEntry {
  readonly kind: 'RULE' | 'KEYWORD';
  readonly priority: number;
  readonly specificity: number;
  readonly createdAtMs: number;
  readonly sortKey: string;
  readonly evaluated: EvaluatedRule | null;
  readonly categoryId: string | null;
}

/**
 * Validate a rule document. Throws {@link RuleDocumentError}.
 *
 * Exported so the API can refuse a bad rule **on write**, which keeps a throw at evaluation time
 * what it should be: a signal that something bypassed validation.
 */
export function validateRule(rule: Rule): void {
  if (typeof rule.id !== 'string' || rule.id.length === 0) {
    throw new RuleDocumentError('INVALID_VALUE', 'rule id must be a non-empty string', 'id', null);
  }
  if (typeof rule.priority !== 'number' || !Number.isFinite(rule.priority)) {
    throw new RuleDocumentError(
      'INVALID_VALUE',
      `priority must be a finite number, got ${JSON.stringify(rule.priority)}`,
      'priority',
      rule.id,
    );
  }
  if (typeof rule.createdAt !== 'string' || !Number.isFinite(Date.parse(rule.createdAt))) {
    throw new RuleDocumentError(
      'INVALID_DATE',
      `createdAt must be a parseable ISO-8601 instant, got ${JSON.stringify(rule.createdAt)}`,
      'createdAt',
      rule.id,
    );
  }
  validateActions(rule.actions, rule.id);
  validateConditionTree(rule.conditions, rule.id);
}

function validateActions(actions: RuleActions, ruleId: string): void {
  const scalars: readonly (keyof RuleActions)[] = [
    'setCategoryId',
    'setMerchantId',
    'setCounterpartyId',
    'setDescription',
  ];
  for (const key of scalars) {
    const value = actions[key];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw new RuleDocumentError(
        'INVALID_VALUE',
        `${key} must be a string or null, got ${JSON.stringify(value)}`,
        `actions.${key}`,
        ruleId,
      );
    }
  }
  if (
    actions.addTagIds !== undefined &&
    (!Array.isArray(actions.addTagIds) || actions.addTagIds.some((tagId) => typeof tagId !== 'string'))
  ) {
    throw new RuleDocumentError(
      'INVALID_VALUE',
      'addTagIds must be an array of strings',
      'actions.addTagIds',
      ruleId,
    );
  }
}

/**
 * Evaluate the rule set against one transaction context — the whole of docs/04 §5.3.
 *
 * Pure: it does not mutate `rules`, `context` or `options.keywords`, and it reads no clock. Every
 * rule (including an inactive one) is validated first, so a document that is too deep is refused
 * with a {@link RuleDocumentError} rather than partially evaluated — a rule cannot be quarantined by
 * deactivating it and then surprise the pipeline when it is switched back on.
 */
export function evaluateRules(
  rules: readonly Rule[],
  context: EvaluationContext,
  options: RuleEngineOptions,
): RuleDecision {
  for (const rule of rules) validateRule(rule);

  const matched: EvaluatedRule[] = [];
  const flags: RuleFlag[] = [];
  for (const rule of rules) {
    if (rule.isActive === false) continue;
    const outcome = evaluateConditionTree(rule.conditions, context, options, rule.id);
    for (const flag of outcome.flags) flags.push(flag);
    if (outcome.matched) {
      matched.push({ rule, specificity: specificityOf(rule.conditions), flags: outcome.flags });
    }
  }
  matched.sort(compareEvaluated);

  const matchedRuleIds = matched.map((entry) => entry.rule.id);
  const keyword =
    options.keywords === undefined ? null : scoreKeywords(options.keywords, context, options);
  const keywordDecision = keyword?.decision ?? null;

  // §5.3.2 — the first matching stop rule is the decision; nothing else is merged.
  const stopWinner = matched.find((entry) => entry.rule.stopOnMatch);
  if (stopWinner !== undefined) {
    const actions = cloneActions(stopWinner.rule.actions);
    const decidedBy: DecidedBy = actions.setCategoryId !== undefined ? 'RULE' : 'NONE';
    return {
      decidedBy,
      ruleId: decidedBy === 'RULE' ? stopWinner.rule.id : null,
      decidingRule: decidedBy === 'RULE' ? toDecidingRule(stopWinner) : null,
      actions,
      contributingRuleIds: [stopWinner.rule.id],
      matchedRuleIds,
      keyword,
      keywordShadowed: keywordDecision !== null,
      candidates: [
        ...matched.filter((entry) => entry.rule.id !== stopWinner.rule.id).map(toCandidate),
        // The keyword tier was never consulted, so every scored category is a loser.
        ...keywordLosers(keyword, null),
      ],
      confidence: decidedBy === 'RULE' ? 1 : null,
      flags,
    };
  }

  // §5.3.3/§5.3.4 — merge non-stopping rules, with the keyword decision as the priority-1000 tier.
  const entries: TierEntry[] = matched.map((entry) => ({
    kind: 'RULE',
    priority: entry.rule.priority,
    specificity: entry.specificity,
    createdAtMs: Date.parse(entry.rule.createdAt),
    sortKey: entry.rule.id,
    evaluated: entry,
    categoryId: null,
  }));
  if (keywordDecision !== null) {
    entries.push({
      kind: 'KEYWORD',
      priority: KEYWORD_TIER_PRIORITY,
      // The implicit tier is the least specific candidate there is (docs/04 §5.3.5).
      specificity: 0,
      createdAtMs: Number.NEGATIVE_INFINITY,
      sortKey: '\uffff',
      evaluated: null,
      categoryId: keywordDecision.categoryId,
    });
  }
  entries.sort(compareEntries);

  const actions: MutableActions = {};
  const contributingRuleIds: string[] = [];
  let categoryFrom: 'RULE' | 'KEYWORD' | null = null;
  let categoryRuleId: string | null = null;

  for (const entry of entries) {
    const categoryWasUnset = actions.setCategoryId === undefined;
    if (entry.kind === 'RULE' && entry.evaluated !== null) {
      const applied = fillActions(actions, entry.evaluated.rule.actions);
      if (applied) contributingRuleIds.push(entry.evaluated.rule.id);
      if (categoryWasUnset && actions.setCategoryId !== undefined) {
        categoryFrom = 'RULE';
        categoryRuleId = entry.evaluated.rule.id;
      }
    } else if (entry.categoryId !== null) {
      if (fillActions(actions, { setCategoryId: entry.categoryId })) {
        if (categoryWasUnset) categoryFrom = 'KEYWORD';
      }
    }
  }

  const decidedBy: DecidedBy = categoryFrom ?? 'NONE';
  const contributing = new Set(contributingRuleIds);
  const decidingEntry =
    categoryRuleId === null ? undefined : matched.find((entry) => entry.rule.id === categoryRuleId);
  const appliedKeywordCategoryId =
    categoryFrom === 'KEYWORD' ? (keywordDecision?.categoryId ?? null) : null;

  return {
    decidedBy,
    ruleId: categoryFrom === 'RULE' ? categoryRuleId : null,
    decidingRule: decidingEntry === undefined ? null : toDecidingRule(decidingEntry),
    actions,
    contributingRuleIds,
    matchedRuleIds,
    keyword,
    keywordShadowed: keywordDecision !== null && categoryFrom !== 'KEYWORD',
    candidates: [
      ...matched.filter((entry) => !contributing.has(entry.rule.id)).map(toCandidate),
      ...keywordLosers(keyword, appliedKeywordCategoryId),
    ],
    confidence:
      decidedBy === 'RULE'
        ? 1
        : decidedBy === 'KEYWORD'
          ? (keywordDecision?.confidence ?? null)
          : null,
    flags,
  };
}

function compareEvaluated(a: EvaluatedRule, b: EvaluatedRule): number {
  if (a.rule.priority !== b.rule.priority) return a.rule.priority - b.rule.priority;
  if (a.specificity !== b.specificity) return b.specificity - a.specificity;
  const aCreated = Date.parse(a.rule.createdAt);
  const bCreated = Date.parse(b.rule.createdAt);
  if (aCreated !== bCreated) return bCreated - aCreated;
  if (a.rule.id < b.rule.id) return -1;
  if (a.rule.id > b.rule.id) return 1;
  return 0;
}

function compareEntries(a: TierEntry, b: TierEntry): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.specificity !== b.specificity) return b.specificity - a.specificity;
  if (a.createdAtMs !== b.createdAtMs) return b.createdAtMs - a.createdAtMs;
  if (a.sortKey < b.sortKey) return -1;
  if (a.sortKey > b.sortKey) return 1;
  return 0;
}

function cloneActions(actions: RuleActions): MergedActions {
  const clone: MutableActions = {};
  if (actions.setCategoryId !== undefined) clone.setCategoryId = actions.setCategoryId;
  if (actions.setMerchantId !== undefined) clone.setMerchantId = actions.setMerchantId;
  if (actions.setCounterpartyId !== undefined) clone.setCounterpartyId = actions.setCounterpartyId;
  if (actions.setDescription !== undefined) clone.setDescription = actions.setDescription;
  if (actions.addTagIds !== undefined) clone.addTagIds = [...actions.addTagIds];
  return clone;
}

/**
 * Fill every action the target has not already set. An explicit `null` counts as set, so a
 * higher-priority rule that clears a field cannot be un-cleared by a later one (docs/04 §5.3.3).
 * Returns whether this source contributed at least one field.
 */
function fillActions(target: MutableActions, source: RuleActions): boolean {
  let applied = false;
  if (target.setCategoryId === undefined && source.setCategoryId !== undefined) {
    target.setCategoryId = source.setCategoryId;
    applied = true;
  }
  if (target.setMerchantId === undefined && source.setMerchantId !== undefined) {
    target.setMerchantId = source.setMerchantId;
    applied = true;
  }
  if (target.setCounterpartyId === undefined && source.setCounterpartyId !== undefined) {
    target.setCounterpartyId = source.setCounterpartyId;
    applied = true;
  }
  if (target.setDescription === undefined && source.setDescription !== undefined) {
    target.setDescription = source.setDescription;
    applied = true;
  }
  if (source.addTagIds !== undefined) {
    const tags = target.addTagIds ?? [];
    for (const tagId of source.addTagIds) {
      if (!tags.includes(tagId)) {
        tags.push(tagId);
        applied = true;
      }
    }
    target.addTagIds = tags;
  }
  return applied;
}

function toCandidate(entry: EvaluatedRule): RuleCandidate {
  return {
    kind: 'RULE',
    ruleId: entry.rule.id,
    name: entry.rule.name,
    priority: entry.rule.priority,
    specificity: entry.specificity,
    createdAt: entry.rule.createdAt,
    stopOnMatch: entry.rule.stopOnMatch,
    origin: entry.rule.origin,
    flags: entry.flags,
  };
}

/**
 * The keyword tier's scored categories as losing candidates, excluding the one that applied (if it
 * did) so the list contains only what did not decide (docs/04 §5.3.5).
 */
function keywordLosers(
  keyword: KeywordScoreResult | null,
  appliedCategoryId: string | null,
): readonly KeywordCandidateRef[] {
  if (keyword === null) return [];
  return keyword.candidates
    .filter((candidate) => candidate.categoryId !== appliedCategoryId)
    .map((candidate) => ({
      kind: 'KEYWORD',
      categoryId: candidate.categoryId,
      score: candidate.score,
      matchedTokens: candidate.matchedTokens,
      blocked: candidate.blocked,
    }));
}

function toDecidingRule(entry: EvaluatedRule): RuleDecision['decidingRule'] {
  return {
    id: entry.rule.id,
    name: entry.rule.name,
    origin: entry.rule.origin,
    priority: entry.rule.priority,
    specificity: entry.specificity,
    stopOnMatch: entry.rule.stopOnMatch,
  };
}
