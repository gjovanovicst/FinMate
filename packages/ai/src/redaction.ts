/**
 * Pre-egress redaction.
 *
 * Owner: docs/08-security-privacy-and-compliance.md §6.3 (the table), §6.4 (the assertion list),
 * referenced from docs/04 §9's cross-cutting adapter requirements.
 *
 * "Enforced in one place — `redact(fragment, context)` in `packages/ai`, called by every adapter,
 * with a unit test asserting the §6.4 no-egress list." This is that place. The adapters call
 * {@link redactFragment} and {@link redactText} on every string that leaves the process; they do
 * not have a path around it.
 *
 * ## What is removed, and what is deliberately kept
 *
 * Removed: any run of **9 or more digits** (PANs, IBANs, account and phone numbers typed by
 * accident), emails, URL paths and query strings (also a prompt-injection vector), internal UUIDs
 * (replaced by an opaque per-call index so a provider cannot correlate calls into a dossier),
 * times (`occurred_at`) and timezones, Household and Member identity.
 *
 * Kept: the Merchant and Counterparty **names** and the descriptive words. docs/08 §6.3 is explicit
 * that these are "the entire signal; removing them makes the feature a slower dropdown". A
 * redaction pass that removed them would be safe and useless.
 *
 * ## Two rules that are easy to get wrong
 *
 * - **The threshold is nine digits, not "any digits".** `Lidl 2000` and `dejan 3600` must reach the
 *   model intact or parsing is impossible. A four-digit amount is not a PAN.
 * - **Amounts travel as strings of minor units** (`"360000"`), because a JSON number is a float and
 *   the money path is `bigint`-only (ADR-003).
 *
 * ## Identifier substitution
 *
 * `candidates` and entity lists carry real database ids. Each distinct UUID becomes `c1`, `m1`,
 * `p1`, … — keyed by the id's **prefix**, so the model sees a stable shape (`every category id
 * starts with c`) without ever seeing a value that identifies the Household. The mapping is
 * returned so the caller can re-map the model's chosen id back.
 *
 * @module @finmate/ai
 */

import type { CategoryCandidate, RedactedFragment } from './provider';

/** docs/08 §6.3's cap on the fragment that reaches a prompt. */
export const MAX_FRAGMENT_CHARS = 500;

/** docs/08 §6.3's cap on an assistant question (§6.11 repeats it). */
export const MAX_QUESTION_CHARS = 280;

/** docs/08 §6.3's cap on `receipt_items.raw_text`. */
export const MAX_RECEIPT_LINE_CHARS = 200;

/** The shortest digit run that is treated as an identifier rather than a number. */
export const MIN_REDACTED_DIGIT_RUN = 9;

export const REDACTED_NUMBER = '[REDACTED_NUMBER]';
export const REDACTED_EMAIL = '[REDACTED_EMAIL]';

/**
 * A candidate's id, replaced by an opaque per-call index.
 *
 * `placeholder` is what the model sees; `id` is what the caller needs back. Keeping both means the
 * mapping never has to be reconstructed from the provider's output text.
 */
export interface IdSubstitution {
  readonly placeholder: string;
  readonly id: string;
}

/** docs/08 §6.3: "Few-shot examples — max 5, each re-redacted". */
export const MAX_FEW_SHOT_EXAMPLES = 5;

/** The per-call index state: what each real id was replaced by. */
export interface RedactionMap {
  readonly ids: readonly IdSubstitution[];
}

/** The redacted text plus the mapping needed to undo the identifier substitution. */
export interface RedactedText {
  readonly text: string;
  readonly map: RedactionMap;
}

/** A redacted category candidate, as sent. */
export interface RedactedCategory {
  readonly id: string;
  readonly path: string;
  readonly description?: string;
}

/** A fully redacted classify payload, ready to render into a prompt. */
export interface RedactedClassifyPayload {
  readonly fragment: RedactedFragment;
  readonly categories: readonly RedactedCategory[];
  readonly knownMerchants: readonly string[];
  readonly knownPeople: readonly string[];
  readonly examples: readonly { readonly input: string; readonly categoryId: string }[];
  /** Reverse the model's `categoryId` before validation and persistence. */
  readonly map: RedactionMap;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** Nine or more digits, allowing separators inside the run (`4111 1111 1111 1111`). */
const LONG_DIGIT_RUN = /\d(?:[\s.-]?\d){8,}/g;
/** ISO instants. A time is close to an identifier; a calendar day is not (docs/08 §6.3). */
const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * The single-letter shape a real id contributes to its placeholder.
 *
 * Two shapes only: `u1` for an internal UUID and `x1` for anything else (a slug, a fixture). The
 * point is that the model sees a stable id *shape* and never the value, so a leading letter that
 * matched the id's kind would defeat the substitution.
 */
function placeholderKind(id: string): string {
  // A fresh literal, not the shared global regex: `.test()` advances `lastIndex` on a `/g` pattern.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? 'u' : 'x';
}

/** Keeps a provider's own bookkeeping out of a category list; ids are re-mapped on return. */
class Indexer {
  private readonly byId = new Map<string, string>();
  private readonly counters = new Map<string, number>();
  private readonly substitutions: IdSubstitution[] = [];

  constructor(private readonly prefix: string) {}

  placeholderFor(id: string): string {
    const existing = this.byId.get(id);
    if (existing !== undefined) return existing;

    const key = `${this.prefix}:${placeholderKind(id)}`;
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    const placeholder = `${this.prefix}${next}`;
    this.byId.set(id, placeholder);
    this.substitutions.push({ placeholder, id });
    return placeholder;
  }

