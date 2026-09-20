import { Injectable } from '@nestjs/common';
import type { Request } from 'express';

import {
  readBearerToken,
  readCookie,
  ACCESS_TOKEN_COOKIE,
  type ResolvedSession,
  type SessionResolver,
} from '../../common/tenancy/session-resolver';
import { AuthService } from './auth.service';

/**
 * Supplies the tenancy middleware with an authenticated session.
 *
 * Implemented in the auth module and injected into `common/tenancy` through the `SESSION_RESOLVER`
 * token, so the generic middleware never imports a feature module.
 *
 * Both credential transports are accepted:
 *  - `Authorization: Bearer <jwt>` — API clients, tests, future native shells.
 *  - `finmate_access` httpOnly cookie — the browser client (docs/07).
 */
@Injectable()
export class AuthSessionResolver implements SessionResolver {
  constructor(private readonly auth: AuthService) {}

  async resolve(request: Request): Promise<ResolvedSession | null> {
    const token = readBearerToken(request) ?? readCookie(request, ACCESS_TOKEN_COOKIE);
    if (!token) return null;

    const session = await this.auth.resolveSession(token);
    if (!session) return null;

    return {
      householdId: session.membership.householdId,
      userId: session.userId,
      role: session.membership.role,
      sessionId: session.sessionId,
      emailVerified: session.emailVerified,
    };
  }
}
