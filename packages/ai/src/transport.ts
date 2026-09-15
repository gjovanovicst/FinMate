/**
 * HTTP transport for the adapters: the documented timeout budget, the single retry, and the
 * transient/permanent distinction.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §9 — "Timeouts (2 s parse/classify, 8 s narrate,
 * 20 s OCR) with one retry on transient failure only."
 *
 * ## One fetch implementation, injected
 *
 * AGENTS.md rule 9 makes a vendor SDK a new dependency needing an ADR, and ADR-007 needs providers
 * to be symmetric — so the adapters are thin `fetch` + JSON and the fetch implementation is
 * **injected**. In production the caller passes the global `fetch`; in tests a stub. Nothing in
 * this package's test suite touches the network, which also means the suite passes in CI where
 * every API key in `.env` is empty.
 *
 * ## The budget covers the task, not the attempt
 *
 * `timeoutMs` is the wall-clock budget for the **whole** task call, retry included. A retry only
 * happens if the first attempt failed in time to leave room for a second one, and the second
 * attempt is given `min(full budget, remaining budget)`. That is what makes "2 s parse" true rather
 * than "2 s per attempt, 4 s worst case".
 *
 * ## What is transient
 *
 * | Failure | Transient? | Why |
 * |---|---|---|
 * | `fetch` rejects (DNS, refused, TLS, reset) | yes | The provider was never reached; retrying is the only remedy and costs nothing upstream |
 * | the per-task timeout fires (`AbortError`) | yes | A slow response is a load symptom that is often gone a moment later |
 * | 429 | yes | Rate limiting is explicitly "try again"; we honour it exactly once so we are not the client that gets banned |
 * | 408 / 425 | yes | Request timeout / too-early are retryable by definition |
 * | any 5xx | yes | Server-side; the request was well-formed |
 * | 400, 401, 403, 422 | **no** | A malformed payload or a bad key cannot be fixed by sending it again — and retrying a 401 is how a process earns a rate limit for nothing |
 * | any other 4xx | **no** | Same reasoning, defaulting to the safe side: a 4xx is our bug |
 * | a 2xx body that is not the expected JSON | **no** | Non-deterministic provider output is not a transport failure. The adapter raises `MALFORMED_RESPONSE` and the call fails immediately — retrying would mask a schema break |
 *
 * @module @finmate/ai
 */

import { AiRequestError, AiTransientError, type AiErrorCode } from './errors';
import type { ProviderName } from './provider';

/** The subset of the Fetch API this package uses. Injected, so no test needs the network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpRequest {
  readonly url: string;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  /** JSON-serialised by the transport, so a body is never double-encoded. */
  readonly body: unknown;
  /** Wall-clock budget for the whole call, retry included. */
  readonly timeoutMs: number;
}

export interface HttpResponse {
  readonly status: number;
  /** Parsed JSON, or `null` when the body was empty or was not JSON. */
  readonly json: unknown;
  /** Raw body text, retained so a non-JSON error page is reportable. */
  readonly text: string;
}

/** The successful outcome of one shipped call, plus what the caller should record about it. */
export interface HttpAttempt {
  readonly response: HttpResponse;
  /** How many retries were spent: 0 means the first attempt succeeded. */
  readonly retryCount: number;
  /** Wall-clock ms across every attempt, for `classification_decisions.latency_ms`. */
  readonly latencyMs: number;
  readonly model: string | null;
}

