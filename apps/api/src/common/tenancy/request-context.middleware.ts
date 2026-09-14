import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Optional, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { runWithTenant, type TenantContext } from './tenant-context';
import { SESSION_RESOLVER, type SessionResolver } from './session-resolver';

/**
 * Establishes the per-request context.
 *
 * **Security note — read before extending this.** The Household comes from the authenticated
 * session (a verified access token) and from nothing else. There is deliberately NO support for a
 * client-supplied `x-household-id` header, not even behind a development flag: such an escape hatch
 * is exactly what survives into production and becomes a cross-tenant leak (risk R-10). Tests that
 * need a tenant call `runWithTenant` directly.
 *
 * When no session resolves, the request continues **without** a tenant context, so any
 * household-scoped query throws. That fail-closed default is the intended behaviour, and
 * `tenancy.extension.spec.ts` asserts it.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(
    // Optional so the app still boots (fail-closed) before/without the auth module.
    @Optional() @Inject(SESSION_RESOLVER) private readonly resolver: SessionResolver | null,
  ) {}

  async use(request: Request, response: Response, next: NextFunction): Promise<void> {
    const requestId = randomUUID();
    (request as Request & { requestId: string }).requestId = requestId;
    response.setHeader('x-request-id', requestId);

    if (!this.resolver) {
      next();
      return;
    }

    let session: Awaited<ReturnType<SessionResolver['resolve']>> = null;
    try {
      session = await this.resolver.resolve(request);
    } catch {
      // A resolver failure must not 500 the request; treat it as unauthenticated and let the route
      // decide. Auth endpoints stay reachable, protected endpoints fail closed via the guard.
      session = null;
    }

    if (!session) {
      next();
      return;
    }

    const context: TenantContext = {
      householdId: session.householdId,
      userId: session.userId,
      role: session.role,
      sessionId: session.sessionId,
      requestId,
    };

    // `runWithTenant` wraps the remainder of the pipeline, so guards, controllers and services all
    // observe the same context without it being threaded through signatures.
    runWithTenant(context, () => {
      next();
    });
  }
}
