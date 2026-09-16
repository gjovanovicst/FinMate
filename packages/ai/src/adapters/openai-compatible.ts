/**
 * The OpenAI-compatible chat-completions adapter — shared by OpenAI, DeepSeek and a local
 * OpenAI-compatible runtime.
 *
 * Owners: docs/04-categorization-and-ai-engine.md §9 (the per-adapter requirements), §6.2 (the
 * structured-output contract); ADR-007 (provider swapability); AGENTS.md rule 9 (no vendor SDK).
 *
 * ## Why OpenAI and DeepSeek share one implementation
 *
 * DeepSeek's chat-completions API is OpenAI-compatible in its wire format: the same `chat/
 * completions` shape, the same `messages` array, the same `choices[0].message.content`, the same
 * `usage.prompt_tokens`. Copying the request builder to change two strings would create two places
 * where redaction, the timeout budget, the retry rule or the schema can drift — and the one that
 * drifts is the one nobody re-reads. So the wire code is **shared** and the differences are
 * configuration:
 *
 * | | OpenAI | DeepSeek | Local (Ollama-style) |
 * |---|---|---|---|
 * | path | `/v1/chat/completions` | `/chat/completions` | `/v1/chat/completions` |
 * | auth | `Authorization: Bearer` | `Authorization: Bearer` | none |
 * | structured output | `json_schema` (provider-enforced) | `json_object` (prompt-steered) | `json_schema` |
 *
 * A local runtime is addressed through the same adapter because that is what "the provider is
 * swappable" means in practice (AGENTS.md rule 10): the local model is a first-class provider
 * (docs/08 §6.8), not a special case threaded through the feature modules.
 *
 * ## What the adapter does, in order, on every call
 *
 * 1. **Redact** (docs/08 §6.3) — the one place, so there is no path around it.
 * 2. **Render** the system/user envelope with the untrusted span delimited and its delimiters
 *    stripped (docs/08 §6.9 defence 4).
 * 3. **Transport** with the task's budget and at most one retry on a transient failure only.
 * 4. **Parse** into a `Proposal`, raising `MALFORMED_RESPONSE` rather than guessing.
 * 5. **Account**: model, tokens, integer micros, latency, retry count — returned, never written.
 *
 * ## Identity and the per-call base URL
 *
 * An adapter instance is declared as the pair (`endpoint`, `provider`), and the **base URL travels
 * on the call** (`TaskCall.baseUrl`). That is deliberate: a single instance therefore cannot pin a
 * process to one region, and a test can point a provider at a stub without module mocking. The
 * router only ever constructs an adapter for an endpoint the routing table already declared safe
 * (docs/04 §9, `./endpoints`).
 *
 * @module @finmate/ai
 */

import { AiRequestError } from '../errors';
import { costMicros } from '../pricing';
import { redactClassifyPayload, redactFragment, resolveId, type RedactionMap } from '../redaction';
import {
  asUntrusted,
  renderClassifyContext,
  renderFragment,
  UNTRUSTED_SYSTEM_PREAMBLE,
  withJsonInstruction,
} from '../prompt';
import type { Endpoint } from '../endpoints';
import type {
  CallTelemetry,
  ClassifyInput,
  ClassifyProposal,
  NarrateInput,
  OcrInput,
  OcrLine,
  OcrResult,
  ParseInput,
  ParseProposal,
  ProviderName,
  RoutedProvider,
  Task,
} from '../provider';
import type { HttpTransport } from '../transport';
import {
  calendarDay,
  clampConfidence,
  MAX_EXTRACTED_TEXT_CHARS,
  minorUnitsString,
  sanitiseText,
  upperCode,
  validateClassifyProposal,
  validateExtracted,
} from '../validation';
import {
  CLASSIFY_SCHEMA,
  OCR_SCHEMA,
  PARSE_SCHEMA,
  readContentJson,
  readModel,
  readUsage,
  type ResponseFormatMode,
  type WireContentPart,
  type WireMessage,
} from './wire';

