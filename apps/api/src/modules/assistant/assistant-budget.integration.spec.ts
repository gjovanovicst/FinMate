import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@finmate/domain';

import type { RedisService } from '../../common/redis/redis.service';
import { runWithTenant, type TenantContext } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { BudgetsService } from '../budgeting/budgets.service';
import { AssistantModule } from './assistant.module';
import { AssistantResolver } from './assistant.resolver';
import { PendingActionStore } from './pending-action.store';

/**
 * `SET_BUDGET` against a real Postgres — task B-4a, docs/16 B.4.
 *
 * The interesting properties are not "it writes a row":
 *
 * - the Category is resolved by **the same ladder a question uses**, so a budget and the answer beside
 *   it cannot scope different Categories;
 * - a phrase that names no Category the tree can resolve is **refused**, not turned into a
 *   Household-wide budget — a typo must not become a limit over every Category (R-29);
 * - an existing budget is **refused rather than overwritten**, because the undo (`deleteBudget`) is only
 *   correct while the action creates — and that refusal is what the registry's `undo` claim rests on.
 */
describe('assistant SET_BUDGET (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let budgets: BudgetsService;
  let resolver: AssistantResolver;

  const householdId = uuidv7();
  const userId = uuidv7();

  const context: TenantContext = { householdId, userId, role: 'OWNER', requestId: 'budget-it' };
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

  const budgetsOf = () => asTenant(() => budgets.list(householdId));

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule, AuthModule, AssistantModule],
    })
      .overrideProvider(PendingActionStore)
      .useValue(memoryStore())
      .compile();
    prisma = moduleRef.get(PrismaService);
    budgets = moduleRef.get(BudgetsService);
    resolver = moduleRef.get(AssistantResolver);

    const stamp = Date.now();
    await prisma.client.users.create({
      data: { id: userId, email: `budget-${stamp}@example.com`, display_name: 'Budget Test' },
    });
    await asTenant(() =>
      prisma.client.households.create({
        data: {
          id: householdId,
          name: 'Budget Test',
          owner_user_id: userId,
          ledger_currency: 'RSD',
          iana_timezone: 'Europe/Belgrade',
        },
      }),
    );
    await asTenant(async () => {
      const food = await prisma.client.categories.create({
        data: { id: uuidv7(), name: 'Hrana', kind: 'EXPENSE' },
      });
      const fuel = await prisma.client.categories.create({
        data: { id: uuidv7(), name: 'Gorivo', kind: 'EXPENSE' },
      });
      // The tree's own vocabulary, so the keyword rung resolves the way a question does — the same
      // reason `categoryEntities` is shared with the read planner.
      await prisma.client.category_keywords.createMany({
        data: [
          { id: uuidv7(), category_id: food.id, keyword: 'namirnice', polarity: 'INCLUDE', match_mode: 'WORD', weight: 2 },
          { id: uuidv7(), category_id: fuel.id, keyword: 'benzin', polarity: 'INCLUDE', match_mode: 'WORD', weight: 2 },
        ],
      });
    });
  });

  afterAll(async () => {
    await asTenant(() => prisma.client.households.deleteMany({ where: { id: householdId } }));
    await prisma.client.users.deleteMany({ where: { id: userId } });
    await moduleRef.close();
  });

  it('proposes a monthly limit for the Category the phrase names, and writes nothing', async () => {
    const before = await budgetsOf();
    const proposal = await propose('postavi budžet za hranu na 20000');

    expect(proposal.proposed).toBe(true);
    expect(proposal.action).toBe('SET_BUDGET');
    expect(proposal.preview?.sentence).toContain('Hrana');
    expect(proposal.preview?.sentence).toContain('20.000,00');
    expect(await budgetsOf()).toHaveLength(before.length);
  });

  it('carries the amount as Money and the Category as a resolved slot', async () => {
    const proposal = await propose('postavi budžet za gorivo na 8000');
    const diff = proposal.preview?.diff ?? [];

    const amount = diff.find((entry) => entry.slot === 'amountMinor');
    // The client draws this with `fm-money`; the string label is only for a reader who never looks.
    expect(amount?.afterMoney?.amountMinor).toBe(800000n);
    expect(amount?.afterMoney?.currency).toBe('RSD');
    expect(amount?.afterValue).toBe('800000');
    // The Category is **stated** by the phrase rather than filled by the proposal, so it is not a
    // default and the card offers no control for it.
    expect(diff.find((entry) => entry.slot === 'categoryId')?.defaulted).toBe(false);
    // The period is a fixed part of what this action means — monthly — and says so rather than
    // pretending it could be changed here.
    expect(diff.find((entry) => entry.slot === 'period')?.defaulted).toBe(false);
  });

  it('writes the budget through the same service /budgets uses, for the current month', async () => {
    const proposal = await propose('postavi budžet za hranu na 20000');
    if (!proposal.proposed || proposal.proposalId === null) throw new Error('expected a proposal');

    const executed = await execute(proposal.proposalId);
    expect(executed.undo).toBe('SOFT_DELETE');
    expect(executed.sentence).toContain('Hrana');

    const rows = (await budgetsOf()).filter((budget) => budget.id === executed.createdId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount.amountMinor).toBe(2000000n);
    expect(rows[0]?.period).toBe('MONTHLY');
    expect(rows[0]?.categoryName).toBe('Hrana');
    // The row names the Category the phrase resolved, which is the id the executor stored.
    const category = await asTenant(() =>
      prisma.client.categories.findFirst({ where: { household_id: householdId, name: 'Hrana' } }),
    );
    expect(rows[0]?.categoryId).toBe(category?.id);
  });

  it('refuses to overwrite a budget that already exists, and says so rather than applying it', async () => {
    // The undo is `deleteBudget`, which is only correct while the action **creates**. Overwriting would
    // have to restore the previous amount, and that operation does not exist in this build — so the
    // proposal refuses and the reader is sent to the screen that owns a change.
    const before = (await budgetsOf()).find((budget) => budget.categoryName === 'Hrana');
    const proposal = await propose('promeni budžet za hranu na 25000');

    expect(proposal.proposed).toBe(false);
    expect(proposal.reason).toBe('ALREADY_SET');
    const after = (await budgetsOf()).find((budget) => budget.categoryName === 'Hrana');
    expect(after?.amount.amountMinor).toBe(before?.amount.amountMinor);
  });

  it('resolves an inflected name, because the ladder that answers questions is the one that scopes this', async () => {
    // `hranuu` is not a word, and it still resolves: `sharesStem` exists so that `hranu` matches `Hrana`
    // — the ask is *"koliko sam potrošio na hranu?"* — and the write side must not be stricter about the
    // same word than the answer beside it. So it proposes, and the card shows the Category it chose.
    const proposal = await propose('postavi budžet za hranuu na 20000');
    expect(proposal.proposed).toBe(false);
    // (Refused here only because a `Hrana` budget already exists from the test above — the resolution
    // itself is what this asserts, and `ALREADY_SET` proves it found the Category.)
    expect(proposal.reason).toBe('ALREADY_SET');
  });

  it('refuses a phrase that names no Category the tree can resolve', async () => {
    // A word the tree does not have must not become a Household-wide limit: that budget is set on
    // `/budgets`, where the choice is explicit. The refusal names the missing slot so the card can ask.
    const proposal = await propose('postavi budžet za kjuhtgfrdes na 20000');

    expect(proposal.proposed).toBe(false);
    expect(proposal.reason).toBe('UNRUNNABLE:categoryId');
  });

  it('refuses a phrase with no amount, and one the parser reads two ways', async () => {
    const noAmount = await propose('postavi budžet za gorivo');
    expect(noAmount.proposed).toBe(false);
    expect(noAmount.reason).toBe('NO_AMOUNT');

    const ambiguous = await propose('postavi budžet za gorivo na 1.200');
    expect(ambiguous.proposed).toBe(false);
    expect(ambiguous.reason).toBe('AMBIGUOUS_AMOUNT');
  });

  it('resolves a Category through the tree vocabulary, exactly as a question does', async () => {
    // `benzin` is an `INCLUDE` keyword on `Gorivo` and names no Category itself; the read planner answers
    // a spend question scoped by it, so the write planner must scope the same Category.
    const proposal = await propose('postavi budžet za benzin na 9000');
    expect(proposal.proposed).toBe(true);
    expect(proposal.preview?.sentence).toContain('Gorivo');
  });

  it('answers a repeated idempotency key with the same row, and writes nothing twice', async () => {
    const proposal = await propose('postavi budžet za benzin na 9000');
    if (!proposal.proposed || proposal.proposalId === null) throw new Error('expected a proposal');
    const key = uuidv7();

    const first = await execute(proposal.proposalId, key);
    const retry = await execute(proposal.proposalId, key);

    expect(retry.replayed).toBe(true);
    expect(retry.createdId).toBe(first.createdId);
    expect((await budgetsOf()).filter((budget) => budget.id === first.createdId)).toHaveLength(1);
  });
});
