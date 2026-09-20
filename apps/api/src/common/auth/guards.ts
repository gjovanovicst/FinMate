import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  type CustomDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { CONFIG, type AppConfig } from '../../config/config';
import { ApiError } from '../filters/all-exceptions.filter';
import { getTenantContext, type MemberRole, type TenantContext } from '../tenancy/tenant-context';

/**
 * Requires an authenticated request.
 *
 * The work of *resolving* the session already happened in `RequestContextMiddleware`, which
 * established the `TenantContext`. This guard therefore only asserts that it exists — one place
 * resolves, one place asserts, and services get a third layer via `requireTenantContext()`. Three
 * cheap checks on the path to financial data is the right trade.
 */
@Injectable()
export class AuthenticatedGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // `@Public()` is checked at method then class level, so a public route (login, health) stays
    // reachable while every unmarked route requires authentication by default.
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_ROUTE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    if (!getTenantContext()) {
      throw new ApiError('UNAUTHENTICATED', 'Authentication required.');
    }
    return true;
  }
}

/**
 * Explicitly mark a route (or controller) as public, so the globally-applied
 * `AuthenticatedGuard` can stay deny-by-default without a hand-maintained opt-out list.
 */
export const PUBLIC_ROUTE_KEY = 'finmate:public';
export const Public = (): CustomDecorator<string> => SetMetadata(PUBLIC_ROUTE_KEY, true);

export const ROLES_KEY = 'finmate:roles';

/** Restrict a route to the given Member roles. Must be combined with `AuthenticatedGuard`. */
export const Roles = (...roles: readonly MemberRole[]): CustomDecorator<string> =>
  SetMetadata(ROLES_KEY, roles);

/**
 * Enforce the role matrix from docs/06 §11.
 *
 * Roles are read from the `TenantContext`, which the middleware loaded from the database — never
 * from a token claim — so a demotion applies on the very next request (docs/08 §3).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<readonly MemberRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const tenant = getTenantContext();
    if (!tenant) throw new ApiError('UNAUTHENTICATED', 'Authentication required.');

    if (!required.includes(tenant.role)) {
      throw new ApiError('FORBIDDEN', 'Your role does not permit this action.');
    }
    return true;
  }
}

export type { TenantContext };

export const ALLOW_UNVERIFIED_KEY = 'finmate:allow-unverified';

/**
 * Let an authenticated but **unconfirmed** account reach a route when this deployment requires
 * email verification.
 *
 * Used by the identity surface itself (`/auth/*`): an account whose address is unconfirmed must
 * still be able to see its own state, resend the link, fix a typo, change its password and sign out.
 * What it must not reach is anybody's data — the tenancy middleware and this guard are the two halves
 * of that: it has a `TenantContext`, but the guard refuses the request before the handler runs.
 */
export const AllowUnverified = (): CustomDecorator<string> =>
  SetMetadata(ALLOW_UNVERIFIED_KEY, true);

/**
 * Require a confirmed email address, when the deployment asks for one.
 *
 * Inert unless `REQUIRE_EMAIL_VERIFICATION` is true: the whole feature is opt-in, so a development
 * instance and the demo keep working with unconfirmed accounts (docs/06 §2). The value comes from the
 * `TenantContext`, which the session resolver populated — and which it only populated with a user
 * read **when this guard would consult it**, so the default path pays no extra query.
 *
 * A request with no context is left to `AuthenticatedGuard`, which runs first and throws. This guard
 * adds a condition to an authenticated request; it does not authenticate.
 */
@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.REQUIRE_EMAIL_VERIFICATION) return true;

    const exempt = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_ROUTE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (exempt) return true;

    const allowUnverified = this.reflector.getAllAndOverride<boolean | undefined>(
      ALLOW_UNVERIFIED_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowUnverified) return true;

    const tenant = getTenantContext();
    if (!tenant) return true;

    if (tenant.emailVerified === false) {
      // `retryable` is true on purpose: the client's correct next step is to resend the link, not to
      // treat this as a dead end or to sign the person out.
      throw new ApiError(
        'EMAIL_NOT_VERIFIED',
        'Confirm your email address to continue.',
        true,
      );
    }
    return true;
  }
}
