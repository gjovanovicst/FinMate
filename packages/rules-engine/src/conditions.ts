/**
 * Condition evaluation — docs/04-categorization-and-ai-engine.md §5.2.
 *
 * Pure and deterministic: no I/O, no clock, no mutation. Both sides of every text comparison are
 * folded through the injected {@link TextFolder}, so a caller cannot violate a precondition.
 *
 * **Three-valued logic.** A rule that carries a `regex` condition the engine refuses to evaluate
 * (disabled, unsafe, too long, invalid) yields `UNKNOWN`, not `NO_MATCH` and not a throw. `UNKNOWN`
 * propagates: `all` with an `UNKNOWN` child cannot be `MATCH`, `none` with an `UNKNOWN` child cannot
 * be `MATCH` either. That is the safe direction — the pipeline falls through to keywords/AI instead
 * of applying a rule whose guard was never actually checked — and it is visible in
 * {@link RuleFlag}s, never silent (docs/04 §5.2).
 *
 * @module @finmate/rules-engine
 */

import { RuleDocumentError, RuleEvaluationError } from './errors';

import type {
  AmountValue,
  ConditionNode,
  ConditionOutcome,
  EvaluationContext,
  RuleEngineOptions,
  RuleFlag,
  TextConditionField,
  TextFolder,
} from './types';

/** docs/04 §5.2: "Nesting depth ≤ 3 — beyond that it is a program, not a rule". */
export const MAX_CONDITION_DEPTH = 3;

/**
 * Bounds on the `regex` operator. They are a **mitigation, not a fix**: JavaScript's regex engine is
 * synchronous and not interruptible, so a catastrophic pattern can still block the event loop. The
 * engine therefore (a) refuses `regex` unless `allowRegex` is explicitly true, (b) rejects the
 * classic nested-quantifier shape, (c) caps pattern and input length, and (d) reports every refusal
 * as a flag on the result. The complete fix — running user-authored patterns out of process with a
 * timeout — belongs to the caller that turns `allowRegex` on.
 */
export const REGEX_MAX_PATTERN_LENGTH = 200;
export const REGEX_MAX_INPUT_LENGTH = 2_000;

const COMPOSITE_KEYS = ['all', 'any', 'none'] as const;
type CompositeKey = (typeof COMPOSITE_KEYS)[number];

const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  'text',
  'description',
  'merchant',
  'counterparty',
  'account',
  'amount',
  'dayOfWeek',
  'dayOfMonth',
  'kind',
  'source',
]);

const FIELD_OPERATORS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  text: ['contains', 'not_contains', 'equals', 'starts_with', 'regex', 'in'],
  description: ['contains', 'not_contains', 'equals', 'starts_with', 'regex', 'in'],
  merchant: ['eq', 'in', 'is_null'],
  counterparty: ['eq', 'in', 'is_null'],
  account: ['eq', 'in', 'is_null'],
  amount: ['eq', 'gt', 'gte', 'lt', 'lte', 'between'],
  dayOfWeek: ['in', 'between'],
  dayOfMonth: ['in', 'between'],
  kind: ['eq'],
  source: ['eq'],
});

type UnknownRecord = Record<string, unknown>;

function asRecord(node: ConditionNode): UnknownRecord {
  return node as unknown as UnknownRecord;
}

function presentCompositeKeys(node: ConditionNode): readonly CompositeKey[] {
  if (node === null || typeof node !== 'object') return [];
  const record = asRecord(node);
  return COMPOSITE_KEYS.filter((key) => record[key] !== undefined);
}

/**
 * The nesting depth: how many composite (`all` / `any` / `none`) levels sit on the longest path.
 * A bare leaf is 0, `{all:[leaf]}` is 1, and `{all:[{any:[{none:[leaf]}]}]}` is 3.
 *
 * docs/04 §5.2 caps this at 3 but does not define the measure, so it is written down here: depth 3
 * permits three nested composites, and a fourth is refused. Counting composites rather than nodes
 * is the natural reading of "nesting depth" and is the permissive direction — a legitimate
 * `all(any(none(...)))` rule is accepted.
 */
export function conditionDepth(node: ConditionNode): number {
  const composites = presentCompositeKeys(node);
  if (composites.length !== 1) return 0;
  const key = composites[0] as CompositeKey;
  const children = asRecord(node)[key];
  if (!Array.isArray(children) || children.length === 0) return 1;
  let deepest = 0;
  for (const child of children) {
    deepest = Math.max(deepest, conditionDepth(child as ConditionNode));
  }
  return 1 + deepest;
}

