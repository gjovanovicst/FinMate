import type { CurrencyCode } from '@finmate/domain';

import type { PrismaService } from '../../prisma/prisma.service';

/**
 * The Household's own ledger currency (ADR-003, ADR-011).
 *
 * Three modules need it — the insight feed, fact assembly and analytics — and every money figure they
 * return has to be labelled with it. Three copies of "read one column and fall back to `RSD`" is three
 * chances for one surface to disagree with the ledger it is describing, and a figure in the wrong
 * currency is worse than no figure at all.
 *
 * The fallback is the seeded default and **never a conversion**: nothing here converts anything, it
 * only labels an amount that is already in the ledger's currency. A Household that adopted a different
 * currency raised `ledger_currency` at that moment (ADR-011).
 */
export async function ledgerCurrencyOf(
  prisma: PrismaService,
  householdId: string,
): Promise<CurrencyCode> {
  const household = await prisma.client.households.findFirst({
    where: { id: householdId },
    select: { ledger_currency: true },
  });

  return (household?.ledger_currency ?? 'RSD') as CurrencyCode;
}
