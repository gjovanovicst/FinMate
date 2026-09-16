/**
 * Typed errors for the AI package.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §9, docs/08-security-privacy-and-compliance.md §6
 *
 * Three classes, deliberately separated by *who is at fault and what the caller should do*:
 *
 * - {@link AiRoutingError} — the **configuration** is unsafe (an endpoint outside the EEA for a
 *   task that carries Household data, or `EMBED` pointed off-box). This is a hard refusal: it is
 *   raised from `validateRouting` before any adapter is constructed, so a residency typo fails at
 *   startup and again per call rather than becoming a Chapter V transfer (AGENTS.md rule 5,
 *   ADR-007). It is never retried and never degraded around.
 * - {@link AiRequestError} — the **request or the credential** is wrong: 400, 401, 403, 422. A
 *   retry cannot fix a malformed payload or a bad key, and retrying a 401 is how a process gets
 *   rate-limited for nothing. Surfaced unresolved so an operator sees it.
 * - {@link AiTransientError} — the **transport** failed in a way that a retry may fix: a connection
 *   error, the documented per-task timeout, 429, or a 5xx. Thrown only after the single retry is
 *   exhausted; the router treats it as a provider failure and advances the degradation ladder.
 *
 * `AiUnavailableError` is the router's fourth case: every configured endpoint for the task failed,
 * was short-circuited, or does not implement the task. It carries the {@link ProviderFailure}s so
 * the caller can log *why* rather than reporting a bare "AI is down".
 *
 * @module @finmate/ai
 */

import type { ProviderName, Task } from './provider';

/** Every way a call can fail, as a value a caller can branch on. */
export type AiErrorCode =
  /** No endpoint is configured for this task at all (`EMBED` with no local model). */
  | 'NO_ENDPOINT'
  /** The provider for the configured endpoint is newer than the adapter, or simply absent. */
  | 'UNKNOWN_PROVIDER'
  /** The adapter exists but does not implement the task (docs/04 §9 optional `ocr`/`embed`). */
  | 'TASK_NOT_SUPPORTED'
  /** The endpoint is neither `LOCAL` nor `*_EU`, so the task would be a Chapter V transfer. */
  | 'RESIDENCY_VIOLATION'
  /** `EMBED` was pointed anywhere but `LOCAL`. Its vectors are built from Household names. */
  | 'EMBED_MUST_BE_LOCAL'
  /** The whole routing table failed up-front validation. */
  | 'INVALID_ROUTING_TABLE'
  /** A per-task timeout elapsed (2 s parse/classify, 8 s narrate, 20 s OCR). */
  | 'TIMEOUT'
  /** `fetch` rejected: DNS, refused connection, TLS, reset. */
  | 'CONNECTION_FAILED'
  /** 429 or 5xx — retried once, then given up on. */
  | 'TRANSIENT_HTTP'
  /** 400, 401, 403, 422 — a retry cannot help, so none is made. */
  | 'NON_RETRYABLE_HTTP'
  /** A 2xx body that is not the JSON shape the adapter is schema-bound to expect. */
  | 'MALFORMED_RESPONSE'
  /** The task call itself has no endpoint (e.g. `LOCAL` configured but no base URL). */
  | 'ENDPOINT_NOT_CONFIGURED';

/**
 * Why an endpoint was **not** tried, as opposed to why it failed.
 *
 * `CONSENT_DECLINED` is deliberately a member of this union rather than a fourth error class: it is
 * not a fault, and it is not thrown. It is the recorded answer to ADR-007's question — "may this
 * Household's text reach a non-EEA endpoint?" — and the router turns a `false` into a skipped
 * endpoint and a `CONSENT_DECLINED` degradation reason (docs/08 §6.6, ADR-031).
 */
export type ProviderFailureReason = AiErrorCode | 'CIRCUIT_OPEN' | 'CONSENT_DECLINED';

/** The routing configuration violates the residency rule and was refused. */
export class AiRoutingError extends Error {
  readonly code: AiErrorCode;
  readonly task: Task;
  /** The offending endpoint as configured, or `null` when the whole table is at fault. */
  readonly endpoint: string | null;

  constructor(code: AiErrorCode, message: string, task: Task, endpoint: string | null = null) {
    super(`[${code}] ${message} (task ${task}${endpoint === null ? '' : `, endpoint ${endpoint}`})`);
    this.name = 'AiRoutingError';
    this.code = code;
    this.task = task;
    this.endpoint = endpoint;
  }
}

/** The request or credential is wrong. Not retryable and not a provider outage. */
export class AiRequestError extends Error {
  readonly code: AiErrorCode;
  readonly provider: ProviderName;
  /** The HTTP status, or `null` when the failure was not an HTTP response at all. */
  readonly status: number | null;

  constructor(code: AiErrorCode, message: string, provider: ProviderName, status: number | null) {
    super(`[${code}] ${provider}: ${message}${status === null ? '' : ` (HTTP ${status})`}`);
    this.name = 'AiRequestError';
    this.code = code;
    this.provider = provider;
    this.status = status;
  }
}

/** A retryable failure, thrown only after the single retry is exhausted. */
export class AiTransientError extends Error {
  readonly code: AiErrorCode;
  readonly provider: ProviderName;
  readonly status: number | null;
  /** How many attempts were made in total (1 = the first attempt failed and no retry was allowed). */
  readonly attempts: number;

  constructor(
    code: AiErrorCode,
    message: string,
    provider: ProviderName,
    status: number | null,
    attempts: number,
  ) {
    super(`[${code}] ${provider}: ${message}${status === null ? '' : ` (HTTP ${status})`}`);
    this.name = 'AiTransientError';
    this.code = code;
    this.provider = provider;
    this.status = status;
    this.attempts = attempts;
  }
}

/**
 * One endpoint's failure, kept for the caller's log and for the degradation reason.
 *
 * `message` is diagnostic only. It is deliberately **not** user-facing copy: no vendor name or
 * transport detail belongs in a toast, and the caller renders the ladder rung instead.
 */
export interface ProviderFailure {
  /** The endpoint that was tried, or skipped. */
  readonly endpoint: string;
  readonly provider: ProviderName | null;
  /**
   * `CIRCUIT_OPEN` when the breaker short-circuited before a call was made; `CONSENT_DECLINED` when
   * the Household's recorded consent did not admit this endpoint, so no call was made at all.
   */
  readonly reason: ProviderFailureReason;
  readonly message: string;
  /** True when the failure counts against the provider's circuit breaker. */
  readonly countsAgainstCircuit: boolean;
}

/**
 * Every configured endpoint for the task is unusable.
 *
 * This is not an error boundary in the caller's request path: it is the signal to drop to the
 * rules-only rung of the degradation ladder (docs/04 §9), which is a normal, expected outcome.
 */
export class AiUnavailableError extends Error {
  readonly code = 'NO_ENDPOINT' as const;
  readonly task: Task;
  readonly failures: readonly ProviderFailure[];

  constructor(task: Task, failures: readonly ProviderFailure[]) {
    const detail = failures
      .map((failure) => `${failure.endpoint} (${failure.reason}): ${failure.message}`)
      .join('; ');
    super(
      `[NO_ENDPOINT] no AI provider served ${task}` +
        (detail.length === 0 ? ' (nothing configured)' : ` — ${detail}`),
    );
    this.name = 'AiUnavailableError';
    this.task = task;
    this.failures = failures;
  }
}
