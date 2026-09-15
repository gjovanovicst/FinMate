/**
 * JSON schemas for the structured-output contract, and the response shapes providers must return.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §6.2 — "Tool/JSON-schema enforced, so a malformed
 * response is impossible rather than merely unlikely."
 *
 * ## What is enforced where
 *
 * The **provider** enforces the schema on its side (OpenAI's `json_schema` response format,
 * DeepSeek's `json_object`). That is a convenience, not a guarantee: a provider can change its
 * behaviour, and a weaker `json_object` mode enforces nothing at all. So the shape is also the
 * adapter's parse contract — {@link readContentJson} raises `MALFORMED_RESPONSE` rather than
 * coercing, and {@link ../validation} clamps and closed-list-checks the values. Defence in depth is
 * cheap here because the payloads are tiny.
 *
 * ## The schemas are data
 *
 * Written as plain objects rather than a builder, because they are read on every request and
 * reviewed by a human when the contract in §6.2 changes. `additionalProperties: false` is set
 * everywhere it is allowed: it is what stops a provider from smuggling extra keys into a payload we
 * later render.
 *
 * @module @finmate/ai
 */

/** The `CLASSIFY` contract, mirroring docs/04 §6.2 field for field. */
export const CLASSIFY_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['categoryId', 'confidence', 'rationale', 'alternatives', 'extracted'],
  properties: {
    categoryId: {
      type: ['string', 'null'],
      description: 'One of the supplied category ids, or null when nothing fits.',
    },
    confidence: { type: 'number', description: '0..1. Do not overstate it.' },
    rationale: { type: 'string', description: 'One line, max 140 characters.' },
    alternatives: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['categoryId', 'confidence'],
        properties: {
          categoryId: { type: 'string' },
          confidence: { type: 'number' },
        },
      },
    },
    extracted: {
      type: 'object',
      additionalProperties: false,
      properties: {
        amountMinor: {
          type: 'string',
          description:
            'Minor units as a string, transcribed from the input. Never computed, never a number.',
        },
        currency: { type: 'string' },
        kind: { type: 'string', enum: ['EXPENSE', 'INCOME'] },
        occurredOn: { type: 'string', description: 'YYYY-MM-DD. Never a time.' },
        merchantName: { type: 'string' },
        counterpartyName: { type: 'string' },
        counterpartyType: {
          type: 'string',
          enum: ['PERSON', 'COMPANY', 'GOVERNMENT', 'OTHER'],
        },
        description: { type: 'string' },
      },
    },
    needsUserInput: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'question'],
        properties: { field: { type: 'string' }, question: { type: 'string' } },
      },
    },
  },
});

/** The `PARSE` contract: the `TransactionFragment` half of §6.2's `extracted` block. */
export const PARSE_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['confidence', 'fragment'],
  properties: {
    confidence: { type: 'number', description: '0..1 for the extraction as a whole.' },
    rationale: { type: 'string', description: 'Optional one line, max 140 characters.' },
    fragment: {
      type: 'object',
      additionalProperties: false,
      properties: {
        amountMinor: {
          type: 'string',
          description:
            'Minor units as a string, transcribed from the input. Never computed, never a number.',
        },
        currency: { type: 'string' },
        kind: { type: 'string', enum: ['EXPENSE', 'INCOME'] },
        occurredOn: { type: 'string' },
        merchantName: { type: 'string' },
        counterpartyName: { type: 'string' },
        counterpartyType: { type: 'string', enum: ['PERSON', 'COMPANY', 'GOVERNMENT', 'OTHER'] },
        description: { type: 'string' },
      },
    },
  },
});

/** The `OCR` contract. Line text and totals, never an item-level categorisation (§6.1). */
export const OCR_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['lines', 'confidence'],
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string' },
          amountMinor: { type: 'string' },
        },
      },
    },
    totalMinor: { type: 'string' },
    currency: { type: 'string' },
    occurredOn: { type: 'string' },
    merchantName: { type: 'string' },
    confidence: { type: 'number' },
  },
});

/** A chat-completions message, in the OpenAI wire shape DeepSeek also speaks. */
export interface WireMessage {
  readonly role: 'system' | 'user';
  /** Plain text, or an array of parts when an image is attached. */
  readonly content: string | readonly WireContentPart[];
}

export type WireContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } };

/**
 * How a provider is asked for JSON.
 *
 * - `json_schema` — OpenAI's structured outputs: the schema is transmitted and enforced.
 * - `json_object` — DeepSeek's JSON mode: "JSON" is named in the prompt and the schema is enforced
 *   **by us** on parse. The weaker mode is why {@link readContentJson} exists.
 */
export type ResponseFormatMode = 'json_schema' | 'json_object';

/** The subset of a chat-completions response body this package reads. */
export interface ChatCompletionBody {
  readonly choices?: readonly {
    readonly message?: { readonly content?: unknown };
    readonly finish_reason?: unknown;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
  };
  readonly model?: unknown;
  readonly error?: { readonly message?: unknown };
}

/**
 * The assistant's message content, parsed as JSON.
 *
 * Returns `null` for anything that is not a JSON object — an empty body, a refused completion, a
 * truncated one, or a provider that answered with prose. The caller raises `MALFORMED_RESPONSE`:
 * coercing here would be the "interpret the model's text" mistake docs/04 §6.2 exists to prevent.
 */
export function readContentJson(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== 'object') return null;
  const completion = body as ChatCompletionBody;
  const content = completion.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Token usage, with either side allowed to be absent. */
export function readUsage(body: unknown): {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
} {
  const usage = (body ?? {}) as ChatCompletionBody;
  const prompt = usage.usage?.prompt_tokens;
  const completion = usage.usage?.completion_tokens;
  return {
    promptTokens: typeof prompt === 'number' && Number.isFinite(prompt) ? prompt : null,
    completionTokens:
      typeof completion === 'number' && Number.isFinite(completion) ? completion : null,
  };
}

/** The model id the provider reports, falling back to the one requested. */
export function readModel(body: unknown, requested: string | null): string | null {
  const model = ((body ?? {}) as ChatCompletionBody).model;
  return typeof model === 'string' && model.length > 0 ? model : requested;
}

/** A provider's own error message, for the log line on a non-2xx. Never surfaced to a user. */
export function readProviderError(body: unknown): string | null {
  const message = ((body ?? {}) as ChatCompletionBody).error?.message;
  return typeof message === 'string' && message.length > 0 ? message : null;
}