/** Configuration for one OpenAI-compatible endpoint. */
export interface OpenAiCompatibleConfig {
  /** The endpoint this adapter instance serves. `LOCAL`, `OPENAI_EU`, `DEEPSEEK_EU`, … */
  readonly endpoint: Endpoint;
  readonly provider: ProviderName;
  /**
   * Where the endpoint is. The brief calls this the host (`https://api.deepseek.com`); a local
   * runtime is usually `http://localhost:11434`.
   *
   * Optional, because the per-call `TaskCall.baseUrl` wins when it is set — that is what lets one
   * adapter instance serve a Household-selected region without being rebuilt.
   */
  readonly baseUrl?: string;
  readonly apiKey?: string;
  /** Path appended to the base URL. Defaults to {@link DEFAULT_CHAT_PATH}. */
  readonly path?: string;
  /** `json_schema` when the provider enforces the schema; `json_object` when we must. */
  readonly responseFormat: ResponseFormatMode;
  /** Model id per task. A task with no entry is not supported by this adapter. */
  readonly models: Partial<Record<Task, string>>;
  /** Extra request-body fields, e.g. `max_tokens`. Explicit so a shipped body stays reviewable. */
  readonly extraBody?: Readonly<Record<string, unknown>>;
  /** Per-task timeout overrides, for a provider measured slower than the documented budget. */
  readonly timeouts?: Partial<Record<Task, number>>;
  /** Set false to omit `ocr`/`embed` entirely instead of raising `TASK_NOT_SUPPORTED`. */
  readonly supportsOcr?: boolean;
  readonly supportsEmbed?: boolean;
  /** Path for embeddings when {@link supportsEmbed}. Defaults to `/v1/embeddings`. */
  readonly embedPath?: string;
  /**
   * The clock used for `latency_ms`. Defaults to `Date.now`.
   *
   * Shared with the transport's timeout budget so the two cannot disagree, and injectable so a
   * spec can assert a full result — telemetry included — is deep-equal across two calls.
   */
  readonly now?: () => number;
}

/** What one adapter call produced, plus everything the caller must record about it. */
export interface AdapterCall<T> {
  readonly value: T;
  readonly telemetry: CallTelemetry;
}

/** docs/04 §9's per-task budgets. The OCR budget is largest because the payload is an image. */
export const TASK_TIMEOUTS_MS: Readonly<Record<Task, number>> = Object.freeze({
  PARSE: 2_000,
  CLASSIFY: 2_000,
  NARRATE: 8_000,
  OCR: 20_000,
  EMBED: 2_000,
});

/** The default chat-completions path. The DeepSeek factory overrides it. */
export const DEFAULT_CHAT_PATH = '/v1/chat/completions';

/**
 * docs/04 §9's "seeded where the provider allows". A fixed constant, not a random value: a random
 * seed would defeat the determinism the same sentence asks for.
 */
export const DETERMINISM_SEED = 0;

/**
 * An `AiProvider` over the OpenAI-compatible chat-completions wire format.
 *
 * Implements the four chat tasks unconditionally and exposes `ocr`/`embed` only when configured —
 * an adapter that cannot do them omits them, and the router checks with `supports()` rather than
 * assuming a member exists (docs/04 §9).
 */
export class OpenAiCompatibleProvider implements RoutedProvider {
  readonly name: ProviderName;
  readonly endpoint: Endpoint;

  /** Wired in the constructor body so the class holds no state the config does not describe. */
  readonly ocr?: (input: OcrInput) => Promise<OcrResult>;
  readonly embed?: (texts: readonly string[]) => Promise<number[][]>;

  private readonly config: OpenAiCompatibleConfig;
  private readonly transport: HttpTransport;
  private readonly now: () => number;

  constructor(config: OpenAiCompatibleConfig, transport: HttpTransport) {
    this.config = config;
    this.transport = transport;
    this.now = config.now ?? Date.now;
    this.name = config.provider;
    this.endpoint = config.endpoint;

    if (config.supportsOcr === true) {
      this.ocr = (input) => this.callOcr(input).then((call) => call.value);
    }
    if (config.supportsEmbed === true) {
      this.embed = (texts) => this.callEmbed(texts).then((call) => call.value);
    }
  }

