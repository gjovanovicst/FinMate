import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@finmate/domain';

import type { RedisService } from '../../common/redis/redis.service';
import { runWithTenant, type TenantContext } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { CorrectionsService } from '../classification/corrections.service';
import { RulesService } from '../classification/rules.service';
import { AssistantModule } from './assistant.module';
import { AssistantResolver } from './assistant.resolver';
import { PendingActionStore } from './pending-action.store';

/**
 * `CREATE_RULE_FROM_CORRECTION` against a real Postgres — task B-5, docs/16 B.4 and ADR-010.
 *
 * The one action whose input is **already in the database**: a Correction has no name to match on, so a
 * question can only refer to one *deictically* — *"zapamti ovu ispravku"* — and this build reads that as
 * the Household's most recent correction. The suite therefore asserts the three things that make that
 * safe rather than surprising:
 *
 * 1. the card **shows which correction it used** (the row is flagged `defaulted`, "chosen for you"), so a
 *    wrong pick is visible before anyone confirms it;
 * 2. a phrase that tries to **name a different one** is refused rather than ignored (`UNRUNNABLE:correctionId`)
 *    — deriving from another correction is the wrong write R-29 is about;
 * 3. the four write-side gates are **mirrored at propose time** (`NO_CORRECTION`, `NO_RULE`,
 *    `ALREADY_LEARNED`, `SHADOWED`), so the card never offers a button that cannot work.
 */
