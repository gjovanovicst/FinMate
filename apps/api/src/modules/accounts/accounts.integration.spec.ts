import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@finmate/domain';

import { runWithTenant } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AccountsModule } from './accounts.module';
import { AccountsService } from './accounts.service';

/**
 * Regression test for a defect that took down an entire screen.
 *
 * Balances were computed with `subtractMoney`, which throws when the result would be negative — so
 * the first overdrawn account made the whole Accounts query fail with INTERNAL, because every
 * balance on the page is resolved in one grouped query. A negative balance is perfectly valid data
 * (overdraft, credit card, or an opening balance recorded lower than what was already spent), so the
 * fix was to model a derived Balance separately from a non-negative Money amount.
 *
 * A unit test on the formatter would not have caught this: the failure was in the *aggregation
 * query*, and only a real database produces a negative intermediate value.
 */
describe('AccountsService balances (integration)', () => {
  let moduleRef: TestingModule;
  let accounts: AccountsService;
  let prisma: PrismaService;

  const created: { userId: string; householdId: string }[] = [];
  let householdId: string;
  let userId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule, AccountsModule],
    }).compile();

    accounts = moduleRef.get(AccountsService);
    prisma = moduleRef.get(PrismaService);

    // A Household has to exist before an Account can. Created directly so the test does not depend
    // on the auth module's signup path.
    userId = uuidv7();
    householdId = uuidv7();
    created.push({ userId, householdId });

    await runWithTenant({ householdId, userId, role: 'OWNER', requestId: 'test-setup' }, async () => {
      await prisma.client.users.create({
        data: { id: userId, email: `acct-${Date.now()}@example.com`, display_name: 'Accounts Test' },
      });
      await prisma.client.households.create({
        data: { id: householdId, name: 'Accounts Test', owner_user_id: userId },
      });
    });
  });

  afterAll(async () => {
    for (const entry of created) {
      await runWithTenant(
        { householdId: entry.householdId, userId: entry.userId, role: 'OWNER', requestId: 'teardown' },
        async () => {
          await prisma.client.households.deleteMany({ where: { id: entry.householdId } });
        },
      );
      await prisma.client.users.deleteMany({ where: { id: entry.userId } });
    }
    await moduleRef?.close();
  });

  /**
   * Run a service call the way a request would: inside a TenantContext.
   *
   * Calling AccountsService outside one is refused by the tenancy guard, which is the correct
   * behaviour and the reason this helper exists rather than the test bypassing it.
   */
  function asTenant<T>(fn: () => Promise<T>): Promise<T> {
    return runWithTenant(
      { householdId, userId, role: 'OWNER', requestId: 'test-call' },
      fn,
    );
  }

  /** Record a movement directly — there is no Transaction API until Phase 1. */
  async function record(accountId: string, kind: 'INCOME' | 'EXPENSE', amountMinor: bigint) {
    await runWithTenant(
      { householdId, userId, role: 'OWNER', requestId: 'test-movement' },
      async () => {
        await prisma.client.transactions.create({
          data: {
            id: uuidv7(),
            household_id: householdId,
            account_id: accountId,
            kind,
            amount_minor: amountMinor,
            currency: 'RSD',
            description: `${kind} ${amountMinor}`,
            occurred_at: new Date(),
            occurred_local_date: new Date(),
            status: 'CONFIRMED',
            source: 'MANUAL',
          },
        });
      },
    );
  }

  it('computes a positive balance as opening + income − expense', async () => {
    const account = await asTenant(() => accounts.create(householdId, { name: 'Tekući', kind: 'BANK' } as never));
    await record(account.id, 'INCOME', 145_000_00n);
    await record(account.id, 'EXPENSE', 2_340_50n);

    const reloaded = await asTenant(() => accounts.getById(householdId, account.id));
    expect(reloaded.balance.amountMinor).toBe(145_000_00n - 2_340_50n);
  });

  it('returns a NEGATIVE balance instead of throwing (the regression)', async () => {
    const account = await asTenant(() => accounts.create(householdId, { name: 'Kartica', kind: 'CARD' } as never));
    await record(account.id, 'EXPENSE', 500_000n);

    const reloaded = await asTenant(() => accounts.getById(householdId, account.id));
    expect(reloaded.balance.amountMinor).toBe(-500_000n);
  });

  it('lets a page containing an overdrawn account succeed', async () => {
    // The original failure mode: one negative balance made the entire grouped query throw, so a
    // single overdrawn account blanked the whole screen.
    const page = await asTenant(() => accounts.list({ householdId, first: 50 }));
    expect(page.items.length).toBeGreaterThanOrEqual(2);

    const anyNegative = page.items.some((item) => item.balance.amountMinor < 0n);
    expect(anyNegative).toBe(true);
  });

  it('excludes PENDING transactions from the balance (invariant I-7)', async () => {
    const account = await asTenant(() => accounts.create(householdId, { name: 'Keš', kind: 'CASH' } as never));

    await runWithTenant({ householdId, userId, role: 'OWNER', requestId: 'pending' }, async () => {
      await prisma.client.transactions.create({
        data: {
          id: uuidv7(),
          household_id: householdId,
          account_id: account.id,
          kind: 'EXPENSE',
          amount_minor: 9_999n,
          currency: 'RSD',
          description: 'not yet confirmed',
          occurred_at: new Date(),
          occurred_local_date: new Date(),
          status: 'PENDING',
          source: 'MANUAL',
        },
      });
    });

    const reloaded = await asTenant(() => accounts.getById(householdId, account.id));
    expect(reloaded.balance.amountMinor).toBe(0n);
  });

  it('reports the balance it just created, not zero', async () => {
    const account = await asTenant(() =>
      accounts.create(householdId, {
        name: 'Sa početnim stanjem',
        kind: 'CASH',
        openingBalanceMinor: 250_000n,
      } as never),
    );

    expect(account.balance.amountMinor).toBe(250_000n);
    expect(account.openingBalance.amountMinor).toBe(250_000n);
  });
});
