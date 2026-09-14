import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@finmate/domain';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import { runWithTenant } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { TagsService } from '../taxonomy/tags.service';
import { LedgerModule } from './ledger.module';
import { TransactionKind } from './transaction.model';
import { TransactionsService } from './transactions.service';

/**
 * Tag assignment on a Transaction — the "assignment" half of F-12.
 *
 * `transaction_tags` is PARENT_SCOPED: it has no `household_id`, so the tenancy guard refuses every
 * direct operation on it and an assignment can only be written as a nested write through the parent
 * Transaction (ADR-008). That is what these cases exercise:
 *
 *  - `create` attaches the Tags it was given, and the read paths return them;
 *  - `update` REPLACES the set when `tagIds` is provided, leaves it alone when the argument is
 *    omitted, and clears it on an empty array — the absent-vs-empty distinction the rest of the
 *    update path already uses;
 *  - an unknown or foreign id is a typed `VALIDATION_FAILED`, never a silently dropped assignment.
 */
describe('TransactionsService tag assignment (integration)', () => {
  let moduleRef: TestingModule;
  let transactions: TransactionsService;
  let tags: TagsService;
  let prisma: PrismaService;

  const householdId = uuidv7();
  const otherHouseholdId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();
  let accountId: string;
  let tagA: string;
  let tagB: string;

  const context = { householdId, userId, role: 'OWNER' as const, requestId: 'test' };
  const otherContext = {
    householdId: otherHouseholdId,
    userId: otherUserId,
    role: 'OWNER' as const,
    requestId: 'test',
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule, LedgerModule, TaxonomyModule],
    }).compile();
    transactions = moduleRef.get(TransactionsService);
    tags = moduleRef.get(TagsService);
    prisma = moduleRef.get(PrismaService);

    await prisma.client.users.create({
      data: { id: userId, email: `tt-${Date.now()}@example.com`, display_name: 'Tag Assign' },
    });
    await prisma.client.users.create({
      data: { id: otherUserId, email: `tt-b-${Date.now()}@example.com`, display_name: 'Other' },
    });
    await runWithTenant(context, async () => {
      await prisma.client.households.create({
        data: { id: householdId, name: 'Tag Assign', owner_user_id: userId, ledger_currency: 'RSD' },
      });
      const account = await prisma.client.accounts.create({
        data: { id: uuidv7(), kind: 'CASH', name: 'Cash', currency: 'RSD', opening_balance_minor: 0n },
      });
      accountId = account.id;
      tagA = (await tags.create(householdId, { name: 'tag-a' })).id;
      tagB = (await tags.create(householdId, { name: 'tag-b' })).id;
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

  function baseInput(overrides: Record<string, unknown> = {}) {
    return {
      accountId,
      kind: TransactionKind.EXPENSE,
      amountMinor: 100_00n,
      description: 'Tagged spend',
      occurredLocalDate: '2026-09-01',
      ...overrides,
    };
  }

  it('attaches Tags on create and returns them from getById and list', async () => {
    const created = await asTenant(() =>
      transactions.create(householdId, baseInput({ tagIds: [tagA, tagB] })),
    );
    expect(created.tags.map((tag) => tag.id).sort()).toEqual([tagA, tagB].sort());

    const fetched = await asTenant(() => transactions.getById(householdId, created.id));
    expect(fetched.tags.map((tag) => tag.id).sort()).toEqual([tagA, tagB].sort());

    const page = await asTenant(() => transactions.list(householdId, {}, {}));
    const listed = page.items.find((item) => item.id === created.id);
    expect(listed?.tags.map((tag) => tag.id).sort()).toEqual([tagA, tagB].sort());
  });

  it('creates with no tags when the argument is absent, so existing callers are unaffected', async () => {
    const created = await asTenant(() => transactions.create(householdId, baseInput()));
    expect(created.tags).toEqual([]);
  });

  it('replaces the Tag set on update, and clears it on an empty array', async () => {
    const created = await asTenant(() =>
      transactions.create(householdId, baseInput({ tagIds: [tagA, tagB] })),
    );

    const replaced = await asTenant(() =>
      transactions.update(householdId, created.id, { version: created.version, tagIds: [tagB] }),
    );
    expect(replaced.tags.map((tag) => tag.id)).toEqual([tagB]);

    const cleared = await asTenant(() =>
      transactions.update(householdId, replaced.id, { version: replaced.version, tagIds: [] }),
    );
    expect(cleared.tags).toEqual([]);
  });

  it('leaves the Tag set alone when `tagIds` is omitted', async () => {
    const created = await asTenant(() =>
      transactions.create(householdId, baseInput({ tagIds: [tagA] })),
    );

    const noteOnly = await asTenant(() =>
      transactions.update(householdId, created.id, {
        version: created.version,
        note: 'edited without touching tags',
      }),
    );
    expect(noteOnly.note).toBe('edited without touching tags');
    expect(noteOnly.tags.map((tag) => tag.id)).toEqual([tagA]);
  });

  it('refuses an unknown tag id with VALIDATION_FAILED on both create and update', async () => {
    const unknown = uuidv7();
    const createFailure = await asTenant(() =>
      transactions.create(householdId, baseInput({ tagIds: [unknown] })),
    ).catch((error) => error);
    expect(createFailure).toBeInstanceOf(ApiError);
    expect((createFailure as ApiError).code).toBe('VALIDATION_FAILED');

    const created = await asTenant(() => transactions.create(householdId, baseInput()));
    const updateFailure = await asTenant(() =>
      transactions.update(householdId, created.id, { version: created.version, tagIds: [unknown] }),
    ).catch((error) => error);
    expect(updateFailure).toBeInstanceOf(ApiError);
    expect((updateFailure as ApiError).code).toBe('VALIDATION_FAILED');
  });

  it('refuses another Household’s tag id rather than silently dropping it', async () => {
    const foreign = await runWithTenant(otherContext, () =>
      tags.create(otherHouseholdId, { name: 'foreign-tag' }),
    );
    const failure = await asTenant(() =>
      transactions.create(householdId, baseInput({ tagIds: [foreign.id] })),
    ).catch((error) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('VALIDATION_FAILED');
  });

  it('keeps the Transaction intact when a Tag is deleted underneath it', async () => {
    const created = await asTenant(() =>
      transactions.create(householdId, baseInput({ tagIds: [tagA, tagB] })),
    );
    await asTenant(() => tags.remove(householdId, tagA));

    const after = await asTenant(() => transactions.getById(householdId, created.id));
    expect(after.tags.map((tag) => tag.id)).toEqual([tagB]);
    expect(after.amount.amountMinor).toBe(100_00n);
  });
});
