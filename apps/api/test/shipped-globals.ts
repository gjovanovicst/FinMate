import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * The shipped global catalogue is an **environment precondition**, and it is stated here once.
 *
 * Three integration specs assert how the *shipped* merchant reference data behaves: a global row is
 * readable by every Household, a write copies it rather than mutating it, it cannot be renamed or
 * deleted, and onboarding copies it in. None of them can create that data — a global `merchants` row
 * has `household_id IS NULL`, and the tenancy guard deliberately has **no unguarded write path**
 * (ADR-008), so the only writer is the seed script's bare client.
 *
 * That makes the catalogue part of the database the suite runs against, exactly as it is for a
 * developer: `pnpm db:seed` (globals only without `SEED_HOUSEHOLD_ID`). CI runs that step before the
 * suite.
 *
 * ## Why this helper exists
 *
 * Measured on a fresh database with migrations and nothing else — which is what CI had: the suite
 * failed with **eleven** assertion failures across `global-reads`, `merchants` and `onboarding`, none
 * of which named the missing seed. A green local run and a red CI run is the worst shape a suite can
 * have, so the precondition fails loudly, with the command that fixes it, in one place.
 */
export const SHIPPED_GLOBALS_MISSING =
  'The shipped global merchant catalogue is not in this database. Run `pnpm db:seed` (CI seeds the ' +
  'globals before the suite) — the integration specs assert how that shipped content behaves.';

/** How many shipped global merchants this database holds. */
export async function shippedGlobalCount(prisma: PrismaService): Promise<number> {
  // Raw SQL on purpose: the guard is applied in `PrismaService`, so a `merchants` read through
  // `client` is scoped to a Household and cannot see a global row at all.
  const rows = await prisma.client.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM merchants WHERE household_id IS NULL AND is_global = true
  `;
  return Number(rows[0]?.n ?? 0n);
}

/** Throw with the fix in the message when the shipped catalogue is absent. */
export async function requireShippedGlobals(prisma: PrismaService): Promise<void> {
  if ((await shippedGlobalCount(prisma)) === 0) throw new Error(SHIPPED_GLOBALS_MISSING);
}