describe('assistant CREATE_RULE_FROM_CORRECTION (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let resolver: AssistantResolver;
  let corrections: CorrectionsService;
  let rules: RulesService;

  const householdId = uuidv7();
  const emptyHouseholdId = uuidv7();
  const userId = uuidv7();

  const context: TenantContext = { householdId, userId, role: 'OWNER', requestId: 'rule-it' };
  const asTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(context, fn);

  let accountId: string;
  let foodId: string;

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

  const propose = (question: string) =>
    asTenant(() => resolver.assistantProposeAction(context, question, undefined, undefined, 'sr-Latn'));

  const execute = (proposalId: string, key: string = uuidv7()) =>
    asTenant(() => resolver.assistantExecuteAction(context, proposalId, key));

  const rulesOf = () => asTenant(() => rules.list(householdId));

  /** A Transaction with a correction on it — the state every proposal here starts from. */
  async function correct(description: string, toValue: string | null = foodId): Promise<string> {
    const transactionId = uuidv7();
    await asTenant(() =>
      prisma.client.transactions.create({
        data: {
          id: transactionId,
          household_id: householdId,
          account_id: accountId,
          kind: 'EXPENSE',
          amount_minor: 200000n,
          currency: 'RSD',
          description,
          occurred_at: new Date('2026-09-14T10:00:00Z'),
          occurred_local_date: new Date('2026-09-14'),
          source: 'MANUAL',
        },
      }),
    );
    const correction = await asTenant(() =>
      corrections.record(householdId, {
        transactionId,
        field: 'category',
        fromValue: null,
        toValue,
        wasAiSuggested: false,
      }),
    );
    return correction.id;
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule, AuthModule, AssistantModule],
    })
      .overrideProvider(PendingActionStore)
      .useValue(memoryStore())
      .compile();
    prisma = moduleRef.get(PrismaService);
    resolver = moduleRef.get(AssistantResolver);
    corrections = moduleRef.get(CorrectionsService);
    rules = moduleRef.get(RulesService);

    const stamp = Date.now();
    await prisma.client.users.create({
      data: { id: userId, email: `rule-${stamp}@example.com`, display_name: 'Rule Test' },
    });
    await asTenant(async () => {
      await prisma.client.households.create({
        data: {
          id: householdId,
          name: 'Rule Test',
          owner_user_id: userId,
          ledger_currency: 'RSD',
          iana_timezone: 'Europe/Belgrade',
        },
      });
      accountId = uuidv7();
      await prisma.client.accounts.create({
        data: { id: accountId, household_id: householdId, name: 'Tekući', kind: 'BANK', currency: 'RSD' },
      });
      const food = await prisma.client.categories.create({
        data: { id: uuidv7(), household_id: householdId, name: 'Hrana', kind: 'EXPENSE' },
      });
      foodId = food.id;
    });
    // A Household with no corrections at all — the `NO_CORRECTION` case.
    await runWithTenant({ ...context, householdId: emptyHouseholdId }, () =>
      prisma.client.households.create({
        data: { id: emptyHouseholdId, name: 'No corrections', owner_user_id: userId, ledger_currency: 'RSD' },
      }),
    );
  });

  afterAll(async () => {
    for (const id of [householdId, emptyHouseholdId]) {
      await runWithTenant({ ...context, householdId: id }, () =>
        prisma.client.households.deleteMany({ where: { id } }),
      );
    }
    await prisma.client.users.deleteMany({ where: { id: userId } });
    await moduleRef.close();
  });

  it('proposes the rule the latest correction synthesises, and writes nothing', async () => {
    const correctionId = await correct('Lidl 2000');
    const before = await rulesOf();

    const proposal = await propose('zapamti ovu ispravku');
    expect(proposal.proposed).toBe(true);
    if (!proposal.proposed) return;
    expect(proposal.action).toBe('CREATE_RULE_FROM_CORRECTION');
    expect(proposal.preview?.sentence).toContain('lidl');

    // The correction row: **which** one, in the reader's own words, and flagged as the app's choice —
    // the question said "this one" and the backend picked the newest.
    const correctionRow = proposal.preview?.diff.find((row) => row.slot === 'correctionId');
    expect(correctionRow?.defaulted).toBe(true);
    expect(correctionRow?.afterValue).toBe(correctionId);
    expect(correctionRow?.after).toContain('Lidl 2000');
    expect(correctionRow?.after).toContain('Hrana');

    // The rule's own clauses, rendered from the document that will be saved. `lidl` is the distinctive
    // token, stored **folded**, because `contains` compares folded text (docs/04 §5.2).
    const condition = proposal.preview?.diff.find((row) => row.slot === 'conditions');
    expect(condition?.after).toContain('lidl');
    const action = proposal.preview?.diff.find((row) => row.slot === 'actions');
    expect(action?.after).toBe('Hrana');
    expect(action?.afterValue).toBe(foodId);

    expect(await rulesOf()).toHaveLength(before.length);
  });

  it('writes the rule through the same service the screen calls, and links it to the correction', async () => {
    const correctionId = (await asTenant(() => corrections.latest(householdId)))!.id;
    const proposal = await propose('zapamti ovu ispravku');
    if (!proposal.proposed || proposal.proposalId === null) throw new Error('expected a proposal');

    const executed = await execute(proposal.proposalId);
    expect(executed.undo).toBe('SOFT_DELETE');
    expect(executed.sentence).toContain('lidl');

    const row = (await rulesOf()).find((rule) => rule.id === executed.createdId);
    expect(row?.origin).toBe('LEARNED');
    expect(row?.isActive).toBe(true);
    expect(row?.conditions).toEqual({ all: [{ field: 'text', op: 'contains', value: 'lidl' }] });
    expect(row?.actions).toEqual({ setCategoryId: foodId });
    // ADR-010's audit trail: the rule says which correction produced it.
    expect(row?.sourceCorrectionId).toBe(correctionId);
    const latest = await asTenant(() => corrections.latest(householdId));
    expect(latest?.rule_created_id).toBe(executed.createdId);
  });

  it('refuses a second rule from the same correction, rather than offering a doomed button', async () => {
    // The write would throw a GraphQL `CONFLICT`, whose copy is about a taken *name* — not what happened
    // here. The proposal refuses with its own reason instead, which is both honest and actionable.
    const proposal = await propose('zapamti ovu ispravku');

    expect(proposal.proposed).toBe(false);
    expect(proposal.reason).toBe('ALREADY_LEARNED');
    expect(proposal.preview).toBeNull();
  });

  it('refuses a phrase that tries to name a correction, instead of deriving from a different one', async () => {
    await correct('Maxi 1500');
    const before = await rulesOf();

    const proposal = await propose('zapamti ispravku za Lidl');

    expect(proposal.proposed).toBe(false);
    expect(proposal.reason).toBe('UNRUNNABLE:correctionId');
    expect(await rulesOf()).toHaveLength(before.length);
  });

  it('refuses when the correction has nothing to derive a rule from', async () => {
    // A correction with no corrected-to Category: `correctionSubject` answers `null`, because a rule's
    // whole action *is* the Category (ADR-010). A merchant or amount correction is the same shape.
    await correct('Maxi 1500', null);

    const proposal = await propose('zapamti ovu ispravku');

    expect(proposal.proposed).toBe(false);
    expect(proposal.reason).toBe('NO_RULE');
  });

  it('refuses when an existing rule would shadow the proposal', async () => {
    await correct('Tempo 900');
    // A rule that matches the same thing and wins on priority (lower wins, docs/04 §5.3.1), which is
    // exactly what `checkShadowing` refuses when the *product* proposed the rule.
    const shadow = await asTenant(() =>
      rules.create(householdId, {
        name: 'Ručno: tempo',
        priority: 1,
        conditions: { all: [{ field: 'text', op: 'contains', value: 'tempo' }] },
        actions: { setCategoryId: foodId },
        origin: 'USER',
      }),
    );

    const proposal = await propose('zapamti ovu ispravku');

    expect(proposal.proposed).toBe(false);
    expect(proposal.reason).toBe('SHADOWED');
    // …and it did not quietly write the rule the write would have refused.
    expect((await rulesOf()).some((rule) => rule.id === shadow.id)).toBe(true);
  });

  it('refuses when the Household has no correction at all', async () => {
    const proposal = await runWithTenant({ ...context, householdId: emptyHouseholdId }, () =>
      resolver.assistantProposeAction(
        { ...context, householdId: emptyHouseholdId },
        'zapamti ovu ispravku',
        undefined,
        undefined,
        'sr-Latn',
      ),
    );

    expect(proposal.proposed).toBe(false);
    expect(proposal.reason).toBe('NO_CORRECTION');
  });

  it('answers a repeated idempotency key with the same rule, and writes nothing twice', async () => {
    await correct('Pekara 300');
    const proposal = await propose('zapamti ovu ispravku');
    if (!proposal.proposed || proposal.proposalId === null) throw new Error('expected a proposal');
    const key = uuidv7();

    const first = await execute(proposal.proposalId, key);
    const retry = await execute(proposal.proposalId, key);

    expect(retry.replayed).toBe(true);
    expect(retry.createdId).toBe(first.createdId);
    expect((await rulesOf()).filter((rule) => rule.id === first.createdId)).toHaveLength(1);
  });

  it('plans a question that is not a command as no action at all', async () => {
    // The other half of the cue list: a question *about* rules or corrections must not become an offer
    // to write one.
    expect((await propose('koja ispravka je bila za Lidl')).reason).toBe('NOT_AN_ACTION');
    // `dodaj` is deliberately not this action's imperative (see `action-planner.ts`), so a request to
    // write a rule by hand is not turned into one derived from whatever the last correction happened to be.
    expect((await propose('dodaj pravilo Gorivo')).reason).toBe('NOT_AN_ACTION');
  });
});
