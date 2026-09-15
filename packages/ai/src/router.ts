/**
 * Declarative routing, circuit breaking and the degradation ladder.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §9 (routing table, circuit breaker, "Degradation
 * ladder"), §7 (what the user sees depends on the rung).
 *
 * ## The routing decision, end to end
 *
 * ```text
 * task ─▶ endpointsForTask(routing, task)   ─▶ [primary, fallback]
 *                                          ─▶ provider registry lookup → UNKNOWN_PROVIDER
 *                                          ─▶ adapter.supports(task)? → TASK_NOT_SUPPORTED
 *                                          ─▶ circuit.canAttempt()?   → CIRCUIT_OPEN
 *                                          ─▶ call with budget + one retry on transient only
 *                                          ─▶ success: close the circuit, return the Proposal
 *                                             failure: count it, advance to the fallback
 *                                          ─▶ exhausted: rules-only rung
 * ```
 *
 * ## The ladder is a *return value*, not a log line
 *
 * docs/04 §9's ladder is what the user is shown: full pipeline, or rules+keywords only because the
 * circuit is open, or deterministic extraction only because the parse failed, or the manual form.
 * "The user can always record a transaction. The AI never becomes a hard dependency for
 * correctness — only for convenience." So the rung is on every result, including the successful
 * ones, and {@link DEGRADATION_LADDER} is exported with its severity order so a caller can take the
 * worse of two rungs when it merges outcomes.
 *
 * ## Failure is returned, not thrown
 *
 * {@link AiRouter.invoke} resolves to a discriminated result. A caller in `scope:api` is
 * orchestrating a capture, and the *expected* outcome of an AI outage is a rules-only save — not an
 * exception that unwinds a request handler. Genuine configuration faults still throw: a routing
 * table that violates residency is refused by {@link validateRouting} before a router exists.
 *
 * @module @finmate/ai
 */

import { AiRequestError, AiTransientError, type AiErrorCode, type ProviderFailure } from './errors';
import {
  endpointsForTask,
  validateRouting,
  type Endpoint,
  type RoutingTable,
} from './endpoints';
import { CircuitBreakers, type CircuitBreakerOptions } from './circuit-breaker';
import {
  hasCallTask,
  TASKS,
  unaccountedTelemetry,
  type AiProvider,
  type CallTelemetry,
  type ProviderName,
  type Task,
} from './provider';

/**
 * docs/04 §9's ladder, worst-last so an index comparison is a severity comparison.
 *
 * `MANUAL_ENTRY` is not a failure of *this* package — the caller reaches it when its own
 * deterministic extraction produced nothing either. It is in the type because the caller needs one
 * vocabulary to render the right copy.
 */
export const DEGRADATION_LADDER = [
  'FULL_PIPELINE',
  'RULES_KEYWORDS_ONLY',
  'DETERMINISTIC_ONLY',
  'MANUAL_ENTRY',
] as const;

export type DegradationRung = (typeof DEGRADATION_LADDER)[number];

/** Numeric severity, for merging two outcomes into the worse one. Higher is more degraded. */
export function degradationRank(rung: DegradationRung): number {
  return DEGRADATION_LADDER.indexOf(rung);
}

/** The worse (more degraded) of two rungs. */
export function worstRung(a: DegradationRung, b: DegradationRung): DegradationRung {
  return degradationRank(a) >= degradationRank(b) ? a : b;
}

/**
 * Why a rung was reached, in the caller's terms.
 *
 * - `AI_UNUSED` — the task never needed a model (a rule matched, the parser succeeded).
 * - `CONSENT_DECLINED` — the caller withheld consent, so no call was attempted (docs/08 §6.7).
 * - `PROVIDER_UNAVAILABLE` — every endpoint failed, was short-circuited, or does not implement it.
 * - `PARSE_FAILED` — a parse call shipped but produced nothing usable.
 */
export type DegradationReason =
  | 'AI_UNUSED'
  | 'CONSENT_DECLINED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PARSE_FAILED';

/** A successful AI call: the Proposal plus everything the caller must record. */
export interface AiCallSuccess<T> {
  readonly ok: true;
  readonly value: T;
  /** `FULL_PIPELINE` — a model answered. */
  readonly rung: 'FULL_PIPELINE';
  readonly reason: 'AI_UNUSED';
  readonly endpoint: Endpoint;
  readonly provider: ProviderName;
  readonly telemetry: CallTelemetry;
  /** Failures of endpoints attempted *before* the one that succeeded, in order. */
  readonly failures: readonly ProviderFailure[];
  readonly task: Task;
}

/** A degraded outcome: no Proposal, and the rung the caller should render. */
export interface AiCallFailure {
  readonly ok: false;
  readonly rung: DegradationRung;
  readonly reason: DegradationReason;
  readonly task: Task;
  readonly failures: readonly ProviderFailure[];
  /** The first non-retryable failure, when there was one — the operator-actionable case. */
  readonly error: AiRequestError | null;
}

