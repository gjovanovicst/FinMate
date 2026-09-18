/**
 * The `AiProvider` contract and the Proposal types it may return.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §9 (interface), §6.2 (the `ClassifyProposal` shape)
 *
 * ## Proposals, never state
 *
 * Everything here is a **Proposal** (docs/03 §1, ADR-001). A model's output has not been through a
 * deterministic validation + persistence path, so it is not data: it carries a confidence, the
 * backend decides whether to apply it, and nothing in this package writes anywhere. The package
 * does not even have a database to write to — `scope:api` is absent from its allowed boundaries
 * (`eslint.config.mjs`).
 *
 * ## The model never computes money
 *
 * No type here performs arithmetic and no amount is ever *derived* from model output (ADR-003).
 * Where an amount appears it is a `string` of **minor units** (`"360000"` = 3 600,00 RSD), because a
 * JSON number is a float and the money path is `bigint`-only. Two directions are deliberately
 * distinguished:
 *
 * - An amount in an **input** is the client- or parser-supplied value being echoed through.
 * - An amount in a **proposal** is the model transcribing what it read in the fragment. The caller
 *   must reconcile it against the deterministic parser and refuse it when they disagree; it is a
 *   Proposal, so a hallucinated `"99999900"` is a wrong suggestion, never a balance.
 *
 * ## The model has no capabilities
 *
 * §6.9 defence 5: no tools, no browsing, no code execution, no database, no memory across calls.
 * The shape of {@link AiProvider} is the enforcement — there is simply no field through which to
 * grant one. `parse`/`classify` are structured-output calls; a malformed response is rejected
 * rather than interpreted.
 *
 * ## Prompts are owned by the caller
 *
 * This is the transport layer, not the prompt content (task 2.2.2 renders the §6.3 template). The
 * caller passes the rendered `system` and `user` text plus the `prompt_template_id` + `version`
 * identity, and this package redacts, transports, times, retries, prices and returns that identity
 * on the result so a regression is attributable to a prompt change (docs/04 §9).
 *
 * @module @finmate/ai
 */

/**
 * docs/04 §9's `Task`. The four sensitive tasks carry the Household's own free text or a Receipt
 * image and are residency-restricted; `EMBED` never leaves the process at all.
 *
 * `ROUTE` is the fifth, added by ADR-036: a sentence the deterministic cues could not match is sent to
 * a model to find out **which registered intent or action it means**. It carries no ledger data at all,
 * and what it may answer is a member of a compiled-in union — never a method, URL, id, amount or date.
 */
export type Task = 'PARSE' | 'CLASSIFY' | 'NARRATE' | 'OCR' | 'ROUTE' | 'EMBED';

/**
 * Every task, in the order docs/04 §9 lists them. Exported so a caller iterating the routing table
 * (validation, health checks, the settings screen) cannot silently miss one, and so adding a `Task`
 * member without adding it here is a compile error rather than an omission.
 */
export const TASKS: readonly Task[] = ['PARSE', 'CLASSIFY', 'NARRATE', 'OCR', 'ROUTE', 'EMBED'];

/**
 * docs/04 §9's provider identity. This is the vendor, not the endpoint: `OPENAI` serves both
 * `OPENAI_EU` and, in principle, a non-EEA endpoint a consenting Household selected by name.
 * Residency is a property of the {@link Endpoint} (`./endpoints`), never of the provider.
 */
export type ProviderName = 'OPENAI' | 'ANTHROPIC' | 'GEMINI' | 'DEEPSEEK' | 'LOCAL';

/**
 * Which prompt template produced a call, and which revision of it.
 *
 * docs/04 §9 requires this on every call "so an accuracy regression can be attributed to a prompt
 * change". It is recorded per call into `classification_decisions` by the caller — this package
 * records nothing itself.
 */
export interface PromptRef {
  /** Stable id of the template, e.g. `classify.serbian-household`. */
  readonly templateId: string;
  /** Monotonic revision of that template's text. */
  readonly version: string;
}