/**
 * Validate a whole condition tree, refusing anything the engine will not evaluate.
 *
 * Throws {@link RuleDocumentError} for structural problems. A `regex` condition is **not** one:
 * whether it may run is an option, not a property of the document, so it is flagged at evaluation
 * time instead (docs/04 §5.2).
 */
export function validateConditionTree(node: ConditionNode, ruleId: string | null = null): void {
  const depth = conditionDepth(node);
  if (depth > MAX_CONDITION_DEPTH) {
    throw new RuleDocumentError(
      'DEPTH_EXCEEDED',
      `condition tree is ${depth} levels deep; the cap is ${MAX_CONDITION_DEPTH} (docs/04 §5.2)`,
      'conditions',
      ruleId,
    );
  }
  validateNode(node, 'conditions', ruleId);
}

function validateNode(node: ConditionNode, path: string, ruleId: string | null): void {
  if (node === null || typeof node !== 'object') {
    throw new RuleDocumentError('MALFORMED_CONDITION', 'condition must be an object', path, ruleId);
  }
  const composites = presentCompositeKeys(node);
  if (composites.length > 1) {
    throw new RuleDocumentError(
      'MALFORMED_COMPOSITE',
      `a node may carry only one of all/any/none, found ${composites.join(', ')}`,
      path,
      ruleId,
    );
  }
  if (composites.length === 1) {
    const key = composites[0] as CompositeKey;
    const children = asRecord(node)[key];
    if (!Array.isArray(children) || children.length === 0) {
      throw new RuleDocumentError(
        'MALFORMED_COMPOSITE',
        `"${key}" must be a non-empty array of conditions`,
        `${path}.${key}`,
        ruleId,
      );
    }
    children.forEach((child, index) => {
      validateNode(child as ConditionNode, `${path}.${key}[${index}]`, ruleId);
    });
    return;
  }
  validateLeaf(node, path, ruleId);
}

function validateLeaf(node: ConditionNode, path: string, ruleId: string | null): void {
  const record = asRecord(node);
  const field = record['field'];
  if (typeof field !== 'string' || !KNOWN_FIELDS.has(field)) {
    throw new RuleDocumentError(
      'UNKNOWN_FIELD',
      `unknown field ${JSON.stringify(field)}`,
      `${path}.field`,
      ruleId,
    );
  }
  const op = record['op'];
  const operators = FIELD_OPERATORS[field] ?? [];
  if (typeof op !== 'string' || !operators.includes(op)) {
    throw new RuleDocumentError(
      'UNSUPPORTED_OPERATOR',
      `field "${field}" does not support operator ${JSON.stringify(op)}; expected one of ${operators.join(', ')}`,
      `${path}.op`,
      ruleId,
    );
  }
  validateLeafValue(field, op, record['value'], `${path}.value`, ruleId);
}

function validateLeafValue(
  field: string,
  op: string,
  value: unknown,
  path: string,
  ruleId: string | null,
): void {
  if (field === 'text' || field === 'description') {
    if (op === 'in') {
      requireStringArray(value, path, ruleId);
      return;
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new RuleDocumentError(
        'INVALID_VALUE',
        `"${field} ${op}" needs a non-empty string; an empty needle would match everything`,
        path,
        ruleId,
      );
    }
    return;
  }

  if (field === 'merchant' || field === 'counterparty' || field === 'account') {
    if (op === 'is_null') {
      if (value !== undefined && value !== null) {
        throw new RuleDocumentError(
          'INVALID_VALUE',
          `"${field} is_null" takes no value (got ${JSON.stringify(value)})`,
          path,
          ruleId,
        );
      }
      return;
    }
    if (op === 'in') {
      requireStringArray(value, path, ruleId);
      return;
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new RuleDocumentError('INVALID_VALUE', `"${field} eq" needs a non-empty string`, path, ruleId);
    }
    return;
  }

  if (field === 'amount') {
    if (op === 'between') {
      if (!Array.isArray(value) || value.length !== 2) {
        throw new RuleDocumentError('INVALID_VALUE', '"amount between" needs [low, high]', path, ruleId);
      }
      for (const bound of value) toBigIntStrict(bound as AmountValue, path, ruleId);
      return;
    }
    toBigIntStrict(value as AmountValue, path, ruleId);
    return;
  }

  if (field === 'dayOfWeek' || field === 'dayOfMonth') {
    const [low, high] = field === 'dayOfWeek' ? [1, 7] : [1, 31];
    if (op === 'between') {
      if (!Array.isArray(value) || value.length !== 2) {
        throw new RuleDocumentError(
          'INVALID_VALUE',
          `"${field} between" needs [low, high]`,
          path,
          ruleId,
        );
      }
      for (const bound of value) requireIntegerInRange(bound, low as number, high as number, path, ruleId);
      return;
    }
    if (!Array.isArray(value) || value.length === 0) {
      throw new RuleDocumentError('INVALID_VALUE', `"${field} in" needs a non-empty array`, path, ruleId);
    }
    for (const entry of value) requireIntegerInRange(entry, low as number, high as number, path, ruleId);
    return;
  }

  if (field === 'kind') {
    if (value !== 'EXPENSE' && value !== 'INCOME') {
      throw new RuleDocumentError('INVALID_VALUE', '"kind eq" must be EXPENSE or INCOME', path, ruleId);
    }
    return;
  }

  // source
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuleDocumentError('INVALID_VALUE', '"source eq" needs a non-empty string', path, ruleId);
  }
}