  /** True when this adapter has a model for the task. The router checks before calling it. */
  supports(task: Task): boolean {
    if (this.config.models[task] === undefined) return false;
    if (task === 'OCR' && this.ocr === undefined) return false;
    if (task === 'EMBED' && this.embed === undefined) return false;
    return true;
  }

  /**
   * The {@link RoutedProvider} entry point: the Proposal **and** its cost/latency.
   *
   * The router calls this rather than the four `AiProvider` methods, so accounting cannot be
   * forgotten by a caller that only wants the value. `task` selects the method; the input is typed
   * by the caller, because a single union parameter serialised over a wire is worse than four
   * precisely-typed methods.
   */
  async callTask<T>(task: Task, input: unknown): Promise<AdapterCall<T>> {
    switch (task) {
      case 'PARSE':
        return (await this.callParse(input as ParseInput)) as AdapterCall<T>;
      case 'CLASSIFY':
        return (await this.callClassify(input as ClassifyInput)) as AdapterCall<T>;
      case 'NARRATE':
        return (await this.callNarrate(input as NarrateInput)) as AdapterCall<T>;
      case 'OCR':
        return (await this.callOcr(input as OcrInput)) as AdapterCall<T>;
      case 'EMBED':
        return (await this.callEmbed(input as readonly string[])) as AdapterCall<T>;
    }
  }

  async parse(input: ParseInput): Promise<ParseProposal> {
    return (await this.callParse(input)).value;
  }

  async classify(input: ClassifyInput): Promise<ClassifyProposal> {
    return (await this.callClassify(input)).value;
  }

  async narrate(input: NarrateInput): Promise<string> {
    return (await this.callNarrate(input)).value;
  }

  // --- the call methods, each returning telemetry alongside the Proposal -------------------------

  async callParse(input: ParseInput): Promise<AdapterCall<ParseProposal>> {
    // Re-redacted rather than trusted: a caller may hand over a fragment it built itself, and the
    // redaction must be idempotent and unconditional (docs/08 §6.3).
    const fragment = redactFragment(input.fragment);
    const user = `${input.user}\n\n${renderFragment(fragment)}`;

    return this.runTask<ParseProposal>('PARSE', input, user, PARSE_SCHEMA, (body) => {
      const parsed = readContentJson(body);
      if (parsed === null) {
        // A parse miss is an expected outcome, not a bug: the caller drops to deterministic
        // extraction (the degradation ladder). Returned as a value so a timeout and a bad key stay
        // distinguishable to the caller.
        return { ok: false, reason: 'MALFORMED_RESPONSE' };
      }
      return {
        ok: true,
        confidence: clampConfidence(parsed['confidence']),
        fragment: validateExtracted(parsed['fragment']),
        rationale:
          typeof parsed['rationale'] === 'string'
            ? sanitiseText(parsed['rationale'], MAX_EXTRACTED_TEXT_CHARS)
            : null,
      };
    });
  }

  async callClassify(input: ClassifyInput): Promise<AdapterCall<ClassifyProposal>> {
    const payload = redactClassifyPayload({
      fragment: input.fragment,
      categories: input.categories,
      ...(input.knownMerchants === undefined ? {} : { knownMerchants: input.knownMerchants }),
      ...(input.knownPeople === undefined ? {} : { knownPeople: input.knownPeople }),
      ...(input.examples === undefined ? {} : { examples: input.examples }),
    });

    const context = renderClassifyContext({
      categories: payload.categories,
      knownMerchants: payload.knownMerchants,
      knownPeople: payload.knownPeople,
      examples: payload.examples,
    });
    const user = `${input.user}\n\n${context}\n\nInput:\n${renderFragment(payload.fragment)}`;

    // The real ids, which is what validation must compare against: the model answered in
    // placeholders, and the map is the only thing that can translate back (docs/08 §6.3).
    const allowedIds = input.categories.map((category) => category.id);

    const call = await this.runTask<Record<string, unknown>>(
      'CLASSIFY',
      input,
      user,
      CLASSIFY_SCHEMA,
      (body) => {
        const parsed = readContentJson(body);
        if (parsed === null) {
          throw new AiRequestError(
            'MALFORMED_RESPONSE',
            'classify response was not a JSON object; the structured-output contract was not met',
            this.name,
            null,
          );
        }
        return parsed;
      },
    );

    const proposal = toClassifyProposal(call.value, payload.map);
    const validated = validateClassifyProposal(proposal, allowedIds);
    return { ...call, value: validated.proposal };
  }