/** Everything a task call needs that is not task-specific transport: prompt identity and text. */
export interface TaskCall extends PromptRef {
  /**
   * The authenticated host, e.g. `https://api.deepseek.com`. The adapter appends its own path.
   *
   * Passed per call rather than captured at construction so the same adapter instance cannot pin a
   * process to one region, and so a test can point a provider at a stub without module mocking.
   */
  readonly baseUrl: string;
  /** The rendered system prompt (docs/04 §6.3). Owned by the caller, redacted here before egress. */
  readonly system: string;
  /** The rendered user prompt. Owned by the caller, redacted here before egress. */
  readonly user: string;
}

/**
 * docs/04 §6.3's fragment, after redaction.
 *
 * `amountMinor` is a **string**. It arrives from the client or from `packages/nlp`'s deterministic
 * extraction; it is echoed through to the model so the model can read it, and it is never derived
 * from model output (ADR-003).
 */
export interface RedactedFragment {
  /** `raw_input` / description, redacted and length-capped. */
  readonly text: string;
  /** Minor units as a string — `"360000"`, never a number. `null` when extraction failed. */
  readonly amountMinor: string | null;
  /** ISO-4217, never inferred here. */
  readonly currency: string | null;
  /** Calendar day only: docs/08 §6.3 forbids ever sending `occurred_at`, time, or timezone. */
  readonly occurredOn: string | null;
  /** The Household's own merchant/counterparty names when they survived resolution. */
  readonly merchantName?: string;
  readonly counterpartyName?: string;
}

/**
 * docs/04 §6.2's category candidate: `id | path | description`, top-N by keyword/embedding
 * prefilter (§6.3) — never the whole tree for a large Household (docs/08 §6.4).
 */
export interface CategoryCandidate {
  readonly id: string;
  readonly path: string;
  readonly description?: string;
}

/** One household-corrected example, at most 5 (docs/08 §6.3). Re-redacted by the adapter. */
export interface FewShotExample {
  readonly input: string;
  readonly categoryId: string;
}

export interface ParseInput extends TaskCall {
  readonly task: 'PARSE';
  readonly locale: string;
  readonly fragment: RedactedFragment;
}

export interface ClassifyInput extends TaskCall {
  readonly task: 'CLASSIFY';
  readonly locale: string;
  readonly fragment: RedactedFragment;
  /**
   * The closed list the model may choose from (docs/04 §6.2). An id outside it is rejected by
   * validation and treated as `null` + low confidence — that single check removes the most damaging
   * hallucination class (§6.9 defence 2).
   */
  readonly categories: readonly CategoryCandidate[];
  readonly knownMerchants?: readonly string[];
  readonly knownPeople?: readonly string[];
  readonly examples?: readonly FewShotExample[];
}

export interface NarrateInput extends TaskCall {
  readonly task: 'NARRATE';
  readonly locale: string;
  /** Pre-formatted fact strings from the query planner. Never raw floats, ids, or query results. */
  readonly facts: readonly string[];
  /** `<= 280` chars (docs/08 §6.3). Never a general-purpose instruction (§6.11). */
  readonly question: string;
}

/**
 * A routing request: *which* registered intent or action does this sentence mean? (ADR-036)
 *
 * ⚠️ **The user's own words are the entire payload.** There is no ledger context in a route request —
 * no ids, no Category or Merchant names, no figure from the database — because the question *is* the
 * input; the closed member lists travel in `user`, rendered by the caller that owns them.
 *
 * **Digits are deliberately not redacted**, which narrows docs/08 §6.3 for this one task and is
 * recorded in ADR-036. The text a route returns becomes a slot the *local* parsers read (`parseAmount`,
 * the calendar), so stripping an amount here would produce an action with no amount in it — a redaction
 * that silently breaks every `ADD_TRANSACTION` it touches. What protects this payload instead is that
 * it carries nothing the Household did not type, that it is capped by the caller (the same 280-char
 * rule narration follows), and that it is consent-gated and EEA-or-local like every other task.
 */
