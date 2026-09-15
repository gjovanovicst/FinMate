import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addMonths, todayIn, uuidv7, type LocalDate } from '@finmate/domain';

import { runWithTenant, type TenantContext } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { GoalsModule } from './goals.module';
import { GoalsService } from './goals.service';

/**
 * Saving goals against a real database — F-18, docs/06 §4/§5.7, docs/02 §4.13.
 *
 * What only Postgres can answer here:
 *
 *  - **Idempotency (I-10)** is enforced by a partial unique index, not by a check-then-write: the
 *    second submit with the same key must return the *original* contribution and leave the goal's
 *    total untouched. The index is also the only thing that survives a concurrent double-submit.
 *  - **Progress is derived on every read** (docs/03 §6): the numbers come from the contributions, so
 *    nothing can drift from the rows the user can see.
 *  - **`ACHIEVED` is recomputed, not latched**: the contribution that crosses the target sets it, and
 *    deleting that contribution puts the goal back to `ACTIVE` — the case a stored flag gets wrong.
 *  - **Household isolation**: a goal, a contribution and an Account all live in one Household.
 *
 * The arithmetic itself is `packages/domain/src/goals.spec.ts`'s; what this file proves is that the
 * service *uses* it and that the money survives the round trip.
 */
describe('saving goals (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let goals: GoalsService;

  const householdId = uuidv7();
  const otherHouseholdId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();

  const context: TenantContext = { householdId, userId, role: 'OWNER', requestId: 'goals-it' };
  const otherContext: TenantContext = {
    householdId: otherHouseholdId,
    userId: otherUserId,
    role: 'OWNER',
    requestId: 'goals-it-other',
  };
  const asTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(context, fn);
  const asOther = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(otherContext, fn);

  /** The Household's own day, which is what the service plans from (I-2). */
  const TODAY = todayIn('Europe/Belgrade');
  /** Nine month boundaries away, whatever today is: the calculator's unit is the calendar month. */
  const TARGET = addMonths(TODAY, 9);

  let accountId: string;
  let otherAccountId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule, GoalsModule],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    goals = moduleRef.get(GoalsService);

    const stamp = Date.now();
    await prisma.client.users.createMany({
      data: [
        { id: userId, email: `goals-${stamp}@example.com`, display_name: 'Goals Test' },
        { id: otherUserId, email: `goals-b-${stamp}@example.com`, display_name: 'Other' },
      ],
    });
    for (const [ctx, id, owner, name] of [
      [context, householdId, userId, 'Goals Test'],
      [otherContext, otherHouseholdId, otherUserId, 'Other'],
    ] as const) {
      await runWithTenant(ctx, () =>
        prisma.client.households.create({
          data: {
            id,
            name,
            owner_user_id: owner,
            ledger_currency: 'RSD',
            iana_timezone: 'Europe/Belgrade',
          },
        }),
      );
    }

    accountId = await asTenant(async () => {
      const account = await prisma.client.accounts.create({
        data: { id: uuidv7(), household_id: householdId, name: 'Kartica', kind: 'CARD', currency: 'RSD' },
      });
      return account.id;
    });
    otherAccountId = await asOther(async () => {
      const account = await prisma.client.accounts.create({
        data: { id: uuidv7(), household_id: otherHouseholdId, name: 'Tuđa', kind: 'CASH', currency: 'RSD' },
      });
      return account.id;
    });
  });

  afterAll(async () => {
    for (const [ctx, id] of [
      [context, householdId],
      [otherContext, otherHouseholdId],
    ] as const) {
      await runWithTenant(ctx, () => prisma.client.households.deleteMany({ where: { id } }));
    }
    await prisma.client.users.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await moduleRef?.close();
  });

  const create = (overrides: Partial<Parameters<GoalsService['create']>[1]> = {}) =>
    asTenant(() =>
      goals.create(householdId, {
        name: 'Letovanje',
        targetMinor: 12_000_000n,
        targetDate: TARGET,
        accountId,
        ...overrides,
      }),
    );

  const contribute = (
    goalId: string,
    amountMinor: bigint,
    idempotencyKey: string,
    overrides: { contributedOn?: string | null; note?: string | null } = {},
  ) =>
    asTenant(() =>
      goals.contribute(householdId, {
        goalId,
        amountMinor,
        idempotencyKey,
        ...overrides,
      }),
    );

  // ---------------------------------------------------------------------------------------------
  // Creating and reading
  // ---------------------------------------------------------------------------------------------

  it('creates a goal in the Household ledger currency and plans from the contributions', async () => {
    const goal = await create();

    expect(goal.name).toBe('Letovanje');
    expect(goal.currency).toBe('RSD');
    expect(goal.status).toBe('ACTIVE');
    expect(goal.contributedMinor).toBe(0n);
    expect(goal.remainingMinor).toBe(12_000_000n);
    expect(goal.progress).toBe(0);
    // Nine month boundaries to the target month, and 120.000 / 9 rounds **up**.
    expect(goal.monthsRemaining).toBe(9);
    expect(goal.requiredPerMonthMinor).toBe(1_333_334n);
    expect(goal.account?.name).toBe('Kartica');
  });

  it('refuses a target of zero or less, and an empty name', async () => {
    await expect(create({ targetMinor: 0n })).rejects.toThrow(/greater than zero/);
    await expect(create({ name: '   ' })).rejects.toThrow(/needs a name/);
  });

  it('refuses an Account that is not this Household’s', async () => {
    await expect(create({ accountId: otherAccountId })).rejects.toThrow(/Account not found/);
  });

  it('reports no monthly amount for a goal with no deadline, and the whole remainder once overdue', async () => {
    const open = await create({ name: 'Bez roka', targetDate: null });
    expect(open.monthsRemaining).toBeNull();
    expect(open.requiredPerMonthMinor).toBeNull();

    const overdue = await create({ name: 'Juče', targetDate: '2020-01-01' as LocalDate });
    expect(overdue.monthsRemaining).toBe(0);
    expect(overdue.requiredPerMonthMinor).toBe(12_000_000n);
  });

  it('lists every goal, and filters by status', async () => {
    const all = await asTenant(() => goals.list(householdId));
    expect(all.length).toBeGreaterThanOrEqual(3);

    const active = await asTenant(() => goals.list(householdId, ['ACTIVE']));
    expect(active.every((goal) => goal.status === 'ACTIVE')).toBe(true);

    // A nullable list argument arrives as `null`; an empty list means "no filter", not "no goals".
    expect((await asTenant(() => goals.list(householdId, null))).length).toBe(all.length);
    expect((await asTenant(() => goals.list(householdId, []))).length).toBe(all.length);
  });

  // ---------------------------------------------------------------------------------------------
  // Contributions
  // ---------------------------------------------------------------------------------------------

  it('adds a contribution, moves the progress and returns the refreshed goal', async () => {
    const goal = await create({ name: 'Auto', targetMinor: 4_000_000n });
    const result = await contribute(goal.id, 1_050_000n, uuidv7(), { note: 'Kartica' });

    expect(result.wasReplayed).toBe(false);
    expect(result.contribution.amountMinor).toBe(1_050_000n);
    expect(result.contribution.currency).toBe('RSD');
    expect(result.contribution.contributedOn).toBe(TODAY);
    expect(result.goal.contributedMinor).toBe(1_050_000n);
    expect(result.goal.remainingMinor).toBe(2_950_000n);
    expect(result.goal.progress).toBeCloseTo(0.2625, 10);
    expect(result.goal.contributions.map((row) => row.amountMinor)).toEqual([1_050_000n]);
  });

  it('is idempotent on the key, and a new key adds again (I-10)', async () => {
    const goal = await create({ name: 'Kamera', targetMinor: 2_000_000n });
    const key = uuidv7();

    const first = await contribute(goal.id, 500_000n, key);
    const replay = await contribute(goal.id, 500_000n, key);

    expect(replay.wasReplayed).toBe(true);
    expect(replay.contribution.id).toBe(first.contribution.id);
    // The money is on the goal exactly once.
    expect(replay.goal.contributedMinor).toBe(500_000n);
    expect(replay.goal.contributions).toHaveLength(1);

    const second = await contribute(goal.id, 500_000n, uuidv7());
    expect(second.wasReplayed).toBe(false);
    expect(second.goal.contributedMinor).toBe(1_000_000n);
    expect(second.goal.contributions).toHaveLength(2);
  });

  it('refuses a non-positive amount, an empty key, and an archived goal', async () => {
    const goal = await create({ name: 'Provera', targetMinor: 1_000_000n });

    await expect(contribute(goal.id, 0n, uuidv7())).rejects.toThrow(/greater than zero/);
    await expect(contribute(goal.id, 1_000n, '  ')).rejects.toThrow(/idempotencyKey is required/);

    await asTenant(() => goals.update(householdId, { goalId: goal.id, status: 'ARCHIVED' }));
    await expect(contribute(goal.id, 1_000n, uuidv7())).rejects.toThrow(/archived/);
  });

  it('marks the goal achieved when the contributions reach the target, and not before', async () => {
    const goal = await create({ name: 'Telefon', targetMinor: 1_000_000n });

    const almost = await contribute(goal.id, 999_999n, uuidv7());
    expect(almost.goal.status).toBe('ACTIVE');
    expect(almost.goal.progress).toBeCloseTo(0.999999, 10);

    const crossed = await contribute(goal.id, 1n, uuidv7());
    expect(crossed.goal.status).toBe('ACHIEVED');
    expect(crossed.goal.remainingMinor).toBe(0n);
    expect(crossed.goal.progress).toBe(1);
    expect(crossed.goal.requiredPerMonthMinor).toBe(0n);
  });

  it('puts the status back when the crossing contribution is deleted', async () => {
    const goal = await create({ name: 'Bicikl', targetMinor: 2_000_000n });
    const crossing = await contribute(goal.id, 2_000_000n, uuidv7());
    expect(crossing.goal.status).toBe('ACHIEVED');

    const after = await asTenant(() => goals.removeContribution(householdId, crossing.contribution.id));
    expect(after.status).toBe('ACTIVE');
    expect(after.contributedMinor).toBe(0n);
    expect(after.progress).toBe(0);
  });

  it('keeps an archived goal archived even when the money is there', async () => {
    const goal = await create({ name: 'Staro', targetMinor: 1_000_000n });
    await contribute(goal.id, 1_000_000n, uuidv7());
    const archived = await asTenant(() =>
      goals.update(householdId, { goalId: goal.id, status: 'ARCHIVED' }),
    );
    expect(archived.status).toBe('ARCHIVED');

    // Restoring it lets the derived status come back.
    const restored = await asTenant(() =>
      goals.update(householdId, { goalId: goal.id, status: 'ACTIVE' }),
    );
    expect(restored.status).toBe('ACHIEVED');
  });

  it('counts contributions on the day they were made, not the day they were entered', async () => {
    const goal = await create({ name: 'Rata', targetMinor: 3_000_000n });
    await contribute(goal.id, 100_000n, uuidv7(), { contributedOn: '2026-01-15' });
    await contribute(goal.id, 200_000n, uuidv7(), { contributedOn: '2026-02-15' });

    const read = await asTenant(() => goals.getById(householdId, goal.id));
    // Newest first, and both are counted.
    expect(read.contributions.map((row) => row.contributedOn)).toEqual(['2026-02-15', '2026-01-15']);
    expect(read.contributedMinor).toBe(300_000n);
  });

  // ---------------------------------------------------------------------------------------------
  // Updating and deleting
  // ---------------------------------------------------------------------------------------------

  it('patches a goal, and un-achieves it by raising the target', async () => {
    const goal = await create({ name: 'Patch', targetMinor: 1_000_000n });
    await contribute(goal.id, 1_000_000n, uuidv7());

    const renamed = await asTenant(() =>
      goals.update(householdId, { goalId: goal.id, name: '  Preimenovano  ' }),
    );
    expect(renamed.name).toBe('Preimenovano');
    expect(renamed.status).toBe('ACHIEVED');
    // An absent `targetDate` is left alone, and so is an absent Account.
    expect(renamed.targetDate).toBe(TARGET);
    expect(renamed.accountId).toBe(accountId);

    const raised = await asTenant(() =>
      goals.update(householdId, { goalId: goal.id, targetMinor: 5_000_000n }),
    );
    expect(raised.status).toBe('ACTIVE');
    expect(raised.remainingMinor).toBe(4_000_000n);
  });

  it('clears a target date and an Account only when asked to', async () => {
    const goal = await create({ name: 'Ciscenje', targetDate: TARGET, accountId });
    const cleared = await asTenant(() =>
      goals.update(householdId, { goalId: goal.id, clearTargetDate: true, clearAccount: true }),
    );

    expect(cleared.targetDate).toBeNull();
    expect(cleared.requiredPerMonthMinor).toBeNull();
    expect(cleared.accountId).toBeNull();
    expect(cleared.account).toBeNull();
  });

  it('soft-deletes a goal: it leaves the list and its id stops resolving', async () => {
    const goal = await create({ name: 'Brisanje', targetMinor: 500_000n });
    await contribute(goal.id, 100_000n, uuidv7());

    await asTenant(() => goals.remove(householdId, goal.id));

    const list = await asTenant(() => goals.list(householdId));
    expect(list.some((row) => row.id === goal.id)).toBe(false);
    await expect(asTenant(() => goals.getById(householdId, goal.id))).rejects.toThrow(/Goal not found/);

    // Soft delete: the row and its contribution are still there for the audit trail. Read inside the
    // tenant context — a household-scoped query without one throws by design (ADR-008), which is how
    // the guard caught this assertion when it was first written.
    const stillThere = await asTenant(() =>
      prisma.client.saving_goals.findFirst({ where: { id: goal.id } }),
    );
    expect(stillThere?.deleted_at).not.toBeNull();
    const contributions = await asTenant(() =>
      prisma.client.goal_contributions.count({ where: { goal_id: goal.id } }),
    );
    expect(contributions).toBe(1);
  });

  // ---------------------------------------------------------------------------------------------
  // Tenancy
  // ---------------------------------------------------------------------------------------------

  it('never reads or writes another Household’s goal', async () => {
    const goal = await create({ name: 'Privatno', targetMinor: 1_000_000n });

    await expect(asOther(() => goals.getById(otherHouseholdId, goal.id))).rejects.toThrow(
      /Goal not found/,
    );
    await expect(
      asOther(() => goals.contribute(otherHouseholdId, { goalId: goal.id, amountMinor: 1n, idempotencyKey: uuidv7() })),
    ).rejects.toThrow(/Goal not found/);
    await expect(asOther(() => goals.remove(otherHouseholdId, goal.id))).rejects.toThrow(
      /Goal not found/,
    );

    const theirs = await asOther(() => goals.list(otherHouseholdId));
    expect(theirs).toHaveLength(0);

    // And the other Household's own goal is not affected by any of it.
    const own = await asOther(() =>
      goals.create(otherHouseholdId, { name: 'Tuđi cilj', targetMinor: 2_000_000n }),
    );
    const ownRead = await asOther(() => goals.getById(otherHouseholdId, own.id));
    expect(ownRead.contributedMinor).toBe(0n);
  });

  it('refuses to remove a contribution of another Household', async () => {
    const goal = await create({ name: 'Uplata', targetMinor: 1_000_000n });
    const result = await contribute(goal.id, 10_000n, uuidv7());

    await expect(
      asOther(() => goals.removeContribution(otherHouseholdId, result.contribution.id)),
    ).rejects.toThrow(/Contribution not found/);
  });
});
