import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Request-scoped tenancy context — the enforcement point for ADR-008.
 *
 * `household_id` is resolved from the authenticated session and stored here for the lifetime of
 * the request. It is NEVER read from client input: a client may not name a Household in a
 * mutation, and there is no code path that would let it.
 *
 * The context is carried in `AsyncLocalStorage` rather than threaded through every function
 * signature, because threading it by hand is exactly the kind of thing that gets forgotten in one
 * code path — and one forgotten path is a cross-tenant leak (risk R-10).
 *
 * @module apps/api/src/common/tenancy
 */

export type MemberRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

export interface TenantContext {
  readonly householdId: string;
  readonly userId: string;
  readonly role: MemberRole;
  /**
   * The session this request is acting under, when there is one.
   *
   * Optional because not every tenanted scope has a session: signup establishes a context before
   * the first session exists, and background jobs run under a synthetic context. Request-scoped
   * contexts always set it, and `requireSessionId` fails closed when a caller needs one.
   */
  readonly sessionId?: string;
  /** Correlation id so a log line, an audit row and an AI call can be tied together. */
  readonly requestId: string;
}

/** Thrown when household-scoped data is touched without a tenant context. */
export class TenantContextMissingError extends Error {
  readonly code = 'TENANT_CONTEXT_MISSING';

  constructor(detail: string) {
    super(
      `No TenantContext is active, so household-scoped data cannot be accessed (${detail}). ` +
        `This is ADR-008: every household-scoped query must be scoped by the authenticated ` +
        `session. If this is background work, wrap it in runWithTenant().`,
    );
    this.name = 'TenantContextMissingError';
  }
}

/**
 * A job scope: the marker that says "this is background work enumerating Households", which is the
 * **one** sanctioned exception to ADR-008 (ADR-022).
 *
 * Deliberately not a `TenantContext`: a job must not be able to pretend it belongs to a Household it
 * is not working on. The guard lets a job scope read the Household directory and nothing else, and
 * every unit of per-Household work still runs inside {@link runWithTenant}.
 */
export interface SystemScope {
  readonly requestId: string;
}

export type TenancyScope =
  | { readonly kind: 'TENANT'; readonly context: TenantContext }
  | { readonly kind: 'SYSTEM'; readonly scope: SystemScope };

const storage = new AsyncLocalStorage<TenancyScope>();

/** The models a system scope may read: the Household directory, and nothing else (ADR-022). */
export const SYSTEM_READABLE_MODELS: ReadonlySet<string> = new Set(['households']);

/**
 * Run `fn` in a **job scope**: allowed to enumerate Households, allowed nothing else.
 *
 * This exists for one caller — the worker (ADR-022) — because something has to know which Households
 * to iterate, and ADR-008 otherwise refuses every read without a tenant. It is narrow by
 * construction: the guard consults {@link SYSTEM_READABLE_MODELS}, so a job that reaches for a
 * Transaction, a Budget or an Insight still throws exactly as it would anywhere else.
 */
export function runAsSystem<T>(scope: SystemScope, fn: () => T): T {
  const result = storage.run({ kind: 'SYSTEM', scope }, fn);
  if (isThenable(result)) {
    return storage.run({ kind: 'SYSTEM', scope }, () => Promise.resolve(result)) as T;
  }
  return result;
}

/**
 * Run `fn` with tenancy established. Used by the request middleware, by background jobs, and by
 * tests.
 *
 * **The thenable branch is load-bearing.** A Prisma query object is *lazy*: it does not execute
 * until it is awaited. `runWithTenant(ctx, () => prisma.merchants.findMany())` therefore returns
 * from `storage.run` — dropping the context — while the query is still unexecuted, and the query
 * then runs outside the scope and throws `TenantContextMissingError`. That failure is silent at the
 * call site and confusing at a distance, so a returned thenable is chained *inside* the context
 * instead. Production code rarely notices because service methods are `async` and await internally;
 * one-line test helpers and background jobs are where it bites.
 */
export function runWithTenant<T>(context: TenantContext, fn: () => T): T {
  const result = storage.run({ kind: 'TENANT', context }, fn);
  if (isThenable(result)) {
    return storage.run({ kind: 'TENANT', context }, () => Promise.resolve(result)) as T;
  }
  return result;
}

/** Prisma query objects are thenable but lazy, so `then` may never have run yet. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

/** The current context, or `undefined` outside a tenanted scope (and in a job scope). */
export function getTenantContext(): TenantContext | undefined {
  const scope = storage.getStore();
  return scope?.kind === 'TENANT' ? scope.context : undefined;
}

/** The current job scope, or `undefined` when this is a request or nothing at all. */
export function getSystemScope(): SystemScope | undefined {
  const scope = storage.getStore();
  return scope?.kind === 'SYSTEM' ? scope.scope : undefined;
}

/** True when a job scope is active. The guard uses this; nothing else should. */
export function isSystemScope(): boolean {
  return storage.getStore()?.kind === 'SYSTEM';
}

/**
 * The current context, or a throw.
 *
 * Prefer this everywhere data is touched. A missing context is a bug in the caller, not a
 * recoverable condition — failing closed is the only acceptable behaviour for financial data.
 */
export function requireTenantContext(detail = 'unspecified operation'): TenantContext {
  const context = getTenantContext();
  if (!context) throw new TenantContextMissingError(detail);
  return context;
}

/**
 * The current session id, or a throw.
 *
 * Used by logout: a request always has a session, so its absence means the route was reached
 * without authentication rather than through some legitimate sessionless path.
 */
export function requireSessionId(detail = 'unspecified operation'): string {
  const context = requireTenantContext(detail);
  if (!context.sessionId) {
    throw new TenantContextMissingError(`${detail} requires a session, but the context has none`);
  }
  return context.sessionId;
}

/** True when running inside a tenanted scope. For assertions and diagnostics only. */
export function hasTenantContext(): boolean {
  return getTenantContext() !== undefined;
}