export interface RouteInput extends TaskCall {
  readonly task: 'ROUTE';
  readonly locale: string;
  /** The user's own words, capped by the caller. */
  readonly question: string;
}

/**
 * What a route request answers, shape-checked here and **membership-checked by the caller**.
 *
 * `route` is a string rather than a union on purpose: `packages/ai` must not know the intent or action
 * registries (they are `apps/api`'s), and a union here would be a second copy of them — the drift
 * ADR-017's closed `Record` exists to prevent. The caller rejects anything outside its unions, and
 * `null` is the honest answer that says "none of these".
 */
export interface RouteAnswer {
  /** The member name the sentence maps to, or `null` when none of them fits. Never a method. */
  readonly route: string | null;
  /** For a write: the words naming what it acts on, copied from the sentence. `null` for a question. */
  readonly text: string | null;
}

export interface OcrInput extends TaskCall {
  readonly task: 'OCR';
  /** The Receipt image, base64-encoded, EXIF already stripped by the caller (docs/08 §6.2). */
  readonly imageBase64: string;
  readonly mimeType: string;
  readonly locale: string;
}

/**
 * docs/04 §6.2's `extracted` block. Every field is optional and every amount is a **string** of
 * minor units. A field the model did not read stays absent; it never gets a default of `0`.
 */
export interface ExtractedFields {
  readonly amountMinor?: string;
  readonly currency?: string;
  readonly kind?: 'EXPENSE' | 'INCOME';
  /** A calendar day, `YYYY-MM-DD`. Never an instant: the model is not a clock. */
  readonly occurredOn?: string;
  readonly merchantName?: string;
  readonly counterpartyName?: string;
  readonly counterpartyType?: 'PERSON' | 'COMPANY' | 'GOVERNMENT' | 'OTHER';
  readonly description?: string;
}

/** A question the model wants asked, e.g. "Is this a gift?" (docs/04 §6.2). */
export interface NeedsUserInput {
  readonly field: string;
  readonly question: string;
}

/**
 * The result of a `PARSE`, success or failure — a value, never a thrown error.
 *
 * **Why failure is a value here.** A parse miss is an expected outcome of an exception path, not a
 * programming bug: the caller's response is a different rung of the degradation ladder
 * (deterministic extraction, then manual entry), not an error boundary. Returning it keeps that
 * decision with the caller and stops a timeout from being indistinguishable from a 401.
 */
export type ParseProposal =
  | {
      readonly ok: true;
      readonly confidence: number;
      readonly fragment: ExtractedFields;
      /** `null` unless the provider returned one; never invented here. */
      readonly rationale: string | null;
    }
  | {
      readonly ok: false;
      /** The typed `AiErrorCode` that produced the miss, so the caller can branch on it. */
      readonly reason: string;
    };

/** docs/04 §6.2, verbatim — the shape a provider is schema-bound to return for `CLASSIFY`. */
export interface ClassifyProposal {
  /** `null` when nothing fits. MUST be one of the supplied ids; see {@link ClassifyInput}. */
  readonly categoryId: string | null;
  /** 0..1 **raw** model confidence. Gate on the calibrated value, never this (ADR-009, §6.4). */
  readonly confidence: number;
  /** `<= 140` chars, rendered as text (docs/08 §6.9 defence 6). */
  readonly rationale: string;
  readonly alternatives: readonly { readonly categoryId: string; readonly confidence: number }[];
  readonly extracted: ExtractedFields;
  readonly needsUserInput?: readonly NeedsUserInput[];
}

/** One redacted line of a Receipt. Digit runs masked at ingest (docs/08 §6.3). */
export interface OcrLine {
  readonly text: string;
  readonly amountMinor: string | null;
}

export interface OcrResult {
  readonly lines: readonly OcrLine[];
  /** Total as printed on the Receipt, minor units as a string. Reconciled later against items. */
  readonly totalMinor: string | null;
  readonly currency: string | null;
  readonly occurredOn: string | null;
  readonly merchantName: string | null;
  readonly confidence: number;
}