export class HttpTransport {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(fetchImpl: FetchLike, now: () => number = Date.now) {
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  /**
   * POST JSON with the task's budget and at most one retry.
   *
   * @throws {AiTransientError} after the retry is exhausted, or immediately when the failure was
   *   transient but the budget could not fit a second attempt.
   * @throws {AiRequestError} for a non-retryable status or an unexpected 2xx body.
   */
  async post(
    provider: ProviderName,
    model: string | null,
    request: HttpRequest,
    parseBody: (response: HttpResponse) => unknown,
  ): Promise<{ readonly value: unknown; readonly attempt: HttpAttempt }> {
    const startedAt = this.now();
    let retryCount = 0;
    let lastTransient: AiTransientError | null = null;
    // The budget the most recent attempt actually ran under, so the timeout error can name it.
    let attemptBudgetMs = request.timeoutMs;

    for (;;) {
      const remaining = request.timeoutMs - (this.now() - startedAt);
      if (remaining <= 0) {
        // The first attempt used the whole budget. There is no second one to be had.
        throw new AiTransientError(
          'TIMEOUT',
          `exceeded the ${request.timeoutMs} ms budget before attempt ${retryCount + 1} completed`,
          provider,
          null,
          retryCount + 1,
        );
      }

      attemptBudgetMs = remaining;

      try {
        const response = await this.attempt(request, remaining);
        const latencyMs = this.now() - startedAt;

        if (isTransientStatus(response.status)) {
          lastTransient = new AiTransientError(
            'TRANSIENT_HTTP',
            `HTTP ${response.status}: ${truncate(response.text)}`,
            provider,
            response.status,
            retryCount + 1,
          );
        } else if (!isSuccess(response.status)) {
          throw new AiRequestError(
            'NON_RETRYABLE_HTTP',
            `HTTP ${response.status}: ${truncate(response.text)}`,
            provider,
            response.status,
          );
        } else {
          const value = parseBody(response);
          return { value, attempt: { response, retryCount, latencyMs, model } };
        }
      } catch (error) {
        if (error instanceof AiRequestError) throw error;
        if (error instanceof AiTransientError) {
          lastTransient = error;
        } else if (isAbort(error)) {
          // Our own `AbortController` fired: the attempt ran out of the task's budget. Named
          // TIMEOUT rather than CONNECTION_FAILED so a caller can tell a slow provider from an
          // unreachable one — the two have different fixes.
          lastTransient = new AiTransientError(
            'TIMEOUT',
            `aborted after ${String(attemptBudgetMs)} ms of the ${String(request.timeoutMs)} ms budget`,
            provider,
            null,
            retryCount + 1,
          );
        } else {
          // A rejected `fetch`: DNS, connection refused, TLS, reset. Transient by definition.
          lastTransient = new AiTransientError(
            'CONNECTION_FAILED',
            error instanceof Error ? error.message : String(error),
            provider,
            null,
            retryCount + 1,
          );
        }
      }

      if (retryCount >= 1) throw lastTransient ?? unexpected();
      if (this.now() - startedAt >= request.timeoutMs) throw lastTransient ?? unexpected();
      retryCount += 1;
    }
  }

  /** One attempt, with an `AbortController` bound to the remaining budget. */
  private async attempt(request: HttpRequest, budgetMs: number): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);

    try {
      const response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });
      const text = await response.text();
      return { status: response.status, json: safeJson(text), text };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 429, 408, 425 and every 5xx. This is the whole of the transient line. */
export function isTransientStatus(status: number): boolean {
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500 && status <= 599;
}

/** Non-retryable by default: 400, 401, 403, 422, and any other 4xx we did not anticipate. */
export function isNonRetryableStatus(status: number): boolean {
  return !isSuccess(status) && !isTransientStatus(status);
}

export function isSuccess(status: number): boolean {
  return status >= 200 && status <= 299;
}

/** The `AiErrorCode` a status maps to, for telemetry and for the caller's branch. */
export function errorCodeForStatus(status: number): AiErrorCode {
  return isTransientStatus(status) ? 'TRANSIENT_HTTP' : 'NON_RETRYABLE_HTTP';
}

/** Unreachable in practice; it keeps `throw` total under `strict` without an `as` cast. */
function unexpected(): AiTransientError {
  return new AiTransientError('CONNECTION_FAILED', 'no attempt was made', 'LOCAL', null, 0);
}

/** True when an error is an `AbortError` — ours, since we own the only `AbortController`. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function safeJson(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Provider error bodies can be long; a log line should not be. */
function truncate(text: string, limit = 300): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
