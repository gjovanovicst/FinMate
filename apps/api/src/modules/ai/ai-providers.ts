/**
 * The AI composition root — config → routing table → adapters → the injected seams.
 *
 * Owner: docs/04 §9 (the routing table), ADR-007, ADR-031 decision 6.
 *
 * ## What was missing, and why it was not a small thing
 *
 * `AI_PARSE_PRIMARY` and its three siblings were validated at boot and then read by nothing.
 * `AI_CLASSIFIER`, `NARRATOR`, `OCR` and `EMBEDDINGS` resolved to their unconfigured twins in four
 * separate modules, and no code in `apps/` had ever called a provider factory. A live credential in
 * `.env` changed nothing, because there was no path from configuration to a socket. This module is
 * that path, and it is the only place in the application that reads a model's host or key.
 *
 * ## Inertness is a property, not a default
 *
 * With no endpoint usable — every primary `LOCAL` and no `LOCAL_AI_BASE_URL`, which is exactly the
 * shipped `.env.example` — {@link assembleAi} routes nothing, {@link buildAiRouter} returns `null`,
 * and every seam keeps its honest `UNCONFIGURED_*` implementation. So a deployment that has
 * configured no model behaves precisely as it did before this module existed: rules and keywords,
 * instantly, with no socket and no latency. That matters because the alternative — routing `LOCAL`
 * at a sidecar nobody started — would add a refused connection to every unmatched fragment.
 *
 * ## Residency is not checked here, it is *enabled* here
 *
 * The router refuses a non-EEA endpoint unless a consent gate is installed, and asks that gate on
 * every call (ADR-031). This module installs `ConsentsService` as that gate, always — an endpoint
 * outside the EEA is then reachable only for a Household that has recorded consent for the purpose
 * the task carries. A table that names one and has no gate cannot even be constructed.
 *
 * @module apps/api/src/modules/ai
 */

import { Logger } from '@nestjs/common';

import {
  ENDPOINTS,
  REQUIRES_CONFIGURED_BASE_URL,
  UNIMPLEMENTED_ENDPOINTS,
  createDeepSeekProvider,
  createLocalProvider,
  createOpenAiProvider,
  isKnownEndpoint,
  AiRouter,
  type AiProvider,
  type Endpoint,
  type FetchLike,
  type ConsentGate,
  type RoutingTable,
  type Task,
  type TaskRoute,
} from '@finmate/ai';

import type { AppConfig } from '../../config/config';
import { RoutedAiClassifier, UNCONFIGURED_AI_CLASSIFIER, type AiClassifier } from '../classification/ai-classifier';
import { UNCONFIGURED_EMBEDDINGS, type EmbeddingProvider } from '../classification/embedding-provider';
import { RoutedNarrator, UNCONFIGURED_NARRATOR, type AssistantNarrator } from '../assistant/assistant-narrator';
import { RoutedOcrService, UNCONFIGURED_OCR, type OcrService } from '../receipts/ocr';

/** The four tasks the platform routes, in docs/04 §9's order. `EMBED` is local-only by design. */
export const ROUTED_TASKS = ['PARSE', 'CLASSIFY', 'NARRATE', 'OCR'] as const satisfies readonly Task[];

/** Why a task ended up unrouted. Diagnostic only — never user-facing copy. */
export interface SkippedRoute {
  readonly task: Task;
  readonly configured: string;
  readonly reason: string;
}

export interface AiAssembly {
  /** Only the tasks with a usable endpoint. An absent task is unrouted, not an error. */
  readonly routing: RoutingTable;
  readonly providers: Readonly<Partial<Record<Endpoint, AiProvider>>>;
  readonly routedTasks: readonly Task[];
  readonly skipped: readonly SkippedRoute[];
}

/** The config key that names a task's primary, per docs/04 §9's four routed tasks. */
const PRIMARY_KEY = {
  PARSE: 'AI_PARSE_PRIMARY',
  CLASSIFY: 'AI_CLASSIFY_PRIMARY',
  NARRATE: 'AI_NARRATE_PRIMARY',
  OCR: 'AI_OCR_PRIMARY',
} as const satisfies Record<(typeof ROUTED_TASKS)[number], keyof AppConfig>;

