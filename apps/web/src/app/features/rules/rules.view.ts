/**
 * Rendering a rule's JSONB document as something a person can read.
 *
 * `rules.conditions` is `{ all|any|none: [ { field, op, value } ] }` (docs/03 §4) and `rules.actions`
 * is `{ setCategoryId, setMerchantId, … }` — machine shapes full of UUIDs. A rules screen that shows
 * the raw JSON is technically honest and practically useless: nobody can tell whether
 * `{"field":"merchant","op":"eq","value":"0192…"}` is the rule they meant.
 *
 * **Pure, and it returns structure rather than prose.** The operator words ("is", "contains") are UI
 * copy and have to be localised, so this module resolves the *names* and reports which field and
 * operator each clause uses, leaving the wording to the component. That also keeps the AST walking —
 * the part that can silently drop a clause, which is how a screen starts lying about what a rule does
 * — testable without a DOM.
 *
 * ## Nesting is reported as "cannot render", not flattened
 *
 * Conditions nest up to depth 3 (docs/04 §5.2). A single-level tree is presented as one group;
 * anything deeper returns `null` and the caller shows the raw document. Rendering a nested tree as a
 * flat list would misrepresent it — "all of: A, B, any of: C" is not "A and B and C" — and a screen
 * that misstates a rule is worse than one that admits it cannot draw it.
 *
 * @module apps/web/src/app/features/rules
 */

/** One leaf: a field, an operator and a display value. */
export interface RuleClause {
  /** `merchant`, `counterparty`, `account`, `text`, `description`, `amount`, `kind`, `source`, … */
  readonly field: string;
  readonly op: string;
  /** The resolved display value, or the raw value when no name is known for it. */
  readonly value: string;
  /** `true` when the value could not be resolved to a name (an id with no matching row). */
  readonly unresolved: boolean;
}

/** One level of the condition tree. */
export interface RuleClauseGroup {
  /** docs/04 §5.2: `all` = AND, `any` = OR, `none` = NOR. */
  readonly quantifier: 'all' | 'any' | 'none';
  readonly clauses: readonly RuleClause[];
}

/** Resolves an identifier or a literal to something a person recognises. */
export type ResolveValue = (
  field: string,
  value: string,
) => { readonly label: string; readonly known: boolean };

const QUANTIFIERS = ['all', 'any', 'none'] as const;

/**
 * The condition fields whose value is an **identifier** to look up.
 *
 * Everything else — `text`, `description`, `amount`, `kind`, `source`, `dayOfWeek` — carries a
 * **literal** the user typed or picked, and asking the resolver about it would mark `EXPENSE` and
 * `septička` as "unresolved", which is noise that trains the user to ignore the marker. Only these
 * three can be names on a screen.
 */
const ID_FIELDS = new Set(['merchant', 'counterparty', 'account']);
const ACTION_ID_FIELDS = new Set(['categoryId', 'merchantId', 'counterpartyId']);

/**
 * The condition tree as one readable group, or `null` when it cannot be drawn without lying.
 *
 * A bare leaf (`{field, op, value}` with no quantifier) is treated as `all` of one, which is how the
 * engine reads it. An `in`/`between` list becomes **one clause per member** rather than a joined
 * string, so each member can be resolved to a name individually.
 */
export function clausesOf(conditions: unknown, resolve: ResolveValue): RuleClauseGroup | null {
  if (conditions === null || typeof conditions !== 'object' || Array.isArray(conditions)) return null;
  const record = conditions as Record<string, unknown>;

  const present = QUANTIFIERS.filter((key) => key in record);
  // `all` and `any` in one object is not a shape the engine defines; refusing to guess is the point.
  if (present.length > 1) return null;

  const quantifier = present[0] ?? 'all';
  const nodes = present.length === 0 ? [record] : record[quantifier];
  if (!Array.isArray(nodes) || nodes.length === 0) return null;

  const clauses: RuleClause[] = [];
  for (const node of nodes) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return null;
    const leaf = node as Record<string, unknown>;

    const field = leaf['field'];
    const op = leaf['op'];
    if (typeof field !== 'string' || typeof op !== 'string') return null;

    if (!('value' in leaf)) {
      // `is_null` legitimately carries no value; anything else without one is not renderable.
      if (op !== 'is_null') return null;
      clauses.push({ field, op, value: '', unresolved: false });
      continue;
    }

    const raw = leaf['value'];
    if (Array.isArray(raw)) {
      if (raw.length === 0) return null;
      for (const entry of raw) {
        const clause = fromScalar(field, op, entry, resolve);
        if (clause === null) return null;
        clauses.push(clause);
      }
      continue;
    }

    const clause = fromScalar(field, op, raw, resolve);
    if (clause === null) return null;
    clauses.push(clause);
  }

  return clauses.length === 0 ? null : { quantifier, clauses };
}

