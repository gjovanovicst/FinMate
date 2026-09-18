/**
 * Factories for the endpoints docs/04 §9 names, built on the shared OpenAI-compatible adapter.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §9 (the endpoint union and the routing table)
 *
 * ## One wire implementation, four endpoint configurations
 *
 * `OPENAI_EU`, `DEEPSEEK_EU` and `LOCAL` all speak OpenAI-compatible chat completions, so they are
 * the same class with different paths, auth and structured-output mode. That is the concrete
 * meaning of ADR-007's "the provider is swappable": adding an endpoint is a factory, not a feature
 * module change. `ANTHROPIC_EU` has a different wire format and is deliberately **not** stubbed
 * here with a shared-shaped class that would lie about compatibility — see the note on
 * {@link createAnthropicProvider}.
 *
 * ## Keys are read by the caller, never by this package
 *
 * A package that reaches into `process.env` cannot be unit-tested without mutating global state and
 * quietly couples a library to one deployment's variable names. Every factory takes its key as an
 * argument; `apps/api/src/config/config.ts` owns the names (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`,
 * `LOCAL_AI_BASE_URL`) and passes them in. In this repository every key in `.env` is **empty** and
 * CI has none, which is exactly why the test suite injects a stub fetch and never makes a request.
 *
 * @module @finmate/ai
 */

import type { Endpoint } from '../endpoints';
import type { Task } from '../provider';
import { HttpTransport, type FetchLike } from '../transport';
import {
  OpenAiCompatibleProvider,
  TASK_TIMEOUTS_MS,
  type OpenAiCompatibleConfig,
} from './openai-compatible';

/** Re-exported so a caller configuring an endpoint sees the budgets beside the factories. */
export { TASK_TIMEOUTS_MS };

/** docs/04 §9's `DEEPSEEK_EU`: OpenAI-compatible, JSON mode (no provider-enforced schema). */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
/** `deepseek-chat` is the general instruction model; §12 prices it as the cheap fallback. */
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-chat';

/** docs/04 §9's `OPENAI_EU`: structured outputs, so the schema is transmitted. */
export const OPENAI_BASE_URL = 'https://api.openai.com';
export const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';

/**
 * The local sidecar's default address (docs/08 §6.8 — Ollama / `llama.cpp` on the same node,
 * reachable only on the private Docker network). The host is configurable; this is only the
 * development default, and nothing in this repository is listening on it.
 */
export const LOCAL_AI_DEFAULT_BASE_URL = 'http://localhost:11434';
export const LOCAL_DEFAULT_MODEL = 'qwen2.5:3b-instruct';

/** The embedding model is local-only; `EMBED` never leaves the node (docs/08 §6.5). */
export const LOCAL_DEFAULT_EMBED_MODEL = 'nomic-embed-text';

/**
 * A vision model for the local OCR path. Separate from {@link LOCAL_DEFAULT_MODEL} because a text
 * instruct model cannot read a Receipt image, and pointing `LOCAL` at one for OCR would be a
 * configuration that looks configured and silently fails at the first receipt.
 */
export const LOCAL_DEFAULT_OCR_MODEL = 'qwen2.5vl:3b';

/** What a caller must supply to build an endpoint's adapter. */
export interface EndpointAdapterOptions {
  /** Host only, e.g. `https://api.deepseek.com`. */
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly fetch: FetchLike;
  /** Model id per task, overriding the endpoint's defaults. */
  readonly models?: Partial<Record<Task, string>>;
  readonly extraBody?: Readonly<Record<string, unknown>>;
  readonly timeouts?: Partial<Record<Task, number>>;
  /**
   * The clock the transport uses for the timeout budget and for `latency_ms`.
   *
   * Injectable for the same reason the fold is injected in `packages/rules-engine`: a value the
   * caller must be able to control in a test is not allowed to be a hidden global. The default is
   * `Date.now`.
   */
  readonly now?: () => number;
}

/**
 * `DEEPSEEK_EU`. OpenAI-compatible wire, `json_object` mode, `/chat/completions` (no `/v1`).
 *
 * The weaker JSON mode is not a shortcut: DeepSeek does not offer OpenAI's `json_schema` response
 * format, so the schema is enforced on parse by {@link ../validation} instead. That is the whole
 * reason validation lives outside the adapter.
 */
export function createDeepSeekProvider(
  options: EndpointAdapterOptions & { readonly endpoint?: 'DEEPSEEK_EU' | 'DEEPSEEK_GLOBAL' },
): OpenAiCompatibleProvider {
  // ADR-031: `baseUrl` has **no default** for `DEEPSEEK_EU`. It used to fall back to DeepSeek's own
  // platform, which is in China — so `_EU` was a suffix on a host that was elsewhere, and the boot
  // guard in `apps/api` passed it. An EEA endpoint without a configured EEA host is now unusable
  // instead of quietly non-compliant; `DEEPSEEK_GLOBAL` is the same wire with an honest name.
  const endpoint = options.endpoint ?? 'DEEPSEEK_GLOBAL';
  const config: OpenAiCompatibleConfig = {
    endpoint,
    provider: 'DEEPSEEK',
    baseUrl: options.baseUrl ?? DEEPSEEK_BASE_URL,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    path: '/chat/completions',
    responseFormat: 'json_object',
    ...(options.now === undefined ? {} : { now: options.now }),
    // `NARRATE` as well as the two classification tasks: docs/04 §9 routes it, the interface requires
    // it, and a factory that omits it turns a legitimate narration route — an EEA host, or a
    // non-EEA one this Household has consented to — into `TASK_NOT_SUPPORTED` at runtime, which the
    // assistant can only answer with the template. `LOCAL` declared every task it serves from the
    // start; the two cloud factories did not, and the gap was found live on `/assistant` (2026-09-17).
    models: {
      PARSE: DEEPSEEK_DEFAULT_MODEL,
      CLASSIFY: DEEPSEEK_DEFAULT_MODEL,
      NARRATE: DEEPSEEK_DEFAULT_MODEL,
      ROUTE: DEEPSEEK_DEFAULT_MODEL,
      ...options.models,
    },
    ...(options.extraBody === undefined ? {} : { extraBody: options.extraBody }),
    ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
  };
  return new OpenAiCompatibleProvider(config, transport(options));
}

