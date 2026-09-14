import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@finmate/domain';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import { runWithTenant } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { MerchantsService } from './merchants.service';

/**
 * Merchants against a real database.
 *
 * The behaviours that matter here are the ones a unit test cannot reach: copy-on-write moves the
 * Household's references, merge moves them again and is all-or-nothing, and neither can touch
 * another Household's rows. All three are about *which rows changed*, which only Postgres can answer.
 */
describe('MerchantsService (integration)', () => {
  let moduleRef: TestingModule;
  let merchants: MerchantsService;
  let prisma: PrismaService;

  const householdId = uuidv7();
  const otherHouseholdId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();
  let accountId: string;
  let seededId: string;

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
    merchants = new MerchantsService(prisma);

    await prisma.client.users.create({
      data: { id: userId, email: `merch-${Date.now()}@example.com`, display_name: 'Merchants Test' },
    });
    await prisma.client.users.create({
      data: { id: otherUserId, email: `merch-b-${Date.now()}@example.com`, display_name: 'Other' },
    });
    await runWithTenant(context, async () => {
      await prisma.client.households.create({
        data: { id: householdId, name: 'Merchants Test', owner_user_id: userId },
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

    const [seeded] = await prisma.client.$queryRaw<{ id: string }[]>`
      SELECT id FROM merchants WHERE household_id IS NULL AND is_global = true ORDER BY name LIMIT 1
    `;
    seededId = seeded?.id as string;
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

  async function recordSpend(merchantId: string): Promise<string> {
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
          merchant_id: merchantId,
        },
      }),
    );
    return id;
  }

  it('sees the shipped catalogue plus its own rows, other Households excluded', async () => {
    await asTenant(() => merchants.create(householdId, { name: 'Moj Prodavac' }));
    await runWithTenant(otherContext, () =>
      merchants.create(otherHouseholdId, { name: 'Tudji Prodavac' }),
    );

    const page = await asTenant(() => merchants.list(householdId, {}, {}));
    const names = page.items.map((item) => item.name);

    expect(names).toContain('Moj Prodavac');
    expect(names).not.toContain('Tudji Prodavac');
    expect(page.totalCount).toBeGreaterThan(30);
  });

  it('refuses a name that folds to one already visible', async () => {
    await asTenant(() => merchants.create(householdId, { name: 'Folded Shop' }));
    await expect(
      asTenant(() => merchants.create(householdId, { name: '  folded   SHOP ' })),
    ).rejects.toThrow(/already exists/i);
  });

  it('folds aliases, drops blanks and duplicates, and replaces rather than appends', async () => {
    const created = await asTenant(() => merchants.create(householdId, { name: 'Alias Shop' }));
    const withAliases = await asTenant(() =>
      merchants.setAliases(householdId, created.id, ['Šećer', 'Đorđe', 'secEr', '', '  ']),
    );
    expect(withAliases.aliases.map((alias) => alias.alias)).toEqual(['dorde', 'secer']);

    const replaced = await asTenant(() =>
      merchants.setAliases(householdId, created.id, ['only-one']),
    );
    expect(replaced.aliases.map((alias) => alias.alias)).toEqual(['only-one']);
  });

  it('copies a global merchant on write and moves this Household onto the copy', async () => {
    const [before] = await prisma.client.$queryRaw<{ ai_hint: string | null }[]>`
      SELECT ai_hint FROM merchants WHERE id = ${seededId}::uuid
    `;
    const transactionId = await recordSpend(seededId);

    const updated = await asTenant(() =>
      merchants.update(householdId, seededId, { aiHint: 'mine now' }),
    );

    expect(updated.isGlobal).toBe(false);
    expect(updated.isOwnedByHousehold).toBe(true);
    expect(updated.aiHint).toBe('mine now');
    expect(updated.id).not.toBe(seededId);

    // The reference moved, which is what makes the edit visible on existing history.
    const moved = await asTenant(() =>
      prisma.client.transactions.findFirst({ where: { id: transactionId } }),
    );
    expect(moved?.merchant_id).toBe(updated.id);

    // The platform row is untouched.
    const [after] = await prisma.client.$queryRaw<{ ai_hint: string | null }[]>`
      SELECT ai_hint FROM merchants WHERE id = ${seededId}::uuid
    `;
    expect(after?.ai_hint).toBe(before?.ai_hint);
  });

  it('copies a global TARGET when merging into it, because the alias union is a write', async () => {
    const source = await asTenant(() => merchants.create(householdId, { name: 'Into Global' }));
    await asTenant(() => merchants.setAliases(householdId, source.id, ['only-on-source']));

    const [globalBefore] = await prisma.client.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM merchant_aliases WHERE merchant_id = ${seededId}::uuid
    `;

    const merged = await asTenant(() => merchants.merge(householdId, source.id, seededId));

    // The merge landed on an owned copy, not on the platform row.
    expect(merged.isGlobal).toBe(false);
    expect(merged.isOwnedByHousehold).toBe(true);
    expect(merged.id).not.toBe(seededId);
    expect(merged.aliases.map((alias) => alias.alias)).toContain('only-on-source');

    const [globalAfter] = await prisma.client.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM merchant_aliases WHERE merchant_id = ${seededId}::uuid
    `;
    expect(globalAfter?.n).toBe(globalBefore?.n);
  });

  it('refuses to delete a shipped merchant', async () => {
    await expect(asTenant(() => merchants.remove(seededId))).rejects.toThrow(/shipped merchant/i);
  });

  it('refuses to delete a merchant that is still referenced, and names merging', async () => {
    const created = await asTenant(() => merchants.create(householdId, { name: 'In Use Shop' }));
    await recordSpend(created.id);

    const failure = await asTenant(() => merchants.remove(created.id)).catch((error) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('CONFLICT');
    expect((failure as Error).message).toMatch(/merge/i);
  });

  it('merges: moves references, unions aliases, and deletes the source', async () => {
    const source = await asTenant(() => merchants.create(householdId, { name: 'Merge Source' }));
    const target = await asTenant(() => merchants.create(householdId, { name: 'Merge Target' }));
    await asTenant(() => merchants.setAliases(householdId, source.id, ['from-source', 'shared']));
    await asTenant(() => merchants.setAliases(householdId, target.id, ['from-target', 'shared']));
    const transactionId = await recordSpend(source.id);

    const merged = await asTenant(() => merchants.merge(householdId, source.id, target.id));

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
    expect(moved?.merchant_id).toBe(target.id);

    // The source is gone from the Household's view.
    await expect(asTenant(() => merchants.getById(householdId, source.id))).rejects.toThrow(
      /not found/i,
    );
  });

  it('refuses to merge a shipped merchant away, or a merchant into itself', async () => {
    const owned = await asTenant(() => merchants.create(householdId, { name: 'Merge Guard' }));
    await expect(asTenant(() => merchants.merge(householdId, seededId, owned.id))).rejects.toThrow(
      /shipped merchant/i,
    );
    await expect(asTenant(() => merchants.merge(householdId, owned.id, owned.id))).rejects.toThrow(
      /itself/i,
    );
  });

  it('cannot reach another Household\u2019s merchant at all', async () => {
    const foreign = await runWithTenant(otherContext, () =>
      merchants.create(otherHouseholdId, { name: 'Foreign Shop' }),
    );

    await expect(asTenant(() => merchants.getById(householdId, foreign.id))).rejects.toThrow(
      /not found/i,
    );
    // A merge must not be able to move rows through an id it merely guessed.
    await expect(asTenant(() => merchants.merge(householdId, foreign.id, seededId))).rejects.toThrow(
      /not found/i,
    );
  });
});