/**
 * docs/04 §9's interface.
 *
 * `ocr` and `embed` are **optional**: an adapter that cannot do them omits them, and the router
 * handles a missing member rather than assuming it exists. That is the difference between "provider
 * swapability" as a slogan and as behaviour — a text-only provider is a drop-in for
 * PARSE/CLASSIFY/NARRATE and simply cannot serve OCR/EMBED.
 *
 * Implementations are thin HTTP+JSON adapters. There is no vendor SDK (AGENTS.md rule 9: a new
 * dependency needs an ADR, and a vendor SDK would drag vendor-shaped types into a package whose
 * entire purpose is to treat providers symmetrically, ADR-007).
 */
export interface AiProvider {
  /**
   * Can this adapter serve `task`? Optional, because a test double need not model capability at all;
   * callers fall back to {@link supportsTask}, the presence check the router itself applies.
   *
   * An adapter that **claims** a capability without a model for it is the defect ADR-037 records: the
   * route exists, the disclosure may name it, and the first real call fails. This method is where that
   * question is answered precisely, so the composition root can ask it *before* a route exists.
   */
  supports?(task: Task): boolean;

  readonly name: ProviderName;
  parse(input: ParseInput): Promise<ParseProposal>;
  classify(input: ClassifyInput): Promise<ClassifyProposal>;
  narrate(input: NarrateInput): Promise<string>;
  ocr?(input: OcrInput): Promise<OcrResult>;
  embed?(texts: readonly string[]): Promise<number[][]>;
}

/**
 * A provider that can also report cost and latency for the call it just made.
 *
 * docs/04 §9 puts cost/latency recording on every adapter, but the §9 interface above returns a
 * bare `Proposal` and must keep doing so — it is the published contract and the one thing a new
 * adapter implements. So the accounting is a **second, optional** capability:
 * {@link RoutedProvider.callTask} returns the Proposal *and* a {@link CallTelemetry}.
 *
 * The router prefers it when present and otherwise synthesises a `PROVIDERS_WITHOUT_ACCOUNTING`
 * telemetry. That keeps the split honest — a provider that cannot report cost is a provider whose
 * calls show up in `classification_decisions.cost_micros` as `0`, which is visible — and it means
 * an adapter is never *required* to know a price list to be usable.
 */
export interface RoutedProvider extends AiProvider {
  callTask<T>(task: Task, input: unknown): Promise<{ value: T; telemetry: CallTelemetry }>;
}

/** True when the provider implements {@link RoutedProvider}. */
export function hasCallTask(provider: AiProvider): provider is RoutedProvider {
  return typeof (provider as Partial<RoutedProvider>).callTask === 'function';
}

/**
 * The telemetry recorded for a provider that does not report any.
 *
 * `model: null` and `costMicros: 0` — a hole in the dashboard, not a fabricated number (§12).
 */
export function unaccountedTelemetry(): CallTelemetry {
  return {
    model: null,
    latencyMs: 0,
    costMicros: 0,
    promptTokens: null,
    completionTokens: null,
    retryCount: 0,
  };
}

/**
 * Token accounting for one shipped call.
 *
 * docs/04 §9 wants `cost_micros` and `latency_ms` per call written into `classification_decisions`
 * "which makes per-household unit economics measurable rather than guessed". This package computes
 * them and **returns** them; it writes nothing (AGENTS.md rule 4 in the task brief).
 */
export interface CallTelemetry {
  /** The provider's model id as sent, e.g. `deepseek-chat`. `null` when the call never shipped. */
  readonly model: string | null;
  readonly latencyMs: number;
  /** Integer micro-units of the account's billing currency. Rounded, never a float. */
  readonly costMicros: number;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  /** How many retries were spent on transient failures. `0` for a first-attempt success. */
  readonly retryCount: number;
}
