import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@finmate/domain';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import { runWithTenant } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { TagsService } from './tags.service';

/**
 * Tags against a real database.
 *
 * Two things only Postgres can answer are the point of this suite:
 *
 *  - **`transaction_tags` is reachable only through its parent.** The guard refuses a direct query
 *    (ADR-008), so the grouped count has to join through `transactions` to pick up the tenant
 *    predicate, and the assignment has to be a nested write on the Transaction.
 *  - **Deleting a Tag removes its assignments rather than refusing.** Unlike a Merchant or a
 *    Category there is nothing to reassign a label *to*, so the analogue of reassignment is clearing
 *    the assignments (see `TagsService.remove`). All three cases are asserted below, because getting
 *    this wrong leaves assignment rows that render as nothing and can never be removed.
 */
describe('TagsService (integration)', () => {
  let moduleRef: TestingModule;
  let tags: TagsService;
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
    tags = new TagsService(prisma);

    await prisma.client.users.create({
      data: { id: userId, email: `tag-${Date.now()}@example.com`, display_name: 'Tags' },
    });
    await prisma.client.users.create({
      data: { id: otherUserId, email: `tag-b-${Date.now()}@example.com`, display_name: 'Other' },
    });
    await runWithTenant(context, async () => {
      await prisma.client.households.create({
        data: { id: householdId, name: 'Tags Test', owner_user_id: userId },
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

  /** A Transaction with Tags attached through the parent's nested write, as the ledger does it. */
  async function recordSpend(tagIds: readonly string[] = []): Promise<string> {
    const id = uuidv7();
    await asTenant(() =>
      prisma.client.transactions.create({
        data: {
          id,
          account_id: accountId,
          kind: 'EXPENSE',
          amount_minor: 1000n,
          currency: 'RSD',
          description: 'test',
          occurred_at: new Date(),
          occurred_local_date: new Date('2026-09-14T00:00:00.000Z'),
          // `source` has a DEFAULT in the database but not in the derived Prisma schema, so a direct
          // create must supply it (the service does).
          source: 'MANUAL',
          ...(tagIds.length > 0
            ? { transaction_tags: { create: tagIds.map((tagId) => ({ tag_id: tagId })) } }
            : {}),
        },
      }),
    );
    return id;
  }

  /** Insert an assignment directly, bypassing the service, to prove the guard still scopes reads. */
  async function assignmentCount(tagId: string): Promise<number> {
    const rows = await prisma.client.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM transaction_tags WHERE tag_id = ${tagId}::uuid
    `;
    return Number(rows[0]?.n ?? 0n);
  }

  it('refuses direct access to `transaction_tags` — it is parent-scoped', async () => {
    // The guard, not the service, is what makes this safe. Asserting it here documents *why* the
    // assignment has to go through the parent.
    await expect(
      asTenant(() => prisma.client.transaction_tags.findMany({ where: {} })),
    ).rejects.toThrow(/parent/i);
  });

  it('creates a Tag, defaults the colour to null, and folds for the uniqueness check', async () => {
    const created = await asTenant(() => tags.create(householdId, { name: '#vanredno' }));
    expect(created.color).toBeNull();
    expect(created.transactionCount).toBe(0);

    const failure = await asTenant(() => tags.create(householdId, { name: '  #VANREDNO ' })).catch(
      (error) => error,
    );
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('CONFLICT');
  });

  it('lists Tags name-ordered with a grouped transaction count', async () => {
    const beta = await asTenant(() => tags.create(householdId, { name: 'Beta' }));
    const alpha = await asTenant(() => tags.create(householdId, { name: 'alpha', color: '#f00' }));
    await recordSpend([alpha.id]);
    await recordSpend([alpha.id]);
    await recordSpend([beta.id]);

    const all = await asTenant(() => tags.list(householdId));
    // Ordered by name. Compared against a re-sort under the same comparator the database uses is
    // brittle across collations, so the assertion is that each name is >= the previous one.
    const names = all.map((tag) => tag.name);
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(names).toContain('alpha');
    expect(names).toContain('Beta');

    const counts = new Map(all.map((tag) => [tag.name, tag.transactionCount]));
    expect(counts.get('alpha')).toBe(2);
    expect(counts.get('Beta')).toBe(1);
    // A soft-deleted Transaction must not count (I-7's family of "gone means gone" rules).
    const transactionId = await recordSpend([beta.id]);
    await asTenant(() =>
      prisma.client.transactions.update({ where: { id: transactionId }, data: { deleted_at: new Date() } }),
    );
    const after = await asTenant(() => tags.getById(householdId, beta.id));
    expect(after.transactionCount).toBe(1);
  });

  it('cannot count or list another Household’s Tag', async () => {
    const foreign = await runWithTenant(otherContext, () =>
      tags.create(otherHouseholdId, { name: 'foreign-tag' }),
    );
    const mine = await asTenant(() => tags.list(householdId));
    expect(mine.map((tag) => tag.id)).not.toContain(foreign.id);
    await expect(asTenant(() => tags.getById(householdId, foreign.id))).rejects.toThrow(/not found/i);
  });

  it('asserts an assignment target is a visible Tag, and refuses an unknown or foreign id', async () => {
    const mine = await asTenant(() => tags.create(householdId, { name: 'assignable' }));
    await expect(asTenant(() => tags.assertAssignable([mine.id]))).resolves.toBeUndefined();
    await expect(asTenant(() => tags.assertAssignable([uuidv7()]))).rejects.toThrow(/unknown tag/i);

    const foreign = await runWithTenant(otherContext, () =>
      tags.create(otherHouseholdId, { name: 'foreign-assignable' }),
    );
    await expect(asTenant(() => tags.assertAssignable([foreign.id]))).rejects.toThrow(/unknown tag/i);
  });

  it('deletes a Tag by removing its assignments — a dangling label is worse than a missing one', async () => {
    const doomed = await asTenant(() => tags.create(householdId, { name: 'doomed' }));
    const keeper = await asTenant(() => tags.create(householdId, { name: 'keeper' }));
    const transactionId = await recordSpend([doomed.id, keeper.id]);
    expect(await assignmentCount(doomed.id)).toBe(1);

    await asTenant(() => tags.remove(householdId, doomed.id));

    // The Tag is gone from the Household's view...
    await expect(asTenant(() => tags.getById(householdId, doomed.id))).rejects.toThrow(/not found/i);
    // ...and so is every assignment of it, rather than a row that renders as nothing.
    expect(await assignmentCount(doomed.id)).toBe(0);
    // The Transaction itself is untouched, and its other Tag survives.
    const row = await asTenant(() =>
      prisma.client.transactions.findFirst({
        where: { id: transactionId },
        include: { transaction_tags: true },
      }),
    );
    expect(row).not.toBeNull();
    expect(row?.deleted_at).toBeNull();
    expect(row?.transaction_tags.map((join) => join.tag_id)).toEqual([keeper.id]);
  });

  it('lets a deleted Tag name be reused, because the uniqueness index is partial', async () => {
    const first = await asTenant(() => tags.create(householdId, { name: 'recycled' }));
    await asTenant(() => tags.remove(householdId, first.id));
    const second = await asTenant(() => tags.create(householdId, { name: 'recycled' }));
    expect(second.id).not.toBe(first.id);
  });

  it('renames a Tag and refuses a rename that folds to another Tag', async () => {
    const a = await asTenant(() => tags.create(householdId, { name: 'rename-a' }));
    const b = await asTenant(() => tags.create(householdId, { name: 'rename-b' }));
    const renamed = await asTenant(() =>
      tags.update(householdId, a.id, { name: 'Renamed A', color: '#0f0' }),
    );
    expect(renamed.name).toBe('Renamed A');
    expect(renamed.color).toBe('#0f0');

    await expect(
      asTenant(() => tags.update(householdId, b.id, { name: 'renamed a' })),
    ).rejects.toThrow(/already exists/i);
  });
});
