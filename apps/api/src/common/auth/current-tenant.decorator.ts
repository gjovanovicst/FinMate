import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import { requireTenantContext, type TenantContext } from '../tenancy/tenant-context';

/**
 * Inject the authenticated `TenantContext` into a handler.
 *
 * Uses `requireTenantContext`, so a route that forgot `AuthenticatedGuard` fails closed rather than
 * receiving an undefined tenant and querying unscoped data.
 */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, _context: ExecutionContext): TenantContext => requireTenantContext('@CurrentTenant'),
);

/** Convenience accessor for just the Household id. */
export const CurrentHouseholdId = createParamDecorator(
  (_data: unknown, _context: ExecutionContext): string =>
    requireTenantContext('@CurrentHouseholdId').householdId,
);
