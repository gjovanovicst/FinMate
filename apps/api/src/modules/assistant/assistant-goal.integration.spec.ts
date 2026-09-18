import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@finmate/domain';

import type { RedisService } from '../../common/redis/redis.service';
import { runWithTenant, type TenantContext } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { GoalsService } from '../goals/goals.service';
import { AssistantModule } from './assistant.module';
import { AssistantResolver } from './assistant.resolver';
import { PendingActionStore } from './pending-action.store';

/**
 * `ADD_GOAL` against a real Postgres — task B-4b, docs/16 B.4.
 *
 * The one action whose name is not taken from an anchor: the text is *"Letovanje 200000"*, the parser
 * removes the amount, and what is left is the name — in the user's own characters, because a goal is
 * called what they called it. The card then says it has **no deadline**, which is a fact and not a
 * default: relative dates have no parser (docs/16 B.3), and `GOAL_REQUIRED_MONTHLY` needs a date to
 * answer at all, so the sentence must not imply one was set.
 */
describe('assistant ADD_GOAL (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let goals: GoalsService;
  let resolver: AssistantResolver;

  const householdId = uuidv7();
  const userId = uuidv7();

  const context: TenantContext = { householdId, userId, role: 'OWNER', requestId: 'goal-it' };
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

  const propose = (question: string) =>
    asTenant(() => resolver.assistantProposeAction(context, question, undefined, undefined, 'sr-Latn'));

  const execute = (proposalId: string, key: string = uuidv7()) =>
    asTenant(() => resolver.assistantExecuteAction(context, proposalId, key));

  const goalsOf = () => asTenant(() => goals.list(householdId));

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule, AuthModule, AssistantModule],
    })
      .overrideProvider(PendingActionStore)
      .useValue(memoryStore())
      .compile();
    prisma = moduleRef.get(PrismaService);
    goals = moduleRef.get(GoalsService);
    resolver = moduleRef.get(AssistantResolver);

    const stamp = Date.now();
    await prisma.client.users.create({
      data: { id: userId, email: `goal-${stamp}@example.com`, display_name: 'Goal Test' },
    });
    await asTenant(() =>
      prisma.client.households.create({
        data: {
          id: householdId,
          name: 'Goal Test',
          owner_user_id: userId,
          ledger_currency: 'RSD',
          iana_timezone: 'Europe/Belgrade',
        },
      }),
    );
  });

  afterAll(async () => {
    await asTenant(() => prisma.client.households.deleteMany({ where: { id: householdId } }));
    await prisma.client.users.deleteMany({ where: { id: userId } });
    await moduleRef.close();
  });

  it('proposes a goal with the name and the target out of the text, and writes nothing', async () => {
    const before = await goalsOf();
    const proposal = await propose('napravi cilj Letovanje 200000');

    expect(proposal.proposed).toBe(true);
    expect(proposal.action).toBe('ADD_GOAL');
    // The name keeps the user's characters — `cleanName` strips quotes and punctuation, not case.
    expect(proposal.preview?.diff.find((entry) => entry.slot === 'name')?.after).toBe('Letovanje');
    expect(proposal.preview?.sentence).toContain('Letovanje');
    expect(proposal.preview?.sentence).toContain('200.000,00');
    expect(await goalsOf()).toHaveLength(before.length);
  });

  it('carries the target as Money, and says the goal has no deadline', async () => {
    const proposal = await propose('napravi cilj Rođendan 30000');
    const diff = proposal.preview?.diff ?? [];

    const target = diff.find((entry) => entry.slot === 'targetMinor');
    expect(target?.afterMoney?.amountMinor).toBe(3000000n);
    expect(target?.afterMoney?.currency).toBe('RSD');
    expect(target?.afterValue).toBe('3000000');
    expect(target?.defaulted).toBe(false);
    // Diacritics survive, which is the whole reason the name is taken from the parser's own description
    // rather than from a folded token.
    expect(diff.find((entry) => entry.slot === 'name')?.after).toBe('Rođendan');

    // The deadline is **stated**, not offered: no parser exists for `sledeći petak`, so the action does
    // not fill one and the card must not imply it did.
    const deadline = diff.find((entry) => entry.slot === 'targetDate');
    expect(deadline?.after).toBe('još bez roka');
    expect(deadline?.defaulted).toBe(false);
  });

  it('writes the goal through the same service /goals uses, with no target date', async () => {
    const proposal = await propose('napravi cilj Letovanje 200000');
    if (!proposal.proposed || proposal.proposalId === null) throw new Error('expected a proposal');

    const executed = await execute(proposal.proposalId);
    expect(executed.undo).toBe('SOFT_DELETE');
    expect(executed.sentence).toContain('Letovanje');

    const rows = (await goalsOf()).filter((goal) => goal.id === executed.createdId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Letovanje');
    expect(rows[0]?.targetMinor).toBe(20000000n);
    expect(rows[0]?.targetDate).toBeNull();
    expect(rows[0]?.currency).toBe('RSD');
    // A goal with no deadline has no monthly requirement — which is why the card says so.
    expect(rows[0]?.requiredPerMonthMinor).toBeNull();
  });

  it('keeps a Cyrillic name Cyrillic', async () => {
    const proposal = await propose('направи циљ Путовања 120000');
    if (!proposal.proposed || proposal.proposalId === null) throw new Error('expected a proposal');

    expect(proposal.preview?.diff.find((entry) => entry.slot === 'name')?.after).toBe('Путовања');
    const executed = await execute(proposal.proposalId);
    const row = (await goalsOf()).find((goal) => goal.id === executed.createdId);
    expect(row?.name).toBe('Путовања');
  });

  it('refuses a target with no name, naming the slot the card can ask about', async () => {
    const proposal = await propose('napravi cilj 200000');

    expect(proposal.proposed).toBe(false);
    expect(proposal.reason).toBe('UNRUNNABLE:name');
  });

  it('refuses a phrase with no amount, and one the parser reads two ways', async () => {
    const noAmount = await propose('napravi cilj Letovanje');
    expect(noAmount.proposed).toBe(false);
    expect(noAmount.reason).toBe('NO_AMOUNT');

    const ambiguous = await propose('napravi cilj Letovanje 1.200');
    expect(ambiguous.proposed).toBe(false);
    expect(ambiguous.reason).toBe('AMBIGUOUS_AMOUNT');
  });

  it('answers a repeated idempotency key with the same row, and writes nothing twice', async () => {
    const proposal = await propose('napravi cilj Bicikl 45000');
    if (!proposal.proposed || proposal.proposalId === null) throw new Error('expected a proposal');
    const key = uuidv7();

    const first = await execute(proposal.proposalId, key);
    const retry = await execute(proposal.proposalId, key);

    expect(retry.replayed).toBe(true);
    expect(retry.createdId).toBe(first.createdId);
    expect((await goalsOf()).filter((goal) => goal.id === first.createdId)).toHaveLength(1);
  });
});