/**
 * Build the routing table and one adapter per endpoint the configuration actually reaches.
 *
 * Pure and synchronous on purpose: it takes a validated {@link AppConfig} and a `fetch`, returns a
 * value, and touches nothing global. That is what lets `ai-providers.spec.ts` assert every claim
 * below — including "a live DeepSeek key with no consent still produces no call" — without a
 * database, a network, or a Nest module.
 */
export function assembleAi(config: AppConfig, fetchImpl: FetchLike): AiAssembly {
  const routing: Partial<Record<Task, TaskRoute>> = {};
  const providers: Partial<Record<Endpoint, AiProvider>> = {};
  const routedTasks: Task[] = [];
  const skipped: SkippedRoute[] = [];

  for (const task of ROUTED_TASKS) {
    const configured = config[PRIMARY_KEY[task]];

    if (!isKnownEndpoint(configured)) {
      // Unreachable through `loadConfig`, which refuses an unknown endpoint at boot. Kept because
      // `AppConfig` can be constructed by a test without the shape check, and a silent skip is the
      // one behaviour this module must never have.
      skipped.push({ task, configured, reason: `not a known endpoint (${ENDPOINTS.join(', ')})` });
      continue;
    }

    const unusable = unusableReason(configured, config);
    if (unusable !== null) {
      skipped.push({ task, configured, reason: unusable });
      continue;
    }

    const endpoint = configured as Endpoint;
    providers[endpoint] ??= createProvider(endpoint, config, fetchImpl);
    routing[task] = { primary: endpoint, fallback: null };
    routedTasks.push(task);
  }

  return { routing, providers, routedTasks, skipped };
}

/** Why this endpoint cannot be used in this deployment, or `null` when it can. */
function unusableReason(endpoint: Endpoint, config: AppConfig): string | null {
  if (UNIMPLEMENTED_ENDPOINTS.includes(endpoint)) {
    return `no adapter exists for ${endpoint} yet (packages/ai's UNIMPLEMENTED_ENDPOINTS)`;
  }

  if (endpoint === 'LOCAL') {
    return config.LOCAL_AI_BASE_URL === undefined
      ? 'LOCAL_AI_BASE_URL is not set, so no local model is claimed to be running'
      : null;
  }

  if (endpoint === 'DEEPSEEK_GLOBAL') {
    return config.DEEPSEEK_API_KEY === undefined
      ? 'DEEPSEEK_API_KEY is not set'
      : null;
  }

  if (REQUIRES_CONFIGURED_BASE_URL.includes(endpoint)) {
    const baseUrl = baseUrlFor(endpoint, config);
    if (baseUrl === null) return `no base URL is configured for ${endpoint}`;
    if (endpoint === 'OPENAI_EU' && config.OPENAI_API_KEY === undefined) {
      return 'OPENAI_API_KEY is not set';
    }
    return null;
  }

  return `no adapter is implemented for ${endpoint}`;
}

/** The configured EEA host, or `null`. There is no fallback: a fallback would be a non-EEA host. */
function baseUrlFor(endpoint: Endpoint, config: AppConfig): string | null {
  switch (endpoint) {
    case 'DEEPSEEK_EU':
      return config.DEEPSEEK_EU_BASE_URL ?? null;
    case 'OPENAI_EU':
      return config.OPENAI_EU_BASE_URL ?? null;
    case 'ANTHROPIC_EU':
      return config.ANTHROPIC_EU_BASE_URL ?? null;
    case 'GEMINI_EU':
      return config.GEMINI_EU_BASE_URL ?? null;
    case 'LOCAL':
      return config.LOCAL_AI_BASE_URL ?? null;
    case 'DEEPSEEK_GLOBAL':
      // DeepSeek's own platform. The adapter owns the constant; naming it twice is how the two
      // copies drift, and this one would be the copy that lies (ADR-031).
      return null;
    default:
      return null;
  }
}