  async callNarrate(input: NarrateInput): Promise<AdapterCall<string>> {
    // Facts and question are both attacker-influenced: a Category name or a Merchant name reaches
    // the question through the query planner, so both go inside the untrusted span (docs/08 §6.9).
    const facts = input.facts.map((fact) => asUntrusted(sanitiseText(fact, MAX_EXTRACTED_TEXT_CHARS)));
    const question = asUntrusted(sanitiseText(input.question, MAX_EXTRACTED_TEXT_CHARS));
    const user = `${input.user}\n\nFacts:\n${facts.join('\n')}\n\nQuestion:\n${question}`;

    return this.runTask<string>('NARRATE', input, user, null, (body) => {
      const message = ((body ?? {}) as { choices?: readonly { message?: { content?: unknown } }[] })
        .choices?.[0]?.message?.content;
      if (typeof message !== 'string' || message.trim().length === 0) {
        throw new AiRequestError(
          'MALFORMED_RESPONSE',
          'narrate response had no message content',
          this.name,
          null,
        );
      }
      return message;
    });
  }

  async callOcr(input: OcrInput): Promise<AdapterCall<OcrResult>> {
    const user = `${input.user}\n\n${asUntrusted('[receipt image attached]')}`;
    const imagePart: WireContentPart = {
      type: 'image_url',
      image_url: { url: `data:${input.mimeType};base64,${input.imageBase64}` },
    };

    return this.runTask<OcrResult>('OCR', input, user, OCR_SCHEMA, (body) => {
      const parsed = readContentJson(body);
      if (parsed === null) {
        throw new AiRequestError(
          'MALFORMED_RESPONSE',
          'ocr response was not a JSON object',
          this.name,
          null,
        );
      }
      return {
        lines: toOcrLines(parsed['lines']),
        totalMinor: minorUnitsString(parsed['totalMinor']),
        currency: upperCode(parsed['currency']),
        occurredOn: calendarDay(parsed['occurredOn']),
        merchantName: sanitiseText(parsed['merchantName'], MAX_EXTRACTED_TEXT_CHARS) || null,
        confidence: clampConfidence(parsed['confidence']),
      };
    }, [imagePart]);
  }

  async callEmbed(texts: readonly string[]): Promise<AdapterCall<number[][]>> {
    const model = this.config.models.EMBED;
    if (model === undefined) {
      throw new AiRequestError('TASK_NOT_SUPPORTED', 'no embedding model configured', this.name, null);
    }

    const startedAt = this.now();
    const result = await this.transport.post(
      this.name,
      model,
      {
        url: joinUrl(this.baseUrlFor(this.config), this.config.embedPath ?? DEFAULT_EMBED_PATH),
        method: 'POST',
        headers: this.headers(),
        body: {
          model,
          // Embeddings are built from the Household's own entity names, so they are capped and
          // control-character-stripped like every other prompt string (docs/08 §6.3).
          input: texts.map((text) => sanitiseText(text, MAX_EXTRACTED_TEXT_CHARS)),
        },
        timeoutMs: this.timeoutFor('EMBED'),
      },
      (response) => readEmbeddings(response.json),
    );

    const usage = readUsage(result.attempt.response.json);
    const cost = costMicros(model, usage.promptTokens, usage.completionTokens);
    return {
      value: result.value as number[][],
      telemetry: {
        model: readModel(result.attempt.response.json, model),
        latencyMs: this.now() - startedAt,
        costMicros: cost.costMicros,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        retryCount: result.attempt.retryCount,
      },
    };
  }

  // --- internals -------------------------------------------------------------------------------

