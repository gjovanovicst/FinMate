/**
 * Deterministic rule evaluation and keyword scoring.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §5
 *
 * Pure, no I/O, no AI. Rules run BEFORE the model (ADR-002) and are the reason ~70 % of
 * entries cost nothing and resolve in milliseconds. The model is the exception path.
 *
 * Implemented in Phase 2 task 2.1.3.
 *
 * ## Surface
 *
 * - {@link evaluateRules} — the whole of §5.3: condition evaluation, priority, conflict resolution
 *   and the implicit keyword tier.
 * - {@link scoreKeywords} — the whole of §5.4.
 * - The rule / condition / action / context / result types in `./types`.
 *
 * ## The injected fold
 *
 * The eslint boundary (`scope:rules`) forbids importing `@finmate/nlp`, and copying its fold would
 * drift — so the caller supplies a {@link TextFolder} and the engine folds **both** sides itself.
 * The option is required, so a caller cannot forget it.
 *
 * ## Money
 *
 * `amount` conditions compare `bigint` minor units end to end and never touch `Number` (ADR-003).
 * A `number` amount — in a rule value or in the context — is refused rather than coerced.
 *
 * ## Purity
 *
 * Nothing is written, no clock is read (`dayOfWeek` / `dayOfMonth` arrive in the context) and no
 * input is mutated. `rules.hit_count` / `rules.last_hit_at` are the caller's to bump;
 * {@link RuleDecision.matchedRuleIds} says which rules matched.
 */
export * from './types';
export * from './errors';

export {
  MAX_CONDITION_DEPTH,
  REGEX_MAX_INPUT_LENGTH,
  REGEX_MAX_PATTERN_LENGTH,
  conditionDepth,
  contextTextFor,
  evaluateConditionTree,
  hasNestedQuantifier,
  toBigIntStrict,
  validateConditionTree,
} from './conditions';

export { specificityOf } from './specificity';

export {
  KEYWORD_CONFIDENCE_MAX,
  KEYWORD_CONFIDENCE_MIN,
  KEYWORD_CONFIDENCE_SATURATION_MARGIN,
  KEYWORD_DECISION_MIN_MARGIN,
  KEYWORD_DECISION_MIN_SCORE,
  MATCH_MODE_WEIGHT,
  OVERBROAD_PENALTY_PER_TOKEN,
  isKeywordMatchMode,
  isKeywordPolarity,
  keywordConfidence,
  scoreKeywords,
  validateKeywords,
} from './keywords';

export { KEYWORD_TIER_PRIORITY, evaluateRules, validateRule } from './evaluate';