function requireStringArray(value: unknown, path: string, ruleId: string | null): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RuleDocumentError('INVALID_VALUE', 'needs a non-empty array of strings', path, ruleId);
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new RuleDocumentError('INVALID_VALUE', 'needs a non-empty array of strings', path, ruleId);
    }
  }
}

function requireIntegerInRange(
  value: unknown,
  low: number,
  high: number,
  path: string,
  ruleId: string | null,
): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < low || value > high) {
    throw new RuleDocumentError(
      'INVALID_VALUE',
      `value must be an integer in [${low}, ${high}], got ${JSON.stringify(value)}`,
      path,
      ruleId,
    );
  }
}

/**
 * Parse a rule's `amount` value to `bigint`, **never** through `Number` (ADR-003).
 *
 * A JS `number` is refused outright rather than coerced: silently accepting it is exactly the float
 * leak the money rule exists to prevent. A decimal string is accepted because JSONB cannot carry a
 * bigint (docs/06's `Money` scalar has the same reason).
 */
export function toBigIntStrict(value: AmountValue, path = 'value', ruleId: string | null = null): bigint {
  const raw: unknown = value;
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number') {
    throw new RuleDocumentError(
      'AMOUNT_IS_FLOAT',
      'amount value is a JS number; money is bigint minor units or a decimal string (ADR-003)',
      path,
      ruleId,
    );
  }
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
    throw new RuleDocumentError(
      'INVALID_AMOUNT',
      `amount value must be a non-negative integer string, got ${JSON.stringify(raw)}`,
      path,
      ruleId,
    );
  }
  return BigInt(raw.trim());
}

const VERDICT = { MATCH: 'MATCH', NO_MATCH: 'NO_MATCH', UNKNOWN: 'UNKNOWN' } as const;
type Verdict = (typeof VERDICT)[keyof typeof VERDICT];

interface NodeOutcome {
  readonly verdict: Verdict;
  readonly flags: readonly RuleFlag[];
}

function regexFlag(code: RuleFlag['code'], field: TextConditionField, message: string): RuleFlag {
  return { ruleId: null, code, field, message };
}

/**
 * Evaluate a condition tree.
 *
 * `ruleId` is only used to stamp {@link RuleFlag}s; a direct call may omit it.
 */
export function evaluateConditionTree(
  node: ConditionNode,
  context: EvaluationContext,
  options: RuleEngineOptions,
  ruleId: string | null = null,
): ConditionOutcome {
  const outcome = evaluateNode(node, context, options);
  return {
    matched: outcome.verdict === VERDICT.MATCH,
    flags: outcome.flags.map((flag) => ({ ...flag, ruleId })),
  };
}

function evaluateNode(
  node: ConditionNode,
  context: EvaluationContext,
  options: RuleEngineOptions,
): NodeOutcome {
  const composites = presentCompositeKeys(node);
  if (composites.length !== 1) return evaluateLeaf(node, context, options);

  const key = composites[0] as CompositeKey;
  const children = asRecord(node)[key] as readonly ConditionNode[];
  const outcomes = children.map((child) => evaluateNode(child, context, options));
  const flags = outcomes.flatMap((outcome) => outcome.flags);
  const verdicts = outcomes.map((outcome) => outcome.verdict);
  const has = (verdict: Verdict): boolean => verdicts.includes(verdict);

  if (key === 'all') {
    if (has(VERDICT.NO_MATCH)) return { verdict: VERDICT.NO_MATCH, flags };
    if (has(VERDICT.UNKNOWN)) return { verdict: VERDICT.UNKNOWN, flags };
    return { verdict: VERDICT.MATCH, flags };
  }
  if (key === 'any') {
    if (has(VERDICT.MATCH)) return { verdict: VERDICT.MATCH, flags };
    if (has(VERDICT.UNKNOWN)) return { verdict: VERDICT.UNKNOWN, flags };
    return { verdict: VERDICT.NO_MATCH, flags };
  }
  // none (NOR)
  if (has(VERDICT.MATCH)) return { verdict: VERDICT.NO_MATCH, flags };
  if (has(VERDICT.UNKNOWN)) return { verdict: VERDICT.UNKNOWN, flags };
  return { verdict: VERDICT.MATCH, flags };
}