export type AiCallResult<T> = AiCallSuccess<T> | AiCallFailure;

export interface RouterOptions {
  /** The routing table. Validated here — a residency violation throws, it does not warn. */
  readonly routing: RoutingTable;
  /** Adapters by endpoint. A missing endpoint is a typed provider failure, not a crash. */
  readonly providers: Readonly<Partial<Record<Endpoint, AiProvider>>>;
  readonly circuit?: CircuitBreakerOptions;
}

/** Per-task dependencies the router needs to build the adapter input. */
export interface RouterDeps {
  /** Adapters, when they are resolved per call rather than held for the process's lifetime. */
  readonly providers?: Readonly<Partial<Record<Endpoint, AiProvider>>>;
}

/**
 * Routes one task call through the declared endpoints, breaking the circuit on repeated transport
 * failures and reporting which rung of the ladder the caller is on.
 */
export class AiRouter {
  readonly routing: RoutingTable;

  private readonly providers: Readonly<Partial<Record<Endpoint, AiProvider>>>;
  private readonly breakers: CircuitBreakers;

  constructor(options: RouterOptions) {
    // Fail closed: a table that would egress outside the EEA never produces a router at all.
    validateRouting(options.routing);
    this.routing = options.routing;
    this.providers = options.providers;
    this.breakers = new CircuitBreakers(options.circuit ?? {});
  }

  /** The endpoints that will be tried for a task, in order. */
  endpoints(task: Task): readonly Endpoint[] {
    return endpointsForTask(this.routing, task);
  }

  /** Breaker state for every endpoint used so far — for a health endpoint or a test. */
  circuitSnapshots(): ReturnType<CircuitBreakers['snapshots']> {
    return this.breakers.snapshots();
  }

  /**
   * Route a task call through the declared endpoints.
   *
   * `input` is passed through untouched to the adapter, which owns its own typing; the router
   * deliberately does not know what a `ClassifyInput` looks like, because routing is the same
   * decision for all five tasks.
   */
  async invoke<T>(task: Task, input: unknown): Promise<AiCallResult<T>> {
    const failures: ProviderFailure[] = [];

    for (const endpoint of this.endpoints(task)) {
      const provider = this.providers[endpoint];

      if (provider === undefined) {
        failures.push(failure(endpoint, null, 'UNKNOWN_PROVIDER', `no adapter is registered for ${endpoint}`));
        continue;
      }

      if (!supportsTask(provider, task)) {
        failures.push(
          failure(
            endpoint,
            provider.name,
            'TASK_NOT_SUPPORTED',
            `${provider.name} does not implement ${task}`,
          ),
        );
        continue;
      }

      const breaker = this.breakers.for(endpoint);
      if (!breaker.canAttempt()) {
        failures.push(
          failure(
            endpoint,
            provider.name,
            'CIRCUIT_OPEN',
            `circuit open; retrying after ${String(breaker.snapshot().opensUntil ?? 0)}`,
          ),
        );
        continue;
      }

      try {
        const result = await callProvider<T>(provider, task, input);
        breaker.recordSuccess();
        return {
          ok: true,
          value: result.value,
          rung: 'FULL_PIPELINE',
          reason: 'AI_UNUSED',
          endpoint,
          provider: provider.name,
          telemetry: result.telemetry,
          failures,
          task,
        };
      } catch (error) {
        const classified = classifyFailure(endpoint, provider.name, error);
        failures.push(classified.failure);
        if (classified.countsAgainstCircuit) {
          // A malformed 2xx body is a provider-quality failure: it counts, because a provider
          // returning unparseable JSON is not healthy even though its socket is.
          breaker.recordFailure();
        }
        if (!classified.advance) {
          // The request or the credential is wrong. The fallback provider would receive the same
          // bad payload and the same bad key story, so trying it is noise.
          return {
            ok: false,
            rung: rungForFailure(classified.failure.reason),
            reason: 'PROVIDER_UNAVAILABLE',
            task,
            failures,
            error: classified.error,
          };
        }
      }
    }

    return {
      ok: false,
      rung: 'RULES_KEYWORDS_ONLY',
      reason: 'PROVIDER_UNAVAILABLE',
      task,
      failures,
      error: null,
    };
  }
}

/**
 * Call the adapter, preferring its accounting-capable entry point.
 *
 * A provider that implements only the published `AiProvider` interface still works: its telemetry
 * is {@link unaccountedTelemetry}, which records `model: null` and `costMicros: 0` rather than a
 * guess. The one thing the router never does is drop the call.
 */
