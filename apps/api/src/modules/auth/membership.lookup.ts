import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import type { MemberRole } from '../../common/tenancy/tenant-context';

export interface Membership {
  readonly householdId: string;
  readonly userId: string;
  readonly role: MemberRole;
}

/**
 * The ONE sanctioned read that happens before a TenantContext exists.
 *
 * ## Why this exists
 *
 * Authentication has a chicken-and-egg problem that tenancy cannot solve: to establish a
 * `TenantContext` we must know which Household the user belongs to, but resolving that means
 * reading `household_members` — a household-scoped table, whose guard correctly refuses to run
 * without a context.
 *
 * Rather than weaken the guard for everyone, the exception lives here, alone, and is explicit:
 * `$queryRaw` is not intercepted by Prisma's model extension, so this is a deliberate, narrow
 * bypass. Three rules keep it honest:
 *
 *  1. **Parameterised only.** Never string-interpolate into the query. The unit test asserts the
 *     query is parameterised.
 *  2. **By `user_id` only.** It answers "which Households does *this authenticated user* belong
 *     to", never "who is in Household X" — that direction is a normal scoped query.
 *  3. **No other caller.** If a second module needs this, that is a signal to reconsider the
 *     design rather than to import it.
 *
 * v1 note: every user has exactly one Household (sharing is v2 — ADR-008), so `activeMembership`
 * is unambiguous. When multi-Household membership lands, the *session* must record which Household
 * is active, and this lookup supplies the choices rather than the answer.
 */
@Injectable()
export class MembershipLookup {
  constructor(private readonly prisma: PrismaService) {}

  /** All Memberships for a user. Empty when the user has none (e.g. an incomplete signup). */
  async listForUser(userId: string): Promise<Membership[]> {
    const rows = await this.prisma.client.$queryRaw<
      { household_id: string; user_id: string; role: string }[]
    >`
      SELECT household_id, user_id, role
      FROM household_members
      WHERE user_id = ${userId}::uuid
      ORDER BY created_at ASC
    `;

    return rows.map((row) => ({
      householdId: row.household_id,
      userId: row.user_id,
      role: assertRole(row.role),
    }));
  }

  /**
   * The Membership a session acts in. v1 has exactly one; a user with none cannot be tenanted and
   * therefore cannot use the API, which is the correct fail-closed outcome.
   */
  async activeMembership(userId: string): Promise<Membership | null> {
    const memberships = await this.listForUser(userId);
    return memberships[0] ?? null;
  }
}

const ROLES: readonly MemberRole[] = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'];

function assertRole(value: string): MemberRole {
  if ((ROLES as readonly string[]).includes(value)) return value as MemberRole;
  // The database CHECK constraint should make this unreachable; if it is reached, fail loudly
  // rather than silently granting the weakest role to someone who might be an OWNER.
  throw new Error(`Unknown Member role in the database: ${value}`);
}