function evaluateLeaf(
  node: ConditionNode,
  context: EvaluationContext,
  options: RuleEngineOptions,
): NodeOutcome {
  const record = asRecord(node);
  const field = record['field'] as string;
  const op = record['op'] as string;
  const value = record['value'];

  switch (field) {
    case 'text':
    case 'description':
      return evaluateText(field, op, value, context, options);
    case 'merchant':
    case 'counterparty':
    case 'account':
      return evaluateEntity(field, op, value, context, options.folder);
    case 'amount':
      return evaluateAmount(op, value, context);
    case 'dayOfWeek':
    case 'dayOfMonth':
      return evaluateOrdinal(field, op, value, context);
    case 'kind':
      return verdictOutcome(context.kind !== null && context.kind !== undefined && context.kind === value);
    case 'source':
      return verdictOutcome(
        context.source !== null && context.source !== undefined && context.source === value,
      );
    default:
      // Unreachable through `evaluateRules` (which validates first). Defensive only.
      return verdictOutcome(false);
  }
}

function verdictOutcome(matched: boolean): NodeOutcome {
  return { verdict: matched ? VERDICT.MATCH : VERDICT.NO_MATCH, flags: [] };
}

/** The text a field reads: `text` prefers `text`, `description` prefers `description`. */
export function contextTextFor(field: TextConditionField, context: EvaluationContext): string {
  if (field === 'text') return context.text ?? context.description ?? '';
  return context.description ?? context.text ?? '';
}

function evaluateText(
  field: TextConditionField,
  op: string,
  value: unknown,
  context: EvaluationContext,
  options: RuleEngineOptions,
): NodeOutcome {
  const folded = options.folder.fold(contextTextFor(field, context));
  const needle = typeof value === 'string' ? options.folder.fold(value) : '';

  switch (op) {
    case 'contains':
      return verdictOutcome(folded.includes(needle));
    case 'not_contains':
      return verdictOutcome(!folded.includes(needle));
    case 'equals':
      return verdictOutcome(folded === needle);
    case 'starts_with':
      return verdictOutcome(folded.startsWith(needle));
    case 'in': {
      const list = (value as readonly string[]).map((entry) => options.folder.fold(entry));
      return verdictOutcome(list.includes(folded));
    }
    case 'regex':
      return evaluateRegex(field, value as string, folded, options);
    default:
      return verdictOutcome(false);
  }
}

