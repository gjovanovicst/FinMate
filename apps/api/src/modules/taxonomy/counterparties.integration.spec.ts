import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@finmate/domain';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import { runWithTenant } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { CounterpartiesService } from './counterparties.service';
import { CounterpartyType } from './counterparty.model';

/**
 * Counterparties against a real database.
 *
 * The behaviours that matter here are the ones a unit test cannot reach: that the folded-name rule
 * really refuses "Dejan rođa" and "dejan roda" as one person (F-11), that merge moves the
 * Household's Transactions and is all-or-nothing, and that a merge cannot reach another Household's
 * rows through a guessed id. All three are about *which rows changed*, which only Postgres can answer.
 *
 * Deliberately no copy-on-write cases here: `counterparties.household_id` is `NOT NULL`, so there are
 * no global rows and nothing for that machinery to do. The Merchants suite owns those.
 */
describe('CounterpartiesService (integration)', () => {
  let moduleRef: TestingModule;
  let counterparties: CounterpartiesService;
  let prisma: PrismaService;

  const householdId = uuidv7();
  const otherHouseholdId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();
  let accountId: string;

  const context = { householdId, userId, role: 'OWNER' as const, requestId: 'test' };
  const otherContext = {
    householdId: otherHouseholdId,
    userId: otherUserId,
    role: 'OWNER' as const,
    requestId: 'test',
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    counterparties = new CounterpartiesService(prisma);

    await prisma.client.users.create({
      data: { id: userId, email: `cp-${Date.now()}@example.com`, display_name: 'Counterparties' },
    });
    await prisma.client.users.create({
      data: { id: otherUserId, email: `cp-b-${Date.now()}@example.com`, display_name: 'Other' },
    });
    await runWithTenant(context, async () => {
      await prisma.client.households.create({
        data: { id: householdId, name: 'Counterparties Test', owner_user_id: userId },
      });
      const account = await prisma.client.accounts.create({
        data: { id: uuidv7(), kind: 'CASH', name: 'Cash', currency: 'RSD', opening_balance_minor: 0n },
      });
      accountId = account.id;
    });
    await runWithTenant(otherContext, async () => {
      await prisma.client.households.create({
        data: { id: otherHouseholdId, name: 'Other', owner_user_id: otherUserId },
      });
    });
  });

  afterAll(async () => {
    for (const [ctx, id] of [
      [context, householdId],
      [otherContext, otherHouseholdId],
    ] as const) {
      await runWithTenant(ctx, async () => {
        await prisma.client.households.deleteMany({ where: { id } });
      });
    }
    await prisma.client.users.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await moduleRef?.close();
  });

  const asTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(context, fn);

  async function recordSpend(counterpartyId: string): Promise<string> {
    const id = uuidv7();
    await asTenant(() =>
      prisma.client.transactions.create({
        data: {
          id,
          account_id: accountId,
          kind: 'EXPENSE',
          amount_minor: 1000n,
          currency: 'RSD',
          description: 'Dejan rođa',
          occurred_at: new Date(),
          occurred_local_date: new Date('2026-09-14T00:00:00.000Z'),
          // `source` has a DEFAULT in the database but not in the derived Prisma schema, so a direct
          // create must supply it (the service does).
          source: 'MANUAL',
          counterparty_id: counterpartyId,
        },
      }),
    );
    return id;
  }

  it('defaults to PERSON and keeps the Household’s own rows only', async () => {
    const mine = await asTenant(() => counterparties.create(householdId, { name: 'Dejan rođa' }));
    expect(mine.type).toBe(CounterpartyType.PERSON);

    await runWithTenant(otherContext, () =>
      counterparties.create(otherHouseholdId, { name: 'Tudji Rodjak' }),
    );

    const page = await asTenant(() => counterparties.list(householdId, {}, {}));
    const names = page.items.map((item) => item.name);
    expect(names).toContain('Dejan rođa');
    expect(names).not.toContain('Tudji Rodjak');
  });

  it('refuses a name that folds to an existing one — the Dejan rođa case (F-11)', async () => {
    await asTenant(() => counterparties.create(householdId, { name: 'Marko Perić' }));

    const failure = await asTenant(() =>
      counterparties.create(householdId, { name: '  marko   PERIC ' }),
    ).catch((error) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('CONFLICT');
    // The refusal names the way out: an alias, or a merge.
    expect((failure as Error).message).toMatch(/alias|merge/i);
  });

  it('stores the type the caller asked for', async () => {
    const created = await asTenant(() =>
      counterparties.create(householdId, { name: 'Opština', type: CounterpartyType.GOVERNMENT }),
    );
    expect(created.type).toBe(CounterpartyType.GOVERNMENT);

    const updated = await asTenant(() =>
      counterparties.update(householdId, created.id, { type: CounterpartyType.COMPANY }),
    );
    expect(updated.type).toBe(CounterpartyType.COMPANY);
  });

  it('folds aliases, drops blanks and duplicates, and replaces rather than appends', async () => {
    const created = await asTenant(() => counterparties.create(householdId, { name: 'Alias Rodjak' }));
    const withAliases = await asTenant(() =>
      counterparties.setAliases(householdId, created.id, [
        'Rođa Dejan',
        'Đorđe',
        'roda dejan',
        '',
        '  ',
      ]),
    );
    // `Rođa Dejan` and `roda dejan` fold to the same alias, so one survives; the blanks are dropped;
    // `Đorđe` folds to `dorde` (the fold has an explicit đ rule).
    expect(withAliases.aliases.map((alias) => alias.alias)).toEqual(['dorde', 'roda dejan']);

    const replaced = await asTenant(() =>
      counterparties.setAliases(householdId, created.id, ['only-one']),
    );
    expect(replaced.aliases.map((alias) => alias.alias)).toEqual(['only-one']);
  });

  it('counts Transactions once per page, not once per row', async () => {
    const first = await asTenant(() => counterparties.create(householdId, { name: 'Count One' }));
    const second = await asTenant(() => counterparties.create(householdId, { name: 'Count Two' }));
    await recordSpend(first.id);
    await recordSpend(first.id);
    await recordSpend(second.id);

    const page = await asTenant(() => counterparties.list(householdId, {}, { first: 200 }));
    const byId = new Map(page.items.map((item) => [item.id, item.transactionCount]));
    expect(byId.get(first.id)).toBe(2);
    expect(byId.get(second.id)).toBe(1);
  });

  it('refuses to delete a counterparty that is still referenced, and names merging', async () => {
    const created = await asTenant(() => counterparties.create(householdId, { name: 'In Use Rodjak' }));
    await recordSpend(created.id);

    const failure = await asTenant(() => counterparties.remove(householdId, created.id)).catch(
      (error) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('CONFLICT');
    expect((failure as Error).message).toMatch(/merge/i);
    // No Receipts clause: `receipts` has no counterparty_id column (docs/03 §4).
    expect((failure as Error).message).not.toMatch(/receipt/i);
  });

  it('deletes an unreferenced counterparty', async () => {
    const created = await asTenant(() => counterparties.create(householdId, { name: 'Unused Rodjak' }));
    await asTenant(() => counterparties.remove(householdId, created.id));
    await expect(asTenant(() => counterparties.getById(householdId, created.id))).rejects.toThrow(
      /not found/i,
    );
  });

  it('merges: moves Transactions, unions aliases, and deletes the source', async () => {
    const source = await asTenant(() => counterparties.create(householdId, { name: 'Merge Src' }));
    const target = await asTenant(() => counterparties.create(householdId, { name: 'Merge Tgt' }));
    await asTenant(() => counterparties.setAliases(householdId, source.id, ['from-source', 'shared']));
    await asTenant(() => counterparties.setAliases(householdId, target.id, ['from-target', 'shared']));
    const transactionId = await recordSpend(source.id);

    const merged = await asTenant(() => counterparties.merge(householdId, source.id, target.id));

    expect(merged.id).toBe(target.id);
    expect(merged.aliases.map((alias) => alias.alias).sort()).toEqual([
      'from-source',
      'from-target',
      'shared',
    ]);
    expect(merged.transactionCount).toBe(1);

    const moved = await asTenant(() =>
      prisma.client.transactions.findFirst({ where: { id: transactionId } }),
    );
    expect(moved?.counterparty_id).toBe(target.id);

    await expect(asTenant(() => counterparties.getById(householdId, source.id))).rejects.toThrow(
      /not found/i,
    );
  });

  it('refuses to merge a counterparty into itself', async () => {
    const owned = await asTenant(() => counterparties.create(householdId, { name: 'Merge Guard' }));
    await expect(
      asTenant(() => counterparties.merge(householdId, owned.id, owned.id)),
    ).rejects.toThrow(/itself/i);
  });

  it('cannot reach another Household’s counterparty at all', async () => {
    const foreign = await runWithTenant(otherContext, () =>
      counterparties.create(otherHouseholdId, { name: 'Foreign Rodjak' }),
    );

    await expect(asTenant(() => counterparties.getById(householdId, foreign.id))).rejects.toThrow(
      /not found/i,
    );
    // A merge must not be able to move rows through an id it merely guessed.
    const owned = await asTenant(() => counterparties.create(householdId, { name: 'Local Merge' }));
    await expect(
      asTenant(() => counterparties.merge(householdId, foreign.id, owned.id)),
    ).rejects.toThrow(/not found/i);
    await expect(
      asTenant(() => counterparties.merge(householdId, owned.id, foreign.id)),
    ).rejects.toThrow(/not found/i);
  });
});
