/**
 * A **Rule** document, rendered as the confirmation card's rows (B-5, docs/06 §8.16).
 *
 * ## Why this exists at all
 *
 * The other five actions preview a *slot*: a name, an amount, a Category. `CREATE_RULE_FROM_CORRECTION`
 * previews a **document** — `{ all: [ { field, op, value } ] }` plus a `RuleActions` object — and the card
 * has to say what that document means before a human confirms it. A confirmation nobody can read is not
 * a confirmation (ADR-035 decision 1).
 *
 * ## It renders the document that will be **saved**, not the inputs it was derived from
 *
 * `synthesiseRule` is a pure function of the correction subject, so the same rows could be built from the
 * subject's fields instead. That would be a second copy of the trigger→condition mapping, and the first
 * one to change would make the card describe a rule nobody is writing. The document is the source of
 * truth; an id it names that {@link RulePreviewNames} cannot resolve makes that **half** fall back to
 * `asStored` (the JSON, verbatim) rather than printing a uuid at a reader.
 *
 * ## Deliberately narrow, and honest about it
 *
 * It understands what synthesis can produce — a flat `all` of text / Merchant / Counterparty leaves, and
 * the four `set*` actions — and nothing else. A composite it cannot flatten (`any`, `none`, nesting,
 * which only a hand-written rule has), an amount or calendar predicate, a `regex`, an `addTagIds` it has
 * no names for: all of those render as stored. That is the same choice `/rules` makes on the client
 * (`readabilityOf` → `RAW`), and it is why no reader can be shown a guess about their own rule.
 *
 * @module apps/api/src/modules/assistant
 */

/** The entity names a clause's ids resolve to, keyed by id. A missing id falls back to `asStored`. */
export interface RulePreviewNames {
  readonly category: Readonly<Record<string, string>>;
  readonly merchant: Readonly<Record<string, string>>;
  readonly counterparty: Readonly<Record<string, string>>;
}

/** The words this renderer needs, in the Household's language. */
export interface RulePreviewCopy {
  readonly field: {
    readonly text: string;
    readonly description: string;
    readonly merchant: string;
    readonly counterparty: string;
    readonly category: string;
  };
  readonly op: {
    readonly contains: string;
    readonly notContains: string;
    readonly equals: string;
    readonly startsWith: string;
  };
  /** Shown when a clause cannot be rendered: the document, verbatim. */
  readonly asStored: string;
  /** An explicit `null` in a `set*` action means the rule **clears** that field (docs/04 §5.3.3). */
  readonly cleared: string;
}

/** One row of the card's diff, before it becomes an `ActionDiffEntry`. */
export interface RulePreviewRow {
  readonly slot: 'conditions' | 'actions';
  readonly field: string;
  readonly after: string;
  /** The machine value, when the row names an entity — the id the rule will store. */
  readonly afterValue: string | null;
}

const TEXT_FIELDS = new Set(['text', 'description']);
const ENTITY_FIELDS = new Set(['merchant', 'counterparty']);
const OPS: Readonly<Record<string, keyof RulePreviewCopy['op']>> = Object.freeze({
  contains: 'contains',
  not_contains: 'notContains',
  equals: 'equals',
  starts_with: 'startsWith',
});

/**
 * The rows for a rule's conditions and actions — or `[]` for a document with nothing to say.
 *
 * Order matters and is the document's own: conditions first (what the rule matches), then actions (what
 * it does), because that is the order a rule is read in on `/rules` too.
 */
export function rulePreviewRows(
  rule: { readonly conditions: unknown; readonly actions: unknown },
  names: RulePreviewNames,
  copy: RulePreviewCopy,
): readonly RulePreviewRow[] {
  return [...conditionRows(rule.conditions, names, copy), ...actionRows(rule.actions, names, copy)];
}

function conditionRows(
  conditions: unknown,
  names: RulePreviewNames,
  copy: RulePreviewCopy,
): readonly RulePreviewRow[] {
  const leaves = flatLeaves(conditions);
  if (leaves === null || leaves.length === 0) {
    return [storedRow('conditions', conditions, copy)];
  }
  const rows: RulePreviewRow[] = [];
  for (const leaf of leaves) {
    const row = leafRow(leaf, names, copy);
    // One unreadable leaf makes the **whole half** as-stored: a card that showed three clauses and hid a
    // fourth would describe a narrower rule than the one it is about to write.
    if (row === null) return [storedRow('conditions', conditions, copy)];
    rows.push(row);
  }
  return rows;
}

/**
 * A flat `{ all: [leaf, …] }` — or `null` for anything else.
 *
 * `all` is the default connective and the only one synthesis emits, and a flat conjunction is the only
 * shape whose meaning survives one-row-per-leaf. `any`/`none`/nesting would each need their own grouping
 * syntax, and inventing one here is how the card starts paraphrasing a rule instead of stating it.
 */
