import { randomUUID } from 'node:crypto';

import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { runWithTenant, type TenantContext } from './tenant-context';

/**
 * Establishes the per-request context.
 *
 * **Security note — read before extending this.** The Household is resolved from the
 * authenticated session and from nothing else. There is deliberately NO support for a
 * client-supplied `x-household-id` header, not even behind a development flag: a header-based
 * escape hatch is exactly the kind of thing that survives into production and becomes a
 * cross-tenant leak (risk R-10). If a test needs a tenant, it calls `runWithTenant` directly.
 *
 * Authentication lands in Phase 0 task 0.6. Until then `resolveSession()` returns `null`, so no
 * tenant context is established and **every household-scoped query throws**. That fail-closed
 * default is the intended behaviour, and `tenancy.extension.spec.ts` asserts it.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const requestId = randomUUID();
    (request as Request & { requestId: string }).requestId = requestId;
    response.setHeader('x-request-id', requestId);

    const session = resolveSession(request);

    if (!session) {
      // Fail closed: continue without a tenant context so any scoped query throws.
      next();
      return;
    }

    const context: TenantContext = {
      householdId: session.householdId,
      userId: session.userId,
      role: session.role,
      requestId,
    };

    // runWithTenant wraps the remainder of the pipeline, so guards, controllers and services all
    // observe the same context without it being threaded through signatures.
    runWithTenant(context, () => {
      next();
    });
  }
}

interface ResolvedSession {
  readonly householdId: string;
  readonly userId: string;
  readonly role: TenantContext['role'];
}

/**
 * Placeholder for the auth guard (Phase 0 task 0.6).
 *
 * It will verify the access token, load the Member row, and return the Household the session is
 * acting in. Returning `null` means "unauthenticated", which is the safe default.
 */
function resolveSession(_request: Request): ResolvedSession | null {
  return null;
}