async function callProvider<T>(
  provider: AiProvider,
  task: Task,
  input: unknown,
): Promise<{ readonly value: T; readonly telemetry: CallTelemetry }> {
  if (hasCallTask(provider)) {
    return provider.callTask<T>(task, input);
  }
  switch (task) {
    case 'PARSE':
      return { value: (await provider.parse(input as never)) as T, telemetry: unaccountedTelemetry() };
    case 'CLASSIFY':
      return {
        value: (await provider.classify(input as never)) as T,
        telemetry: unaccountedTelemetry(),
      };
    case 'NARRATE':
      return {
        value: (await provider.narrate(input as never)) as T,
        telemetry: unaccountedTelemetry(),
      };
    case 'OCR': {
      if (provider.ocr === undefined) throw new AiRequestError('TASK_NOT_SUPPORTED', 'no ocr', provider.name, null);
      return { value: (await provider.ocr(input as never)) as T, telemetry: unaccountedTelemetry() };
    }
    case 'EMBED': {
      if (provider.embed === undefined) throw new AiRequestError('TASK_NOT_SUPPORTED', 'no embed', provider.name, null);
      return { value: (await provider.embed(input as never)) as T, telemetry: unaccountedTelemetry() };
    }
  }
}

/** True when the adapter both declares a model for the task and exposes the optional member. */
export function supportsTask(provider: AiProvider, task: Task): boolean {
  if (task === 'OCR' && provider.ocr === undefined) return false;
  if (task === 'EMBED' && provider.embed === undefined) return false;
  return true;
}

function failure(
  endpoint: Endpoint,
  provider: ProviderName | null,
  reason: AiErrorCode | 'CIRCUIT_OPEN',
  message: string,
): ProviderFailure {
  return {
    endpoint,
    provider,
    reason,
    message,
    countsAgainstCircuit: reason === 'TRANSIENT_HTTP' || reason === 'MALFORMED_RESPONSE',
  };
}

interface ClassifiedFailure {
  readonly failure: ProviderFailure;
  /** True when the circuit should record a failure for this endpoint. */
  readonly countsAgainstCircuit: boolean;
  /** True when the next endpoint should be tried. */
  readonly advance: boolean;
  readonly error: AiRequestError | null;
}

/**
 * Turn a thrown adapter error into a provider failure plus the two decisions that follow.
 *
 * Only two things count against a circuit: a **transient** failure (the retry already failed) and a
 * **malformed** 2xx body. A 400/401/403/422 says nothing about provider health — it says our
 * payload or key is wrong — so counting it would open a breaker whose half-open probe can never
 * succeed.
 */
export function classifyFailure(
  endpoint: Endpoint,
  provider: ProviderName,
  error: unknown,
): ClassifiedFailure {
  if (error instanceof AiTransientError) {
    return {
      failure: {
        endpoint,
        provider,
        reason: error.code,
        message: error.message,
        countsAgainstCircuit: true,
      },
      countsAgainstCircuit: true,
      advance: true,
      error: null,
    };
  }

  if (error instanceof AiRequestError) {
    // A malformed 2xx body is worth another provider — a different model may answer correctly.
    // A 400/401/403/422 is not: the next provider receives the same payload and the same story
    // about the credential, so trying it only doubles the noise and the latency.
    const malformed = error.code === 'MALFORMED_RESPONSE';
    return {
      failure: {
        endpoint,
        provider,
        reason: error.code,
        message: error.message,
        countsAgainstCircuit: malformed,
      },
      countsAgainstCircuit: malformed,
      advance: malformed,
      error,
    };
  }

  // Anything else is a bug in an adapter. Treat it as a provider failure so one broken adapter
  // cannot take down capture, but do not count it against a provider's health.
  return {
    failure: {
      endpoint,
      provider,
      reason: 'CONNECTION_FAILED',
      message: error instanceof Error ? error.message : String(error),
      countsAgainstCircuit: false,
    },
    countsAgainstCircuit: false,
    advance: true,
    error: null,
  };
}

/**
 * The rung a failure to even reach a provider implies.
 *
 * A provider outage is `RULES_KEYWORDS_ONLY`: rules and keyword scoring already ran and are
 * untouched by it (ADR-002). A failed **parse** is worse for the fragment because there is nothing
 * deterministic to fall back on, which is why the caller — not the router — decides when to drop to
 * `DETERMINISTIC_ONLY`: only the caller knows whether its own extractor produced anything.
 */
export function rungForFailure(_reason: AiErrorCode | 'CIRCUIT_OPEN'): DegradationRung {
  return 'RULES_KEYWORDS_ONLY';
}

/**
 * The rung for a parse result that shipped but returned nothing usable.
 *
 * Exported because it is the one ladder transition the caller must make from data rather than from
 * a failure, and it should be a named decision instead of an inline `if`.
 */
export function rungForParseProposal(
  proposal: { readonly ok: boolean },
  fallbackAvailable: boolean,
): DegradationRung {
  if (proposal.ok) return 'FULL_PIPELINE';
  return fallbackAvailable ? 'DETERMINISTIC_ONLY' : 'MANUAL_ENTRY';
}

/** Every task, so a caller can pre-warm breakers or report a health table without hardcoding. */
export const ROUTED_TASKS: readonly Task[] = TASKS;