/** A single scalar leaf value, resolved when it is a string (an id or a literal). */
function fromScalar(
  field: string,
  op: string,
  value: unknown,
  resolve: ResolveValue,
): RuleClause | null {
  if (typeof value === 'string') {
    const lookup = ID_FIELDS.has(field);
    const resolved = lookup ? resolve(field, value) : { label: value, known: true };
    return { field, op, value: resolved.label, unresolved: !resolved.known };
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { field, op, value: String(value), unresolved: false };
  }
  // A nested object or `null` inside a list is not a shape this renders.
  return null;
}

/** What a rule sets, resolved to names. */
export interface RuleActionSummary {
  readonly setCategory: { readonly label: string; readonly known: boolean } | null;
  /** An explicit `null`: the rule clears the category. Distinct from "untouched" (docs/04 §5.1). */
  readonly clearsCategory: boolean;
  readonly setMerchant: { readonly label: string; readonly known: boolean } | null;
  readonly setCounterparty: { readonly label: string; readonly known: boolean } | null;
  readonly setDescription: string | null;
  readonly addTags: readonly string[];
}

/**
 * The action set as display values.
 *
 * Absent and `null` are different facts (docs/04 §5.1) and the summary keeps them apart: `null` means
 * "clear it" and an absent key means "leave it alone", so collapsing them would describe a rule that
 * erases a category as one that does nothing to it. `addTags` are returned as ids because the rules
 * screen does not load the Tag list — rendering them unresolved is honest; inventing labels is not.
 */
export function actionsOf(actions: unknown, resolve: ResolveValue): RuleActionSummary {
  const record =
    actions !== null && typeof actions === 'object' && !Array.isArray(actions)
      ? (actions as Record<string, unknown>)
      : {};

  const categoryId = record['setCategoryId'];
  const merchantId = record['setMerchantId'];
  const counterpartyId = record['setCounterpartyId'];

  return {
    setCategory: typeof categoryId === 'string' ? resolveAction('categoryId', categoryId, resolve) : null,
    clearsCategory: 'setCategoryId' in record && categoryId === null,
    setMerchant: typeof merchantId === 'string' ? resolveAction('merchantId', merchantId, resolve) : null,
    setCounterparty:
      typeof counterpartyId === 'string'
        ? resolveAction('counterpartyId', counterpartyId, resolve)
        : null,
    setDescription:
      typeof record['setDescription'] === 'string' ? String(record['setDescription']) : null,
    addTags: Array.isArray(record['addTagIds'])
      ? record['addTagIds'].filter((tag): tag is string => typeof tag === 'string')
      : [],
  };
}

/** An action's target id → a name, when the field is one of the three that can have a name. */
function resolveAction(
  field: string,
  value: string,
  resolve: ResolveValue,
): { readonly label: string; readonly known: boolean } {
  return ACTION_ID_FIELDS.has(field) ? resolve(field, value) : { label: value, known: true };
}

/** Whether a rule's document can be drawn, or must be shown raw. */
export type RuleReadability = 'READABLE' | 'RAW';

/**
 * Stated as one function so the template and the tests agree about when the fallback applies — the
 * alternative is an `@if` in the template that drifts from what the renderer actually handles.
 */
export function readabilityOf(conditions: unknown, resolve: ResolveValue): RuleReadability {
  return clausesOf(conditions, resolve) === null ? 'RAW' : 'READABLE';
}

/** The rules screen's three groupings, so the template does not re-derive them. */
export interface RuleBuckets<T> {
  readonly needsAttention: readonly T[];
  readonly active: readonly T[];
  readonly inactive: readonly T[];
}

/**
 * Group rules the way a person triages them.
 *
 * **Needs attention first**: something is wrong with it that a hit count cannot show — it is shadowed
 * by another rule, so it will never fire (docs/04 §8.2), or it has not fired in 90 days and is a
 * candidate for pruning. Those are the two states that make a rule set rot, and burying them under
 * the healthy ones is how a screen becomes decorative.
 */
export function bucketRules<T extends { readonly isActive: boolean; readonly isStale: boolean; readonly conflictsWith: readonly unknown[] }>(
  rules: readonly T[],
): RuleBuckets<T> {
  const needsAttention: T[] = [];
  const active: T[] = [];
  const inactive: T[] = [];

  for (const rule of rules) {
    if (rule.conflictsWith.length > 0 || (rule.isActive && rule.isStale)) needsAttention.push(rule);
    else if (rule.isActive) active.push(rule);
    else inactive.push(rule);
  }

  return { needsAttention, active, inactive };
}
