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

const storage = new AsyncLocalStorage<TenantContext>();

/** Run `fn` with tenancy established. Used by the request middleware and by background jobs. */
export function runWithTenant<T>(context: TenantContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The current context, or `undefined` outside a tenanted scope. */
export function getTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

/**
 * The current context, or a throw.
 *
 * Prefer this everywhere data is touched. A missing context is a bug in the caller, not a
 * recoverable condition — failing closed is the only acceptable behaviour for financial data.
 */
export function requireTenantContext(detail = 'unspecified operation'): TenantContext {
  const context = storage.getStore();
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
  return storage.getStore() !== undefined;
}
