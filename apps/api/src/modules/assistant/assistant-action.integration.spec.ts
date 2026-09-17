import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@finmate/domain';

import type { RedisService } from '../../common/redis/redis.service';
import { runWithTenant, type TenantContext } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { CategoriesService } from '../taxonomy/categories.service';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { AssistantActionService } from './assistant-action.service';
import { PendingActionStore } from './pending-action.store';

/**
 * Propose → Execute against a real database — ADR-035, docs/06 §8.16.
 *
 * What only Postgres can answer: that an approved `ADD_CATEGORY` **actually writes a Category** through
 * the same `CategoriesService.create` the `/categories` screen uses, that the duplicate rule the preview
 * checks is the one the index enforces, and that an executed proposal cannot be replayed into a second
 * row.
 *
 * The proposal store runs over an in-memory stand-in for Redis, so the suite needs no second piece of
 * infrastructure; `pending-action.store.spec.ts` covers the real client's semantics (atomic `GETDEL`,
 * TTL, fail-closed) separately.
 */
describe('assistant actions (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let categories: CategoriesService;
  let actions: AssistantActionService;

  const householdId = uuidv7();
  const otherHouseholdId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();

  const context: TenantContext = { householdId, userId, role: 'OWNER', requestId: 'actions-it' };
  const asTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(context, fn);

  function memoryStore(): PendingActionStore {
    const store = new Map<string, string>();
    const client = {
      set: async (key: string, value: string): Promise<'OK'> => {
        store.set(key, value);
        return 'OK';
      },
      getdel: async (key: string): Promise<string | null> => {
        const value = store.get(key) ?? null;
        store.delete(key);
        return value;
      },
      get: async (key: string): Promise<string | null> => store.get(key) ?? null,
    };
    return new PendingActionStore({ client } as unknown as RedisService);
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule, TaxonomyModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    categories = moduleRef.get(CategoriesService);
    actions = new AssistantActionService(categories, memoryStore());

    const stamp = Date.now();
    await prisma.client.users.createMany({
      data: [
        { id: userId, email: `actions-${stamp}@example.com`, display_name: 'Actions Test' },
        { id: otherUserId, email: `actions-b-${stamp}@example.com`, display_name: 'Other' },
      ],
    });
    for (const [ctx, id, owner, name] of [
      [context, householdId, userId, 'Actions Test'],
      [
        { ...context, householdId: otherHouseholdId, userId: otherUserId },
        otherHouseholdId,
        otherUserId,
        'Other',
      ],
    ] as const) {
      await runWithTenant(ctx, () =>
        prisma.client.households.create({
          data: { id, name, owner_user_id: owner, ledger_currency: 'RSD', iana_timezone: 'Europe/Belgrade' },
        }),
      );
    }
  });

  afterAll(async () => {
    // Deleted per Household under its own context: the guard scopes a household-scoped delete, so one
    // statement cannot reach both (ADR-008) — which is the guard working as intended.
    await asTenant(() => prisma.client.households.deleteMany({ where: { id: householdId } }));
    await runWithTenant({ ...context, householdId: otherHouseholdId, userId: otherUserId }, () =>
      prisma.client.households.deleteMany({ where: { id: otherHouseholdId } }),
    );
    await prisma.client.users.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await moduleRef.close();
  });

  const propose = (name: string, locale?: string) =>
    asTenant(() =>
      actions.propose({
        householdId,
        userId,
        action: 'ADD_CATEGORY',
        slots: { name },
        ...(locale === undefined ? {} : { locale }),
      }),
    );

  it('proposes without writing anything, and renders the card in the Household locale', async () => {
    const before = await asTenant(() => categories.list(householdId));
    const proposal = await propose('Putovanja', 'sr-Latn');

    expect(proposal.action).toBe('ADD_CATEGORY');
    expect(proposal.preview.sentence).toBe('Nova kategorija „Putovanja” (rashod, bez nadređene)');
    // `kind` is filled by the proposal rather than the question, and the card is told so — guessing
    // silently is not an option, guessing visibly is (ADR-035 decision 5). The row is found by its
    // **slot**, not by its label: the label is Serbian here, and a card that has to offer a control for
    // one row cannot depend on the Household's language to identify it.
    const kind = proposal.preview.diff.find((entry) => entry.slot === 'kind');
    expect(kind?.after).toBe('rashod');
    expect(kind?.defaulted).toBe(true);
    expect(kind?.field).toBe('vrsta');
    // …and the machine value travels with it, because the card's kind toggle has to know which option
    // is currently proposed without comparing the localized word "rashod" to anything.
    expect(kind?.afterValue).toBe('EXPENSE');

    // The proposal is a read.
    const after = await asTenant(() => categories.list(householdId));
    expect(after).toHaveLength(before.length);
  });

  it('executes the stored proposal, writing the Category through the same service the screen uses', async () => {
    const proposal = await propose('Zdravlje', 'en');

    const executed = await asTenant(() =>
      actions.execute({ householdId, proposalId: proposal.proposalId, idempotencyKey: uuidv7() }),
    );

    expect(executed.replayed).toBe(false);
    expect(executed.undo).toBe('SOFT_DELETE');
    const created = (await asTenant(() => categories.list(householdId))).find(
      (category) => category.id === executed.createdId,
    );
    expect(created?.name).toBe('Zdravlje');
    expect(created?.kind).toBe('EXPENSE');
  });

  it('answers a repeated idempotency key with the same result, and writes nothing twice', async () => {
    const proposal = await propose('Sport', 'en');
    const key = uuidv7();

    const first = await asTenant(() =>
      actions.execute({ householdId, proposalId: proposal.proposalId, idempotencyKey: key }),
    );
    const retry = await asTenant(() =>
      actions.execute({ householdId, proposalId: proposal.proposalId, idempotencyKey: key }),
    );

    expect(retry.replayed).toBe(true);
    expect(retry.createdId).toBe(first.createdId);
    const sport = (await asTenant(() => categories.list(householdId))).filter(
      (category) => category.name === 'Sport',
    );
    expect(sport).toHaveLength(1);
  });

  it('cannot execute the same proposal twice under different keys', async () => {
    const proposal = await propose('Kucni ljubimci', 'en');
    await asTenant(() =>
      actions.execute({ householdId, proposalId: proposal.proposalId, idempotencyKey: uuidv7() }),
    );

    await expect(
      asTenant(() =>
        actions.execute({ householdId, proposalId: proposal.proposalId, idempotencyKey: uuidv7() }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses an unknown or expired proposal', async () => {
    await expect(
      asTenant(() => actions.execute({ householdId, proposalId: uuidv7(), idempotencyKey: uuidv7() })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('cannot execute another Household\'s proposal', async () => {
    const proposal = await propose('Tudje', 'en');

    await expect(
      runWithTenant({ ...context, householdId: otherHouseholdId, userId: otherUserId }, () =>
        actions.execute({
          householdId: otherHouseholdId,
          proposalId: proposal.proposalId,
          idempotencyKey: uuidv7(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to offer a proposal whose write would fail on the duplicate rule', async () => {
    await propose('Rezervisano', 'en').then((first) =>
      asTenant(() =>
        actions.execute({ householdId, proposalId: first.proposalId, idempotencyKey: uuidv7() }),
      ),
    );

    // The preview must not offer a button for a write the index will refuse — and it must refuse for
    // the *same* rule, which is `(household, parent, lower(name))`.
    await expect(propose('rezervisano', 'en')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(propose('Rezervisano', 'en')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses an empty or oversized name at propose time', async () => {
    await expect(propose('   ', 'en')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(propose('x'.repeat(81), 'en')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