/**
 * `OPENAI_EU`. Structured outputs (`json_schema`, `strict`), `/v1/chat/completions`.
 *
 * `supportsEmbed` is false: embeddings for this product are `LOCAL`-only by rule (docs/04 §9), and
 * an adapter that offered them would make the rule look optional.
 */
export function createOpenAiProvider(options: EndpointAdapterOptions): OpenAiCompatibleProvider {
  const config: OpenAiCompatibleConfig = {
    endpoint: 'OPENAI_EU',
    provider: 'OPENAI',
    // Same rule as DeepSeek's (ADR-031): the OpenAI *platform* is not an EEA host, so a caller that
    // names `OPENAI_EU` must supply the base URL of the regional deployment it means.
    baseUrl: options.baseUrl ?? OPENAI_BASE_URL,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    path: '/v1/chat/completions',
    responseFormat: 'json_schema',
    ...(options.now === undefined ? {} : { now: options.now }),
    // Same three chat tasks as DeepSeek's (see the note there): `NARRATE` belongs to the endpoint's
    // model list, not to a capability flag.
    models: {
      PARSE: OPENAI_DEFAULT_MODEL,
      CLASSIFY: OPENAI_DEFAULT_MODEL,
      NARRATE: OPENAI_DEFAULT_MODEL,
      ROUTE: OPENAI_DEFAULT_MODEL,
      ...options.models,
    },
    supportsOcr: true,
    supportsEmbed: false,
    ...(options.extraBody === undefined ? {} : { extraBody: options.extraBody }),
    ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
  };
  return new OpenAiCompatibleProvider(config, transport(options));
}

/**
 * `LOCAL`. The privacy-maximising path and the only one with genuinely zero egress (docs/08 §6.8).
 *
 * No `Authorization` header is sent when no key is given, because a sidecar runtime on the private
 * Docker network does not authenticate and sending an empty bearer token to it is noise. The
 * adapter is `supportsEmbed: true` — `EMBED` is `LOCAL`-only, so this is the only adapter that may
 * offer it.
 */
export function createLocalProvider(options: EndpointAdapterOptions): OpenAiCompatibleProvider {
  const config: OpenAiCompatibleConfig = {
    endpoint: 'LOCAL',
    provider: 'LOCAL',
    baseUrl: options.baseUrl ?? LOCAL_AI_DEFAULT_BASE_URL,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    path: '/v1/chat/completions',
    responseFormat: 'json_schema',
    ...(options.now === undefined ? {} : { now: options.now }),
    models: {
      PARSE: LOCAL_DEFAULT_MODEL,
      CLASSIFY: LOCAL_DEFAULT_MODEL,
      NARRATE: LOCAL_DEFAULT_MODEL,
      ROUTE: LOCAL_DEFAULT_MODEL,
      OCR: LOCAL_DEFAULT_OCR_MODEL,
      EMBED: LOCAL_DEFAULT_EMBED_MODEL,
      ...options.models,
    },
    supportsOcr: true,
    supportsEmbed: true,
    ...(options.extraBody === undefined ? {} : { extraBody: options.extraBody }),
    ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
  };
  return new OpenAiCompatibleProvider(config, transport(options));
}

/** One place that builds the transport, so the injected clock cannot be forgotten. */
function transport(options: EndpointAdapterOptions): HttpTransport {
  return options.now === undefined
    ? new HttpTransport(options.fetch)
    : new HttpTransport(options.fetch, options.now);
}

/**
 * Endpoints docs/04 §9 routes to that have **no adapter in task 2.2.1**: `ANTHROPIC_EU`
 * (`NARRATE` primary) and `GEMINI_EU` (`OCR` fallback).
 *
 * Both speak a vendor-specific wire format, so they are not implementable through the
 * OpenAI-compatible adapter without lying about the compatibility that makes sharing it honest.
 * The router treats their absence as a typed `UNKNOWN_PROVIDER` provider failure and falls through
 * — which is the designed behaviour rather than a hole: `NARRATE` falls back to `LOCAL`, and
 * `OCR`'s cloud fallback is consent-gated in any case (docs/08 §6.5).
 *
 * Exported so a caller can assert "this endpoint has no adapter yet" deliberately, instead of
 * discovering it as a runtime failure on the first assistant question.
 */
export const UNIMPLEMENTED_ENDPOINTS: readonly Endpoint[] = ['ANTHROPIC_EU', 'GEMINI_EU'];

/**
 * Endpoints whose **base URL must be configured** — there is no default, because a default would be a
 * non-EEA host (ADR-031).
 *
 * `apps/api/src/config/config.ts` refuses to boot with one of these as a task primary unless its
 * `*_BASE_URL` is set, and {@link createDeepSeekProvider} takes the URL as a required input rather
 * than reading a constant. Both halves are needed: the check catches configuration, and the signature
 * makes the constant unwriteable.
 */
export const REQUIRES_CONFIGURED_BASE_URL: readonly Endpoint[] = [
  'DEEPSEEK_EU',
  'OPENAI_EU',
  'ANTHROPIC_EU',
  'GEMINI_EU',
];
