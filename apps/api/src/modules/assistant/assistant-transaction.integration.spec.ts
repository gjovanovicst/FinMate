import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@finmate/domain';

import type { RedisService } from '../../common/redis/redis.service';
import { runWithTenant, type TenantContext } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { AuthModule } from '../auth/auth.module';
import { AssistantModule } from './assistant.module';
import { AssistantResolver } from './assistant.resolver';
import { PendingActionStore } from './pending-action.store';

/**
 * `ADD_TRANSACTION` against a real Postgres — task B-3a, docs/16 B.3.
 *
 * What matters here is that the assistant performs **the capture path** and not a copy of it. The row
 * it offers is what `ClassificationService.parse` produced, the row it writes goes through
 * `TransactionsService.captureCommit` — the same method `/capture`'s Confirm calls — and the decision
 * the card showed is the decision the write reuses, so the pipeline runs **once** and the category the
 * human approved is the category stored. Each of those is invisible to a unit test and is exactly
 * where a second, subtly different write path would appear.
 *
 * The proposal store runs over an in-memory stand-in for Redis; `pending-action.store.spec.ts` covers
 * the real client's semantics (atomic `GETDEL`, TTL, fail-closed) separately.
 */
describe('assistant ADD_TRANSACTION (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let accounts: AccountsService;
  let resolver: AssistantResolver;

  const householdId = uuidv7();
  const emptyHouseholdId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();

  const context: TenantContext = { householdId, userId, role: 'OWNER', requestId: 'tx-it' };
  const asTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(context, fn);

  let olderAccountId: string;
  let newestAccountId: string;

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

  // `runWithTenant` around every resolver call: `@CurrentTenant()` is a *decorator* whose value Nest
  // injects during GraphQL execution, so a direct method call has to establish the context itself —
  // and without it the first household-scoped query throws (which is ADR-008 working).
  const propose = (
    question: string,
    extra: { kind?: 'EXPENSE' | 'INCOME'; accountId?: string } = {},
    tenant: TenantContext = context,
  ) =>
    runWithTenant(tenant, () =>
      resolver.assistantProposeAction(tenant, question, extra.kind, extra.accountId, 'sr-Latn'),
    );

  const execute = (proposalId: string, idempotencyKey: string = uuidv7()) =>
    asTenant(() => resolver.assistantExecuteAction(context, proposalId, idempotencyKey));

  const transactions = () =>
    asTenant(() => prisma.client.transactions.findMany({ where: { household_id: householdId } }));

  beforeAll(async () => {
    // The **real** modules, with only the store replaced: this is also what proves
    // `AssistantModule` imports `ClassificationModule` and `AccountsModule`, which `ADD_TRANSACTION`
    // needs and an earlier hand-built fixture would not have noticed (docs/15).
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule, AuthModule, AssistantModule],
    })
      .overrideProvider(PendingActionStore)
      .useValue(memoryStore())
      .compile();
    prisma = moduleRef.get(PrismaService);
    accounts = moduleRef.get(AccountsService);
    // Through the **resolver**, so the question goes where a person's question goes: the planner
    // extracts the text (`dodaj trošak kafa 180` → `kafa 180`) and the service classifies it. Calling
    // the service directly would have skipped the extraction, and the row's description would have
    // been the whole question — which is how this suite first failed.
    resolver = moduleRef.get(AssistantResolver);

    const stamp = Date.now();
    await prisma.client.users.createMany({
      data: [
        { id: userId, email: `tx-${stamp}@example.com`, display_name: 'Transaction Test' },
        { id: otherUserId, email: `tx-b-${stamp}@example.com`, display_name: 'Other' },
      ],
    });
    await asTenant(() =>
      prisma.client.households.create({
        data: {
          id: householdId,
          name: 'Transaction Test',
          owner_user_id: userId,
          ledger_currency: 'RSD',
          iana_timezone: 'Europe/Belgrade',
        },
      }),
    );
    // A Household with nothing to write into — the `UNRUNNABLE:accountId` case.
    await runWithTenant({ ...context, householdId: emptyHouseholdId }, () =>
      prisma.client.households.create({
        data: {
          id: emptyHouseholdId,
          name: 'No accounts',
          owner_user_id: userId,
          ledger_currency: 'RSD',
        },
      }),
    );

    await asTenant(async () => {
      const food = await prisma.client.categories.create({
        data: { id: uuidv7(), name: 'Hrana', kind: 'EXPENSE' },
      });
      const salary = await prisma.client.categories.create({
        data: { id: uuidv7(), name: 'Plata', kind: 'INCOME' },
      });
      // Deterministic keywords at the weight §5.4 needs to decide alone, so the category on the card
      // is the tree's answer rather than a model's — and so this suite needs no provider.
      await prisma.client.category_keywords.createMany({
        data: [
          { id: uuidv7(), category_id: food.id, keyword: 'kafa', polarity: 'INCLUDE', match_mode: 'WORD', weight: 2 },
          { id: uuidv7(), category_id: salary.id, keyword: 'plata', polarity: 'INCLUDE', match_mode: 'WORD', weight: 3 },
        ],
      });
    });

    const first = await asTenant(() =>
      accounts.create(householdId, { name: 'Tekući', kind: 'BANK' } as never),
    );
    olderAccountId = first.id;
    // A second account, so "which one did it pick" is a real question rather than a formality —
    // `AccountsService.list` orders by the UUIDv7 key descending, so this is the one `/capture`
    // preselects too.
    const second = await asTenant(() =>
      accounts.create(householdId, { name: 'Keš', kind: 'CASH' } as never),
    );
    newestAccountId = second.id;
  });

  afterAll(async () => {
    for (const id of [householdId, emptyHouseholdId]) {
      await runWithTenant({ ...context, householdId: id }, () =>
        prisma.client.households.deleteMany({ where: { id } }),
      );
    }
    await prisma.client.users.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await moduleRef.close();
  });

  it('proposes the row the pipeline produced, and writes nothing', async () => {
    const before = await transactions();
    const outcome = await propose('dodaj trošak kafa 180');

    expect(outcome.proposed).toBe(true);
    if (!outcome.proposed) return;
    expect(outcome.action).toBe('ADD_TRANSACTION');
    const line = outcome.preview?.lines[0];
    // The amount is minor units for `fm-money`, not a formatted string: a figure the client renders
    // itself is the only way ADR-003's "one money formatter" survives.
    expect(line?.amount.amountMinor).toBe(18000n);
    expect(line?.amount.currency).toBe('RSD');
    // The parser's own description, which is the text **without** the amount — the same string the
    // capture screen shows and stores, so the two surfaces cannot disagree about what a row says.
    expect(line?.label).toBe('kafa');
    expect(line?.category).toBe('Hrana');
    expect(line?.needsReview).toBe(false);
    expect(outcome.preview?.sentence).toContain('180,00');
    expect(outcome.preview?.sentence).toContain('Hrana');

    // The account is filled by the proposal and flagged, so the card can offer to change it.
    const accountRow = outcome.preview?.diff.find((entry) => entry.slot === 'accountId');
    expect(accountRow?.defaulted).toBe(true);
    expect(accountRow?.afterValue).toBe(newestAccountId);
    // A direction the text stated is **not** flagged: a kind the user gave is not a suggestion.
    expect(outcome.preview?.diff.find((entry) => entry.slot === 'kind')?.defaulted).toBe(false);

    expect(await transactions()).toHaveLength(before.length);
  });

  it('writes the approved row through captureCommit, reusing the decision it showed', async () => {
    const decisionsBefore = await asTenant(() =>
      prisma.client.classification_decisions.count({ where: { household_id: householdId } }),
    );
    const outcome = await propose('dodaj trošak kafa 180');
    if (!outcome.proposed || outcome.proposalId === null) throw new Error('expected a proposal');

    const executed = await execute(outcome.proposalId);

    expect(executed.replayed).toBe(false);
    expect(executed.undo).toBe('UNDO_CAPTURE');
    expect(executed.sentence).toContain('180,00');
    expect(executed.sentence).toContain('kafa');

    const row = await asTenant(() =>
      prisma.client.transactions.findFirst({ where: { id: executed.createdId } }),
    );
    expect(row?.amount_minor).toBe(18000n);
    expect(row?.kind).toBe('EXPENSE');
    expect(row?.account_id).toBe(newestAccountId);
    expect(row?.status).toBe('CONFIRMED');
    // The description the card showed, not the whole question.
    expect(row?.description).toBe('kafa');

    // **The pipeline ran once.** The row names the decision `propose` created, so `captureCommit` read
    // that decision's category instead of classifying again — `allowAi: false` is the same statement
    // from the other side, and a second decision here would be a second model call in production.
    const decisions = await asTenant(() =>
      prisma.client.classification_decisions.findMany({
        where: { household_id: householdId },
        orderBy: { id: 'desc' },
      }),
    );
    expect(decisions).toHaveLength(decisionsBefore + 1);
    const decision = decisions[0];
    expect(row?.category_id).toBe(decision?.category_id);
    expect(decision?.transaction_id).toBe(executed.createdId);
  });

  it('answers a repeated idempotency key with the same row, and writes nothing twice', async () => {
    const outcome = await propose('dodaj trošak kafa 180');
    if (!outcome.proposed || outcome.proposalId === null) throw new Error('expected a proposal');
    const key = uuidv7();

    const first = await execute(outcome.proposalId, key);
    const retry = await execute(outcome.proposalId, key);

    expect(retry.replayed).toBe(true);
    expect(retry.createdId).toBe(first.createdId);
    // The retry wrote nothing: exactly one row carries the id the first call returned.
    const rows = (await transactions()).filter((row) => row.id === first.createdId);
    expect(rows).toHaveLength(1);
  });

  it('refuses a text that reads as more than one entry, naming it as a refusal', async () => {
    // One row is the whole of v1's `ADD_TRANSACTION`: a card that showed only the first of two entries
    // would misdescribe what the button does, and the capture screen is where a batch belongs.
    const outcome = await propose('dodaj trošak kafa 180 i hleb 90');

    expect(outcome.proposed).toBe(false);
    if (outcome.proposed) return;
    expect(outcome.reason).toBe('MULTIPLE_ROWS');
  });

  it('refuses a text with no amount in it', async () => {
    const outcome = await propose('dodaj trošak kafu');

    expect(outcome.proposed).toBe(false);
    if (outcome.proposed) return;
    expect(outcome.reason).toBe('NO_AMOUNT');
  });

  it('refuses an amount the parser reads two ways rather than guessing one', async () => {
    // `1.200` is 1200 and 1.2, and the wrong reading is a tenfold error in the user's money. The
    // capture screen refuses the batch until the user picks; a card cannot ask, so it must not guess
    // (ADR-003, docs/04 §3.1).
    const outcome = await propose('dodaj trošak kafa 1.200');

    expect(outcome.proposed).toBe(false);
    if (outcome.proposed) return;
    expect(outcome.reason).toBe('AMBIGUOUS_AMOUNT');
  });

  it('refuses when there is no account to write into, and says which slot is missing', async () => {
    const outcome = await propose('dodaj trošak kafa 180', {}, {
      ...context,
      householdId: emptyHouseholdId,
    });

    expect(outcome.proposed).toBe(false);
    if (outcome.proposed) return;
    expect(outcome.reason).toBe('UNRUNNABLE:accountId');
  });

  it('fills the direction visibly when the text states none, and re-proposes with the other one', async () => {
    // The parser found no direction signal, so the proposal picks the capture path's default and
    // *says so* — guessing silently is not an option and guessing visibly is (ADR-035 decision 5).
    const first = await propose('dodaj trošak storno 5000');
    expect(first.proposed).toBe(true);
    if (!first.proposed || first.proposalId === null) return;
    const kindRow = first.preview?.diff.find((entry) => entry.slot === 'kind');
    expect(kindRow?.defaulted).toBe(true);
    expect(kindRow?.afterValue).toBe('EXPENSE');

    // The card's toggle: a **new** proposal, so the id a person confirms names what they were shown.
    const second = await propose('dodaj trošak storno 5000', { kind: 'INCOME' });
    expect(second.proposed).toBe(true);
    if (!second.proposed || second.proposalId === null) return;
    expect(second.proposalId).not.toBe(first.proposalId);
    const changed = second.preview?.diff.find((entry) => entry.slot === 'kind');
    expect(changed?.afterValue).toBe('INCOME');
    // The flag stays **true**: it records that the *question* never stated the direction, which is what
    // keeps the toggle on the card. Clearing it on use would make the choice one-way — the second click
    // would find no control to click back.
    expect(changed?.defaulted).toBe(true);

    // …and the confirmed row carries the kind that was confirmed, on the account that was shown.
    const executed = await execute(second.proposalId);
    const row = await asTenant(() =>
      prisma.client.transactions.findFirst({ where: { id: executed.createdId } }),
    );
    expect(row?.kind).toBe('INCOME');
  });

  it('honours an account the caller names instead of the preselected one', async () => {
    const outcome = await propose('dodaj trošak kafa 180', { accountId: olderAccountId });
    if (!outcome.proposed || outcome.proposalId === null) throw new Error('expected a proposal');

    expect(outcome.preview?.diff.find((entry) => entry.slot === 'accountId')?.afterValue).toBe(
      olderAccountId,
    );
    const executed = await execute(outcome.proposalId);
    const row = await asTenant(() =>
      prisma.client.transactions.findFirst({ where: { id: executed.createdId } }),
    );
    expect(row?.account_id).toBe(olderAccountId);
  });

  it('refuses an account the Household cannot use, before offering a button for it', async () => {
    await expect(
      propose('dodaj trošak kafa 180', { accountId: uuidv7() }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