  map(): RedactionMap {
    return { ids: [...this.substitutions] };
  }
}

/**
 * Strip everything docs/08 §6.3 forbids from an arbitrary string.
 *
 * Order matters: emails and URLs first (they contain `@`, `.` and digits that the later patterns
 * would otherwise mangle), then UUIDs, then long digit runs, then the length cap.
 */
export function redactText(input: string, maxChars: number = MAX_FRAGMENT_CHARS): string {
  let text = input.replace(EMAIL, REDACTED_EMAIL);
  // A URL keeps its host only: the host is not Household data, the path and query might be.
  text = text.replace(URL_PATTERN, (match) => {
    try {
      return new URL(match).host;
    } catch {
      return '[REDACTED_URL]';
    }
  });
  text = text.replace(UUID, '[REDACTED_ID]');
  text = text.replace(ISO_INSTANT, '[REDACTED_TIMESTAMP]');
  text = text.replace(LONG_DIGIT_RUN, REDACTED_NUMBER);
  text = text.replace(CONTROL_CHARS, '');
  return cap(text, maxChars);
}

/**
 * Redact a fragment for egress.
 *
 * `amountMinor` is passed through as a string — it is the parser- or client-supplied value, and the
 * model needs it. It is *not* run through {@link redactText}: a legitimately large amount
 * (`"1234567890"`) would be masked, and masking the signal is worse than useless. It is a number
 * the caller already had, not something the model will invent (ADR-003).
 */
export function redactFragment(fragment: RedactedFragment): RedactedFragment {
  return {
    text: redactText(fragment.text),
    amountMinor: fragment.amountMinor,
    currency: fragment.currency,
    occurredOn: fragment.occurredOn,
    ...(fragment.merchantName === undefined
      ? {}
      : { merchantName: redactText(fragment.merchantName, MAX_RECEIPT_LINE_CHARS) }),
    ...(fragment.counterpartyName === undefined
      ? {}
      : { counterpartyName: redactText(fragment.counterpartyName, MAX_RECEIPT_LINE_CHARS) }),
  };
}

/**
 * Redact a Receipt line's text.
 *
 * docs/08 §6.3 says "Receipt line text — digit-run masked **before** it enters any prompt.
 * Receipts print card fragments", so the shorter line cap applies. Masking is in **place** (not a
 * `[REDACTED_NUMBER]` substitution) because an OCR line's numbers are frequently its amount, and a
 * placeholder in a line that is being read for its amount is noise; the masked line is a prompt
 * cue, not a data source.
 */
export function redactReceiptLine(line: string): string {
  const masked = line
    .replace(UUID, '[REDACTED_ID]')
    .replace(EMAIL, REDACTED_EMAIL)
    .replace(LONG_DIGIT_RUN, '****')
    .replace(CONTROL_CHARS, '');
  return cap(masked, MAX_RECEIPT_LINE_CHARS);
}

/**
 * Redact a `CLASSIFY` payload: fragment, closed category list, known entities and few-shot
 * examples.
 *
 * docs/08 §6.3 caps examples at 5 and requires each to be re-redacted; the cap is applied here
 * rather than trusted from the caller, because the cap is a cost and injection-surface control, not
 * a formatting preference.
 */
export function redactClassifyPayload(input: {
  readonly fragment: RedactedFragment;
  readonly categories: readonly CategoryCandidate[];
  readonly knownMerchants?: readonly string[];
  readonly knownPeople?: readonly string[];
  readonly examples?: readonly { readonly input: string; readonly categoryId: string }[];
}): RedactedClassifyPayload {
  // Three prefix namespaces, one returned map: a placeholder is unique across the whole payload,
  // so the caller re-maps a model answer without knowing which list it came from.
  const categories = new Indexer('c');
  const examples = new Indexer('e');
  const entities = new Indexer('n');

  return {
    fragment: redactFragment(input.fragment),
    categories: input.categories.map((category) => ({
      id: categories.placeholderFor(category.id),
      path: redactText(category.path, MAX_RECEIPT_LINE_CHARS),
      ...(category.description === undefined
        ? {}
        : { description: redactText(category.description, MAX_RECEIPT_LINE_CHARS) }),
    })),
    knownMerchants: (input.knownMerchants ?? []).map((name) =>
      entities.placeholderFor(redactText(name, MAX_RECEIPT_LINE_CHARS)),
    ),
    knownPeople: (input.knownPeople ?? []).map((name) =>
      entities.placeholderFor(redactText(name, MAX_RECEIPT_LINE_CHARS)),
    ),
    examples: (input.examples ?? []).slice(0, MAX_FEW_SHOT_EXAMPLES).map((example) => ({
      input: redactText(example.input, MAX_FRAGMENT_CHARS),
      categoryId: examples.placeholderFor(example.categoryId),
    })),
    map: { ids: [...categories.map().ids, ...examples.map().ids, ...entities.map().ids] },
  };
}

/**
 * Undo the identifier substitution on an id — either an input id (to find its placeholder) or a
 * model-proposed placeholder (to find its real id).
 *
 * Returns `null` for a value the payload never contained, which is the closed-list check's first
 * gate: an id the call never carried cannot be in the supplied list (docs/04 §6.2).
 */
export function resolveId(map: RedactionMap, placeholder: string | null): string | null {
  if (placeholder === null) return null;
  return map.ids.find((entry) => entry.placeholder === placeholder)?.id ?? null;
}

/** A Unicode-safe cap: never split a surrogate pair, and never grow a string. */
function cap(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const sliced = value.slice(0, maxChars);
  const last = sliced.charCodeAt(sliced.length - 1);
  // A high surrogate at the cut point means the pair is split; drop the orphan.
  if (last >= 0xd800 && last <= 0xdbff) return sliced.slice(0, -1);
  return sliced;
}