function flatLeaves(conditions: unknown): readonly Record<string, unknown>[] | null {
  if (!isRecord(conditions)) return null;
  const keys = Object.keys(conditions);
  if (keys.length !== 1 || keys[0] !== 'all') return null;
  const children = conditions['all'];
  if (!Array.isArray(children) || children.length === 0) return null;
  return children.every(isRecord) ? (children as readonly Record<string, unknown>[]) : null;
}

function leafRow(
  leaf: Record<string, unknown>,
  names: RulePreviewNames,
  copy: RulePreviewCopy,
): RulePreviewRow | null {
  const field = leaf['field'];
  const op = leaf['op'];
  const value = leaf['value'];
  if (typeof field !== 'string' || typeof op !== 'string') return null;

  if (TEXT_FIELDS.has(field)) {
    const opWord = OPS[op];
    if (opWord === undefined || typeof value !== 'string') return null;
    return {
      slot: 'conditions',
      field: field === 'text' ? copy.field.text : copy.field.description,
      // Quoted, because the value is a word to look *for*: `opis sadrži „lidl”` cannot be misread as a
      // description of the entry.
      after: `${copy.op[opWord]} „${value}”`,
      afterValue: value,
    };
  }

  if (ENTITY_FIELDS.has(field)) {
    if (op !== 'eq' || typeof value !== 'string') return null;
    const resolved = (field === 'merchant' ? names.merchant : names.counterparty)[value];
    if (resolved === undefined) return null;
    return {
      slot: 'conditions',
      field: field === 'merchant' ? copy.field.merchant : copy.field.counterparty,
      after: `${copy.op.equals} ${resolved}`,
      afterValue: value,
    };
  }

  return null;
}

/** The `set*` actions, as one row each. `null` means "clear it" (docs/04 §5.3.3), which is a real value. */
function actionRows(
  actions: unknown,
  names: RulePreviewNames,
  copy: RulePreviewCopy,
): readonly RulePreviewRow[] {
  if (!isRecord(actions)) return [storedRow('actions', actions, copy)];
  const entries = Object.entries(actions).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return [];

  const rows: RulePreviewRow[] = [];
  for (const [key, value] of entries) {
    const row = actionRow(key, value, names, copy);
    if (row === null) return [storedRow('actions', actions, copy)];
    rows.push(row);
  }
  return rows;
}

function actionRow(
  key: string,
  value: unknown,
  names: RulePreviewNames,
  copy: RulePreviewCopy,
): RulePreviewRow | null {
  switch (key) {
    case 'setCategoryId': {
      if (value === null) return cleared('category', copy);
      if (typeof value !== 'string') return null;
      const name = names.category[value];
      return name === undefined
        ? null
        : { slot: 'actions', field: copy.field.category, after: name, afterValue: value };
    }
    case 'setMerchantId':
    case 'setCounterpartyId': {
      const field = key === 'setMerchantId' ? 'merchant' : 'counterparty';
      if (value === null) return cleared(field, copy);
      if (typeof value !== 'string') return null;
      const name = (field === 'merchant' ? names.merchant : names.counterparty)[value];
      return name === undefined
        ? null
        : {
            slot: 'actions',
            field: field === 'merchant' ? copy.field.merchant : copy.field.counterparty,
            after: name,
            afterValue: value,
          };
    }
    // Free text: the rule *writes* this string, so there is nothing to resolve.
    case 'setDescription':
      return typeof value === 'string'
        ? { slot: 'actions', field: copy.field.description, after: `„${value}”`, afterValue: null }
        : value === null
          ? cleared('description', copy)
          : null;
    // `addTagIds` would need a fourth name map for a key synthesis never sets. As stored, so the row is
    // never a guess.
    default:
      return null;
  }
}

/** An explicit `null` in a `set*` action means the rule **clears** the field — not that it is absent. */
function cleared(
  field: 'category' | 'merchant' | 'counterparty' | 'description',
  copy: RulePreviewCopy,
): RulePreviewRow {
  return { slot: 'actions', field: copy.field[field], after: copy.cleared, afterValue: null };
}

function storedRow(
  slot: 'conditions' | 'actions',
  document: unknown,
  copy: RulePreviewCopy,
): RulePreviewRow {
  return { slot, field: copy.asStored, after: safeJson(document), afterValue: null };
}

function safeJson(document: unknown): string {
  try {
    return JSON.stringify(document) ?? String(document);
  } catch {
    // A cycle cannot come out of JSONB, but a renderer must never throw on the path to a confirmation.
    return String(document);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