  /**
   * The shared path for the four chat tasks: build the body, ship it, parse the body, account.
   *
   * `schema` is `null` only for `NARRATE`, whose output is prose and is therefore the one call that
   * is not schema-bound — which is also why §10's numeric validator exists.
   */
  private async runTask<T>(
    task: Task,
    input: ParseInput | ClassifyInput | NarrateInput | OcrInput,
    user: string,
    schema: Readonly<Record<string, unknown>> | null,
    parse: (body: unknown) => T,
    extraParts: readonly WireContentPart[] = [],
  ): Promise<AdapterCall<T>> {
    const model = this.config.models[task];
    if (model === undefined) {
      throw new AiRequestError(
        'TASK_NOT_SUPPORTED',
        `no model configured for ${task}`,
        this.name,
        null,
      );
    }

    const body = this.buildBody(task, model, input.system, user, schema, extraParts);
    const startedAt = this.now();
    const url = joinUrl(this.baseUrlFor(input), this.config.path ?? DEFAULT_CHAT_PATH);

    const result = await this.transport.post(
      this.name,
      model,
      {
        url,
        method: 'POST',
        headers: this.headers(),
        body,
        timeoutMs: this.timeoutFor(task),
      },
      (response) => parse(response.json),
    );

    const usage = readUsage(result.attempt.response.json);
    const cost = costMicros(model, usage.promptTokens, usage.completionTokens);
    return {
      value: result.value as T,
      telemetry: {
        model: readModel(result.attempt.response.json, model),
        latencyMs: this.now() - startedAt,
        costMicros: cost.costMicros,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        retryCount: result.attempt.retryCount,
      },
    };
  }

  /**
   * Build the request body.
   *
   * `temperature: 0` for `PARSE` and `CLASSIFY` — docs/04 §9's determinism knob — with the seed set
   * wherever the provider accepts one. `NARRATE` and `OCR` are not determinism-gated by §9, so
   * their body carries no temperature rather than one this package invented.
   */
  private buildBody(
    task: Task,
    model: string,
    system: string,
    user: string,
    schema: Readonly<Record<string, unknown>> | null,
    extraParts: readonly WireContentPart[],
  ): Record<string, unknown> {
    const messages: WireMessage[] = [
      { role: 'system', content: `${UNTRUSTED_SYSTEM_PREAMBLE}\n\n${system}` },
      {
        role: 'user',
        content:
          extraParts.length === 0
            ? this.steerJson(user, task, schema)
            : [{ type: 'text', text: this.steerJson(user, task, schema) }, ...extraParts],
      },
    ];

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
      ...this.config.extraBody,
    };

    if (task === 'PARSE' || task === 'CLASSIFY') {
      body['temperature'] = 0;
      body['seed'] = DETERMINISM_SEED;
    }

    const format = this.responseFormat(task, schema);
    if (format !== null) body['response_format'] = format;

    return body;
  }

  /**
   * `json_object` mode must be asked for the JSON *and its shape* in the prompt; `json_schema` mode
   * must not be asked for either, because the provider enforces it.
   *
   * Threading `schema` here rather than letting the prompt builder guess is what keeps the two modes
   * describing one shape: the identical constant is either transmitted or described.
   */
  private steerJson(
    user: string,
    task: Task,
    schema: Readonly<Record<string, unknown>> | null,
  ): string {
    if (this.config.responseFormat !== 'json_object') return user;
    if (task === 'NARRATE') return user;
    return withJsonInstruction(user, schema ?? undefined);
  }

  private responseFormat(
    task: Task,
    schema: Readonly<Record<string, unknown>> | null,
  ): Record<string, unknown> | null {
    if (schema === null || task === 'NARRATE') return null;
    if (this.config.responseFormat === 'json_object') return { type: 'json_object' };
    return {
      type: 'json_schema',
      json_schema: { name: `${task.toLowerCase()}_proposal`, strict: true, schema },
    };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.apiKey !== undefined && this.config.apiKey.length > 0) {
      headers['authorization'] = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }

  /**
   * The per-call base URL wins over the configured one, so a region is never baked into an
   * instance. An adapter with neither is refused here rather than shipping a relative URL to
   * `fetch`, which would fail with a confusing "Failed to parse URL" instead of naming the problem.
   */
  private baseUrlFor(input: { readonly baseUrl?: string }): string {
    const perCall = input.baseUrl ?? '';
    const baseUrl = perCall.length > 0 ? perCall : (this.config.baseUrl ?? '');
    if (baseUrl.length === 0) {
      throw new AiRequestError(
        'ENDPOINT_NOT_CONFIGURED',
        `no base URL is configured for ${this.endpoint}, on the call or on the adapter`,
        this.name,
        null,
      );
    }
    return baseUrl;
  }

  private timeoutFor(task: Task): number {
    return this.config.timeouts?.[task] ?? TASK_TIMEOUTS_MS[task];
  }
}

