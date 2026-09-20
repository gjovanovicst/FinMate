import type { Request } from 'express';

import type { TenantContext } from './tenant-context';

/**
 * The seam between the generic tenancy middleware and authentication.
 *
 * The request-context middleware lives in `common/tenancy` and must not import the auth module —
 * tenancy is a cross-cutting concern and auth is a feature. So the middleware depends on this
 * interface and the auth module supplies the implementation through DI. That keeps the dependency
 * pointing the right way: features depend on common, never the reverse.
 */
export const SESSION_RESOLVER = Symbol('SESSION_RESOLVER');

export interface ResolvedSession {
  readonly householdId: string;
  readonly userId: string;
  readonly role: TenantContext['role'];
  readonly sessionId: string;
  /** See `TenantContext.emailVerified`: true unless this deployment requires verification and the address is unconfirmed. */
  readonly emailVerified: boolean;
}

export interface SessionResolver {
  /**
   * Resolve the authenticated session for a request.
   *
   * Returns `null` for an unauthenticated request. It must **never** read the Household from
   * client input — only from a verified credential (docs/08 §4, ADR-008).
   */
  resolve(request: Request): Promise<ResolvedSession | null>;
}

/** Cookie name for the access token when the client is a browser. */
export const ACCESS_TOKEN_COOKIE = 'finmate_access';
/** Cookie name for the rotating refresh token. */
export const REFRESH_TOKEN_COOKIE = 'finmate_refresh';

/**
 * Read a cookie without pulling in `cookie-parser`.
 *
 * Deliberately minimal: it only needs to find exact names in a header Express already provides.
 */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

/** Extract a bearer token from the Authorization header, if present and well-formed. */
export function readBearerToken(request: Request): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}
