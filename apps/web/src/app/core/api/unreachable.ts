/**
 * The one definition of "nothing answered".
 *
 * Three places in this app have to tell a request that never reached a server from one a server
 * refused, and they must agree — otherwise a proxy with no upstream means "retry" to the queue, "an
 * internal error" to a screen, and "you are signed out" to the guard, and the user sees three stories
 * about one outage. The statuses are Angular's: `0` is a request that never arrived, and `502`/`503`/`504`
 * are a proxy with no healthy upstream (docs/15's dev-proxy note is the same fact).
 *
 * The outbox's own classifier stays separate on purpose: its policy is broader (any `5xx` is retryable),
 * because a queue may retry what a screen must not wait for. It is the *unreachable* arm they share, and
 * that is this function.
 *
 * See ADR-033, docs/15 and `error-message.service.ts`.
 *
 * @module apps/web/src/app/core/api
 */

/** Angular's `HttpErrorResponse.status` (or a plain object shaped like one), read structurally. */
export function readHttpStatus(error: unknown): number | null {
  if (error === null || typeof error !== 'object' || !('status' in error)) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

/**
 * Whether a failure means the request never reached an API — offline, DNS, a dead proxy.
 *
 * A `401` is deliberately **not** unreachable: it is an answer, and the app has to treat it as one
 * (ADR-033: only `UNREACHABLE` opens the offline shell).
 */
export function isUnreachable(error: unknown): boolean {
  const status = readHttpStatus(error);
  return status === 0 || status === 502 || status === 503 || status === 504;
}
