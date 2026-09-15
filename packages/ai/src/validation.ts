/**
 * Output validation for a model response.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §6.2 (closed category list), docs/08 §6.9
 * defences 1, 2 and 6 ("all model output is untrusted input").
 *
 * ## Why this is not in the adapters
 *
 * The adapters are transport: they turn a provider's response into a `ClassifyProposal` and stop.
 * Validation needs the **closed list the caller supplied** — the one fact the adapter does not
 * have, because it receives a already-redacted payload with placeholder ids. Keeping validation a
 * separate pure function also means it is testable without a provider, and means the *same* check
 * can run on a proposal that arrived from a replay, a cache, or a test fixture.
 *
 * ## The closed-list check is the load-bearing one
 *
 * "Any `categoryId` not present in the supplied list is rejected by validation and treated as
 * `null` + low confidence. This single check eliminates the most damaging hallucination class"
 * (§6.2). A prompt injection that persuades the model to emit a category id it was not given
 * therefore produces an uncategorised row, not a wrong one — the blast radius stays inside the
 * Household that supplied the text (docs/08 §6.9).
 *
 * ## Everything else is clamped, not trusted
 *
 * A confidence outside `0..1` is clamped; a non-numeric one becomes `0`; a rationale longer than
 * 140 characters is truncated; control characters (including a newline that a UI might render as a
 * new instruction) are stripped; an `amountMinor` that is not a string of digits is dropped rather
 * than parsed. Nothing here is arithmetic on an amount (ADR-003) — the only question asked of an
 * amount is "is this a non-negative integer string", and a `number` is refused outright.
 *
 * **Raw confidence is returned as-is.** Calibration (§6.4) happens against observed outcomes per
 * `(task, model, prompt_version)` and needs the *raw* value; the gate is applied to the calibrated
 * one by the caller (ADR-009) — see `./calibration`.
 *
 * @module @finmate/ai
 */

import type {
  ClassifyProposal,
  ExtractedFields,
  NeedsUserInput,
  ProviderName,
} from './provider';

/** docs/04 §6.2's cap on the one-line rationale. */
export const MAX_RATIONALE_CHARS = 140;

/**
 * docs/04 §6.2's alternatives are the **top 2–3** (docs/06 §"design rules" 3), so at most three.
 *
 * `CLASSIFY_SCHEMA` already carries `maxItems: 3` for providers that honour it; this is the runtime
 * cap, because a `json_object` provider, a replay or a cache may not.
 */
export const MAX_ALTERNATIVES = 3;

/** docs/08 §6.9 defence 11's instruction-like patterns, monitored rather than obeyed. */
export const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+)?previous/i,
  /\bsystem\s*:/i,
  /you\s+are\s+now/i,
  /set\s+category\s+to/i,
  /disregard\s+(all\s+)?(previous|above)/i,
];

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const NON_NEGATIVE_INTEGER = /^\d+$/;

/** A validated proposal plus the observations the caller may want to act on. */
export interface ValidatedClassify {
  /** The proposal with every field clamped and an out-of-list `categoryId` nulled. */
  readonly proposal: ClassifyProposal;
  /** True when the raw `categoryId` was present but not in the supplied list (§6.2). */
  readonly categoryEscaped: boolean;
  /** True when any string field matched an injection pattern (§6.9 defence 11). */
  readonly injectionSuspected: boolean;
}

/**
 * Validate a raw proposal against the closed list.
 *
 * Never throws. An adapter turns whatever the provider returned into a `ClassifyProposal` shape,
 * and this function decides what is admissible; a malformed *shape* is the adapter's problem (it
 * raises `MALFORMED_RESPONSE`) while a well-shaped but wrong *value* is handled here.
 *
 * @param raw the proposal as parsed from the provider
 * @param allowedCategoryIds the ids the model was given, already re-mapped to real ids
 */
export function validateClassifyProposal(
  raw: ClassifyProposal,
  allowedCategoryIds: readonly string[],
): ValidatedClassify {
  const allowed = new Set(allowedCategoryIds);
  const categoryEscaped = raw.categoryId !== null && !allowed.has(raw.categoryId);
  const categoryId = categoryEscaped ? null : raw.categoryId;

  const rationale = sanitiseText(raw.rationale, MAX_RATIONALE_CHARS);

  const alternatives = (Array.isArray(raw.alternatives) ? raw.alternatives : [])
    .filter(
      (alternative): alternative is { categoryId: string; confidence: number } =>
        alternative !== null &&
        typeof alternative === 'object' &&
        typeof alternative.categoryId === 'string' &&
        allowed.has(alternative.categoryId),
    )
    .map((alternative) => ({
      categoryId: alternative.categoryId,
      confidence: clampConfidence(alternative.confidence),
    }))
    // "Top 2–3" is a ranking by confidence, so the cap keeps the three highest. The sort is stable,
    // so a provider that already ranked them keeps its own order for equal confidences.
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, MAX_ALTERNATIVES);

  const proposal: ClassifyProposal = {
    categoryId,
    confidence: clampConfidence(raw.confidence),
    rationale,
    alternatives,
    extracted: validateExtracted(raw.extracted),
    ...(Array.isArray(raw.needsUserInput) && raw.needsUserInput.length > 0
      ? { needsUserInput: raw.needsUserInput.map(validateNeed).slice(0, MAX_NEEDS_USER_INPUT) }
      : {}),
  };

  return {
    proposal,
    categoryEscaped,
    injectionSuspected: matchesInjection(patternHaystack(proposal)),
  };
}