/** Construct the adapter for a usable endpoint. The key is read here and nowhere else. */
function createProvider(endpoint: Endpoint, config: AppConfig, fetch: FetchLike): AiProvider {
  switch (endpoint) {
    case 'LOCAL':
      return createLocalProvider({
        ...(config.LOCAL_AI_BASE_URL === undefined ? {} : { baseUrl: config.LOCAL_AI_BASE_URL }),
        fetch,
      });
    case 'DEEPSEEK_EU': {
      const baseUrl = baseUrlFor('DEEPSEEK_EU', config);
      return createDeepSeekProvider({
        endpoint: 'DEEPSEEK_EU',
        ...(baseUrl === null ? {} : { baseUrl }),
        ...(config.DEEPSEEK_API_KEY === undefined ? {} : { apiKey: config.DEEPSEEK_API_KEY }),
        fetch,
      });
    }
    case 'DEEPSEEK_GLOBAL':
      return createDeepSeekProvider({
        endpoint: 'DEEPSEEK_GLOBAL',
        ...(config.DEEPSEEK_API_KEY === undefined ? {} : { apiKey: config.DEEPSEEK_API_KEY }),
        fetch,
      });
    case 'OPENAI_EU': {
      const baseUrl = baseUrlFor('OPENAI_EU', config);
      return createOpenAiProvider({
        ...(baseUrl === null ? {} : { baseUrl }),
        ...(config.OPENAI_API_KEY === undefined ? {} : { apiKey: config.OPENAI_API_KEY }),
        fetch,
      });
    }
    case 'ANTHROPIC_EU':
    case 'GEMINI_EU':
      // `unusableReason` refuses these before we get here. Throwing rather than returning a
      // look-alike adapter is the same rule `UNIMPLEMENTED_ENDPOINTS` states: a vendor-specific wire
      // format is not implementable through the OpenAI-compatible class without lying about it.
      throw new Error(`${endpoint} has no adapter; it must be refused before a provider is built.`);
  }
}

/**
 * The application's AI seams, assembled once.
 *
 * Every member is either the real implementation over the router or the honest `UNCONFIGURED_*`
 * twin, and the choice is made from one fact: **does the task have a usable endpoint?** Deriving it
 * from the routing table rather than from the config value is deliberate — it is the same table the
 * router will read, so a seam cannot claim a provider the router has no route to.
 *
 * `EMBEDDINGS` is always the unconfigured twin, and that is not an omission. rung 5 needs a *model
 * and a width* (`entity_embeddings.embedding` is `vector(384)`), not a host and a key: ADR-021 defers
 * the model, and an adapter built from `LOCAL_AI_BASE_URL` alone would have to invent a dimension.
 * A provider of the wrong width is worse than none — every `INSERT` fails, one row at a time.
 */
export interface AiSeams {
  /** `null` when no task has a usable endpoint: nothing to construct, nothing to break a circuit. */
  readonly router: AiRouter | null;
  readonly assembly: AiAssembly;
  readonly classifier: AiClassifier;
  readonly narrator: AssistantNarrator;
  readonly ocr: OcrService;
  readonly embeddings: EmbeddingProvider;
}

/**
 * Assemble and log. The log line exists because "why is the AI not doing anything?" has three
 * different answers — no key, no consent, no route — and an operator should not have to guess which.
 */
export function makeAiSeams(config: AppConfig, fetchImpl: FetchLike, gate: ConsentGate): AiSeams {
  const logger = new Logger('AiSeams');
  const assembly = assembleAi(config, fetchImpl);
  const router =
    assembly.routedTasks.length === 0
      ? null
      : new AiRouter({ routing: assembly.routing, providers: assembly.providers, consent: gate });

  if (router === null) {
    logger.log(
      'No AI endpoint is configured; the pipeline runs on rules and keywords (docs/04 §9). ' +
        assembly.skipped.map((skip) => `${skip.task}: ${skip.reason}`).join('; '),
    );
  } else {
    logger.log(
      `AI routes: ${assembly.routedTasks
        .map((task) => `${task}→${String(assembly.routing[task]?.primary)}`)
        .join(', ')}. A non-EEA endpoint is called only for a Household with recorded consent ` +
        `(ADR-007, ADR-031).`,
    );
    for (const skip of assembly.skipped) {
      logger.log(`${skip.task} is unrouted: ${skip.reason}`);
    }
  }

  return {
    router,
    assembly,
    classifier:
      router !== null && router.endpoints('CLASSIFY').length > 0
        ? new RoutedAiClassifier(router)
        : UNCONFIGURED_AI_CLASSIFIER,
    narrator:
      router !== null && router.endpoints('NARRATE').length > 0
        ? new RoutedNarrator(router)
        : UNCONFIGURED_NARRATOR,
    ocr:
      router !== null && router.endpoints('OCR').length > 0
        ? new RoutedOcrService(router)
        : UNCONFIGURED_OCR,
    embeddings: UNCONFIGURED_EMBEDDINGS,
  };
}
