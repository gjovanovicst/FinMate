/**
 * Typed errors for the rules engine.
 *
 * Two different failure classes, deliberately separated:
 *
 * - {@link RuleDocumentError} — the **document** is invalid (too deep, unknown field, an operator
 *   that field does not support, a float in the money path). This is a programming or data-integrity
 *   bug, so it is refused loudly rather than evaluated (docs/04 §5.2: nesting depth ≤ 3).
 * - {@link RuleEvaluationError} — the **context** violates a non-negotiable, e.g. a `number` amount
 *   where a `bigint` is required (ADR-003).
 *
 * A `regex` condition is neither: it is structurally valid but refused *per rule* with a flag, so one
 * bad rule cannot break a whole evaluation (docs/04 §5.2).
 *
 * @module @finmate/rules-engine
 */

export type RuleDocumentErrorCode =
  /** Condition tree deeper than the docs/04 §5.2 cap. */
  | 'DEPTH_EXCEEDED'
  /** A composite with no children, or more than one of `all` / `any` / `none`. */
  | 'MALFORMED_COMPOSITE'
  /** A node that is neither a known composite nor a known leaf. */
  | 'MALFORMED_CONDITION'
  /** `field` is not one of the docs/04 §5.2 fields. */
  | 'UNKNOWN_FIELD'
  /** `op` is not supported by that field. */
  | 'UNSUPPORTED_OPERATOR'
  /** The value does not fit the operator (arity, type, empty needle). */
  | 'INVALID_VALUE'
  /** A `number` reached an `amount` value: a float in the money path (ADR-003). */
  | 'AMOUNT_IS_FLOAT'
  /** An `amount` string that is not a non-negative integer. */
  | 'INVALID_AMOUNT'
  /** `createdAt` is not a parseable ISO-8601 instant. */
  | 'INVALID_DATE';

/** The rule document is invalid and was not evaluated. */
export class RuleDocumentError extends Error {
  readonly code: RuleDocumentErrorCode;
  /** Dotted path into the offending rule, e.g. `conditions.all[1].value`. */
  readonly path: string;
  /** Which rule, when the validation ran per rule. */
  readonly ruleId: string | null;

  constructor(code: RuleDocumentErrorCode, message: string, path: string, ruleId: string | null = null) {
    super(`[${code}] ${message} (at ${path}${ruleId === null ? '' : ` in rule ${ruleId}`})`);
    this.name = 'RuleDocumentError';
    this.code = code;
    this.path = path;
    this.ruleId = ruleId;
  }
}

export type RuleEvaluationErrorCode =
  /** `amountMinor` was a `number`. There is no conversion (ADR-003). */
  | 'AMOUNT_NOT_BIGINT'
  /** `dayOfWeek` / `dayOfMonth` was not a finite integer. */
  | 'INVALID_ORDINAL_CONTEXT';

/** The evaluation context violates a rule the engine will not paper over. */
export class RuleEvaluationError extends Error {
  readonly code: RuleEvaluationErrorCode;

  constructor(code: RuleEvaluationErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'RuleEvaluationError';
    this.code = code;
  }
}