/** docs/04 §6.2's `needsUserInput` is a short clarification list, not a questionnaire. */
export const MAX_NEEDS_USER_INPUT = 5;

/** Strip control characters, discard a URL, and cap the length. */
export function sanitiseText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  const stripped = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return stripped.length <= maxChars ? stripped : stripped.slice(0, maxChars);
}

/** Clamp into `0..1`. `NaN` and a non-number become `0` — the "ask" lane, never a confident lie. */
export function clampConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** True when a string carries an instruction-like pattern. Used to raise a security signal only. */
export function matchesInjection(value: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Validate the `extracted` block field by field.
 *
 * `amountMinor` must be a **string** of digits. A JSON `number` is refused, not converted: it is
 * the float-in-the-money-path failure ADR-003 exists to prevent, and the model inventing an amount
 * is exactly what §6.2's "never compute totals" rule guards against.
 */
export function validateExtracted(raw: unknown): ExtractedFields {
  if (raw === null || typeof raw !== 'object') return {};
  const source = raw as Record<string, unknown>;
  const fields: Record<string, unknown> = {};

  const amount = minorUnitsString(source['amountMinor']);
  if (amount !== null) fields['amountMinor'] = amount;

  const currency = upperCode(source['currency']);
  if (currency !== null) fields['currency'] = currency;

  if (source['kind'] === 'EXPENSE' || source['kind'] === 'INCOME') {
    fields['kind'] = source['kind'];
  }

  const occurredOn = calendarDay(source['occurredOn']);
  if (occurredOn !== null) fields['occurredOn'] = occurredOn;

  for (const key of ['merchantName', 'counterpartyName', 'description'] as const) {
    const text = sanitiseText(source[key], MAX_EXTRACTED_TEXT_CHARS);
    if (text.length > 0) fields[key] = text;
  }

  const counterpartyType = source['counterpartyType'];
  if (
    counterpartyType === 'PERSON' ||
    counterpartyType === 'COMPANY' ||
    counterpartyType === 'GOVERNMENT' ||
    counterpartyType === 'OTHER'
  ) {
    fields['counterpartyType'] = counterpartyType;
  }

  return fields as ExtractedFields;
}

/** docs/08 §6.3 cap on a fragment; an extracted name is a fragment-scale string. */
export const MAX_EXTRACTED_TEXT_CHARS = 500;

/**
 * A minor-units amount, as a string.
 *
 * Well-shaped but **not** validated against reality — the caller reconciles it against the
 * deterministic parser and refuses a disagreement (ADR-001). A negative amount is refused here
 * because `amount_minor` is always positive and direction comes from `kind` (ADR-003).
 */
export function minorUnitsString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'bigint') return null;
  const text = typeof value === 'bigint' ? value.toString() : value.trim();
  if (!NON_NEGATIVE_INTEGER.test(text)) return null;
  return text;
}

/** An ISO-4217 code, upper-cased. Never inferred, never defaulted. */
export function upperCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(text) ? text : null;
}

/** A calendar day. An instant is refused — docs/08 §6.3 forbids ever sending or storing one here. */
export function calendarDay(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : text;
}

function validateNeed(raw: unknown): NeedsUserInput {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    field: sanitiseText(source['field'], MAX_EXTRACTED_TEXT_CHARS),
    question: sanitiseText(source['question'], MAX_EXTRACTED_TEXT_CHARS),
  };
}

function patternHaystack(proposal: ClassifyProposal): string {
  const parts = [
    proposal.rationale,
    proposal.extracted.description ?? '',
    proposal.extracted.merchantName ?? '',
    proposal.extracted.counterpartyName ?? '',
  ];
  return parts.join(' ');
}

/** A `ClassifyProposal` that means "nothing usable": `null` category, zero confidence. */
export function emptyClassifyProposal(provider: ProviderName, rationale: string): ClassifyProposal {
  return {
    categoryId: null,
    confidence: 0,
    rationale: sanitiseText(`${provider}: ${rationale}`, MAX_RATIONALE_CHARS),
    alternatives: [],
    extracted: {},
  };
}