function evaluateRegex(
  field: TextConditionField,
  pattern: string,
  foldedInput: string,
  options: RuleEngineOptions,
): NodeOutcome {
  if (options.allowRegex !== true) {
    return {
      verdict: VERDICT.UNKNOWN,
      flags: [
        regexFlag(
          'REGEX_DISABLED',
          field,
          'regex conditions are enterprise-only and allowRegex is not enabled; rule treated as non-matching',
        ),
      ],
    };
  }
  if (pattern.length > REGEX_MAX_PATTERN_LENGTH) {
    return {
      verdict: VERDICT.UNKNOWN,
      flags: [
        regexFlag(
          'REGEX_TOO_LONG',
          field,
          `pattern is ${pattern.length} chars; the cap is ${REGEX_MAX_PATTERN_LENGTH}`,
        ),
      ],
    };
  }
  if (hasNestedQuantifier(pattern)) {
    return {
      verdict: VERDICT.UNKNOWN,
      flags: [
        regexFlag(
          'REGEX_UNSAFE',
          field,
          'pattern contains a quantified group with an inner quantifier, the classic ReDoS shape',
        ),
      ],
    };
  }
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, 'u');
  } catch (error) {
    return {
      verdict: VERDICT.UNKNOWN,
      flags: [
        regexFlag(
          'REGEX_INVALID',
          field,
          `pattern does not compile: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    };
  }
  if (foldedInput.length > REGEX_MAX_INPUT_LENGTH) {
    return {
      verdict: VERDICT.UNKNOWN,
      flags: [
        regexFlag(
          'REGEX_INPUT_TOO_LONG',
          field,
          `input is ${foldedInput.length} chars; the cap is ${REGEX_MAX_INPUT_LENGTH}`,
        ),
      ],
    };
  }
  return verdictOutcome(expression.test(foldedInput));
}

/**
 * Conservative ReDoS heuristic: a group whose body contains a quantifier and which is itself
 * quantified — `(a+)+`, `(.*)*`, `(\d+){2,}`. It deliberately does not try to be complete; an
 * unflagged catastrophic pattern remains possible, which is why {@link REGEX_MAX_INPUT_LENGTH}
 * exists and why enabling `allowRegex` is a caller decision with a timeout story.
 */
export function hasNestedQuantifier(pattern: string): boolean {
  const stack: boolean[] = [];
  let escaped = false;
  let inCharacterClass = false;

  const isQuantifier = (character: string): boolean =>
    character === '*' || character === '+' || character === '{';

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (inCharacterClass) {
      if (character === ']') inCharacterClass = false;
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
      continue;
    }
    if (character === '(') {
      stack.push(false);
      continue;
    }
    if (character === ')') {
      const bodyHadQuantifier = stack.pop() ?? false;
      const next = index + 1 < pattern.length ? (pattern[index + 1] as string) : '';
      const groupIsQuantified = isQuantifier(next);
      if (bodyHadQuantifier && groupIsQuantified) return true;
      if (stack.length > 0 && (bodyHadQuantifier || groupIsQuantified)) {
        stack[stack.length - 1] = true;
      }
      continue;
    }
    if (isQuantifier(character) && stack.length > 0) {
      stack[stack.length - 1] = true;
    }
  }
  return false;
}

function evaluateEntity(
  field: 'merchant' | 'counterparty' | 'account',
  op: string,
  value: unknown,
  context: EvaluationContext,
  folder: TextFolder,
): NodeOutcome {
  const raw =
    field === 'merchant'
      ? context.merchantId
      : field === 'counterparty'
        ? context.counterpartyId
        : context.accountId;
  const actual = raw === undefined || raw === null ? null : raw;

  if (op === 'is_null') return verdictOutcome(actual === null);
  if (actual === null) return verdictOutcome(false);

  const folded = folder.fold(actual);
  if (op === 'in') {
    const list = value as readonly string[];
    return verdictOutcome(list.some((entry) => folder.fold(entry) === folded));
  }
  return verdictOutcome(folder.fold(value as string) === folded);
}

function evaluateAmount(op: string, value: unknown, context: EvaluationContext): NodeOutcome {
  const amount = contextAmount(context);
  if (amount === null) return verdictOutcome(false);

  if (op === 'between') {
    const bounds = (value as readonly AmountValue[]).map((bound) => toBigIntStrict(bound));
    const low = bounds[0] as bigint;
    const high = bounds[1] as bigint;
    return verdictOutcome(amount >= low && amount <= high);
  }

  const expected = toBigIntStrict(value as AmountValue);
  switch (op) {
    case 'eq':
      return verdictOutcome(amount === expected);
    case 'gt':
      return verdictOutcome(amount > expected);
    case 'gte':
      return verdictOutcome(amount >= expected);
    case 'lt':
      return verdictOutcome(amount < expected);
    case 'lte':
      return verdictOutcome(amount <= expected);
    default:
      return verdictOutcome(false);
  }
}

function contextAmount(context: EvaluationContext): bigint | null {
  const raw: unknown = context.amountMinor;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'bigint') {
    throw new RuleEvaluationError(
      'AMOUNT_NOT_BIGINT',
      `context.amountMinor must be a bigint in minor units, received ${typeof raw} (ADR-003)`,
    );
  }
  return raw;
}

function evaluateOrdinal(
  field: 'dayOfWeek' | 'dayOfMonth',
  op: string,
  value: unknown,
  context: EvaluationContext,
): NodeOutcome {
  const raw: unknown = field === 'dayOfWeek' ? context.dayOfWeek : context.dayOfMonth;
  if (raw === undefined || raw === null) return verdictOutcome(false);
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new RuleEvaluationError(
      'INVALID_ORDINAL_CONTEXT',
      `context.${field} must be a finite integer, received ${JSON.stringify(raw)}`,
    );
  }

  if (op === 'between') {
    const [low, high] = value as readonly number[];
    return verdictOutcome(raw >= (low as number) && raw <= (high as number));
  }
  return verdictOutcome((value as readonly number[]).includes(raw));
}
