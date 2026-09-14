import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  type CustomDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

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