/** `/embeddings` on an OpenAI-compatible runtime. */
export const DEFAULT_EMBED_PATH = '/v1/embeddings';

/** Join a base URL and a path without doubling or dropping the separator. */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  if (path.length === 0) return base;
  return path.startsWith('/') ? `${base}${path}` : `${base}/${path}`;
}

/**
 * Re-map the model's placeholder ids back to the real ones.
 *
 * A placeholder that is not in the map is a **fabricated** id and is passed through unchanged so
 * {@link validateClassifyProposal} records the escape and nulls the category (docs/04 §6.2) —
 * silently treating it as "no answer" would hide exactly the event we monitor for.
 */
function toClassifyProposal(raw: Record<string, unknown>, map: RedactionMap): ClassifyProposal {
  const rawCategoryId = typeof raw['categoryId'] === 'string' ? raw['categoryId'] : null;
  const categoryId = resolveId(map, rawCategoryId) ?? rawCategoryId;

  const alternatives = Array.isArray(raw['alternatives'])
    ? raw['alternatives'].flatMap((entry) => {
        if (entry === null || typeof entry !== 'object') return [];
        const source = entry as Record<string, unknown>;
        const rawId = typeof source['categoryId'] === 'string' ? source['categoryId'] : null;
        const resolved = resolveId(map, rawId) ?? rawId;
        if (resolved === null) return [];
        return [{ categoryId: resolved, confidence: clampConfidence(source['confidence']) }];
      })
    : [];

  const needsUserInput = Array.isArray(raw['needsUserInput'])
    ? raw['needsUserInput'].flatMap((entry) => {
        if (entry === null || typeof entry !== 'object') return [];
        const source = entry as Record<string, unknown>;
        return [
          {
            field: sanitiseText(source['field'], MAX_EXTRACTED_TEXT_CHARS),
            question: sanitiseText(source['question'], MAX_EXTRACTED_TEXT_CHARS),
          },
        ];
      })
    : [];

  return {
    categoryId,
    confidence: clampConfidence(raw['confidence']),
    rationale: sanitiseText(raw['rationale'], MAX_EXTRACTED_TEXT_CHARS),
    alternatives,
    extracted: validateExtracted(raw['extracted']),
    ...(needsUserInput.length === 0 ? {} : { needsUserInput }),
  };
}

function toOcrLines(raw: unknown): OcrLine[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return [];
    const source = entry as Record<string, unknown>;
    const text = sanitiseText(source['text'], MAX_EXTRACTED_TEXT_CHARS);
    if (text.length === 0) return [];
    return [{ text, amountMinor: minorUnitsString(source['amountMinor']) }];
  });
}

/** The `/embeddings` response: `data: [{ embedding: number[] }]`, in request order. */
function readEmbeddings(body: unknown): number[][] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    throw new AiRequestError(
      'MALFORMED_RESPONSE',
      'embeddings response had no data array',
      'LOCAL',
      null,
    );
  }
  return data.map((entry, index) => {
    const embedding = (entry as { embedding?: unknown } | null)?.embedding;
    if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === 'number')) {
      throw new AiRequestError(
        'MALFORMED_RESPONSE',
        `embedding ${index} was not an array of numbers`,
        'LOCAL',
        null,
      );
    }
    return embedding as number[];
  });
}

