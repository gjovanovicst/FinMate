import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { monthPeriod, uuidv7, type LocalDate } from '@finmate/domain';

import { runWithTenant, type TenantContext } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AccountsModule } from '../accounts/accounts.module';
import { BudgetingModule } from '../budgeting/budgeting.module';
import { LedgerModule } from '../ledger/ledger.module';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { ASSISTANT_INTENTS, INTENT_TEMPLATES, type AssistantIntent } from './assistant-intents';
import { FactAssemblyService } from './fact-assembly.service';
import {
  planQuestion,
  type Plan,
  type PlannerContext,
  type ResolvedSlots,
} from './query-planner';

/**
 * Fact assembly against a real database — docs/06 §8.2 (the payload), §8.3 (provenance), ADR-017.
 *
 * What only Postgres can answer here: that the aggregates count what they claim to (**I-7**: `PENDING`
 * never contributes), that a **split** lands in its own Category (I-1) and a parent Category includes
 * its children (I-11), that a balance comes from `AccountsService` rather than being re-derived (I-4),
 * that every figure carries provenance for the range it was really computed over, and that an intent
 * whose data does not exist refuses with a reason instead of returning zero.
 *
 * The guarantee these numbers carry belongs to 3.2.3: the narrator is handed these strings and may not
 * introduce a numeral that is not among them, so a hallucinated figure has nothing to be made of.
 */
describe('fact assembly (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let facts: FactAssemblyService;

  const householdId = uuidv7();
  const otherHouseholdId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();

  const context: TenantContext = { householdId, userId, role: 'OWNER', requestId: 'facts-it' };
  const otherContext: TenantContext = {
    householdId: otherHouseholdId,
    userId: otherUserId,
    role: 'OWNER',
    requestId: 'facts-it-other',
  };
  const asTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(context, fn);

  const TODAY = '2026-09-20' as LocalDate;
  const PERIOD = { ...monthPeriod(TODAY), matchedOn: 'ovog meseca' };

  let accountId: string;
  let tagId: string;
  let foodId: string;
  let marketId: string;
  let fuelId: string;
  let lidlId: string;
  let planner: PlannerContext;

  /**
   * One ledger row. `categoryId` is left out for a split Transaction, which by I-1 carries **no**
   * category of its own and delegates the whole amount to its splits.
   */
  async function row(input: {
    kind?: 'EXPENSE' | 'INCOME';
    amountMinor: bigint;
    day: string;
    description: string;
    categoryId?: string;
    merchantId?: string;
    status?: 'CONFIRMED' | 'PENDING';
    needsReview?: boolean;
    tagIds?: readonly string[];
  }): Promise<string> {
    const id = uuidv7();
    await asTenant(() =>
      prisma.client.transactions.create({
        data: {
          id,
          household_id: householdId,
          account_id: accountId,
          kind: input.kind ?? 'EXPENSE',
          amount_minor: input.amountMinor,
          currency: 'RSD',
          category_id: input.categoryId ?? null,
          merchant_id: input.merchantId ?? null,
          description: input.description,
          source: 'MANUAL',
          status: input.status ?? 'CONFIRMED',
          needs_review: input.needsReview ?? false,
          occurred_at: new Date(`${input.day}T10:00:00.000Z`),
          occurred_local_date: new Date(`${input.day}T00:00:00.000Z`),
          // `transaction_tags` has no `household_id` and cannot be written directly — the assignment
          // goes through its parent (the tenancy guard refuses the other direction).
          ...(input.tagIds === undefined || input.tagIds.length === 0
            ? {}
            : { transaction_tags: { create: input.tagIds.map((tag) => ({ tag_id: tag })) } }),
        },
      }),
    );
    return id;
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot(),
        PrismaModule,
        AccountsModule,
        BudgetingModule,
        LedgerModule,
        TaxonomyModule,
      ],
      providers: [FactAssemblyService],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    facts = moduleRef.get(FactAssemblyService);

    const stamp = Date.now();
    await prisma.client.users.createMany({
      data: [
        { id: userId, email: `facts-${stamp}@example.com`, display_name: 'Facts Test' },
        { id: otherUserId, email: `facts-b-${stamp}@example.com`, display_name: 'Other' },
      ],
    });
    for (const [ctx, id, owner, name] of [
      [context, householdId, userId, 'Facts Test'],
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

    await asTenant(async () => {
      const account = await prisma.client.accounts.create({
        data: { id: uuidv7(), household_id: householdId, name: 'Tekući', kind: 'BANK', currency: 'RSD' },
      });
      accountId = account.id;

      const food = await prisma.client.categories.create({
        data: { id: uuidv7(), name: 'Hrana', kind: 'EXPENSE' },
      });
      foodId = food.id;
      const market = await prisma.client.categories.create({
        data: { id: uuidv7(), name: 'Supermarket', kind: 'EXPENSE', parent_id: food.id },
      });
      marketId = market.id;
      const fuel = await prisma.client.categories.create({
        data: { id: uuidv7(), name: 'Gorivo', kind: 'EXPENSE' },
      });
      fuelId = fuel.id;

      const lidl = await prisma.client.merchants.create({
        data: { id: uuidv7(), household_id: householdId, name: 'Lidl' },
      });
      lidlId = lidl.id;

      const tag = await prisma.client.tags.create({
        data: { id: uuidv7(), household_id: householdId, name: 'Putovanje' },
      });
      tagId = tag.id;

      // A category Budget whose subtree is `Hrana` + `Supermarket` (I-5/I-11).
      await prisma.client.budgets.create({
        data: {
          id: uuidv7(),
          household_id: householdId,
          category_id: foodId,
          period: 'MONTHLY',
          period_start: new Date('2026-09-01T00:00:00.000Z'),
          amount_minor: 10_000_000n,
          currency: 'RSD',
          include_subcategories: true,
          rollover: false,
        },
      });
    });

    // ---- The September ledger ----------------------------------------------------------------
    // One 22.450 RSD basket split by I-1 into two Categories: 17.450 supermarket, 5.000 fuel.
    const basket = await row({
      amountMinor: 2_245_000n,
      day: '2026-09-05',
      description: 'Lidl',
      merchantId: lidlId,
    });
    await asTenant(() =>
      prisma.client.transaction_splits.createMany({
        data: [
          {
            id: uuidv7(),
            transaction_id: basket,
            household_id: householdId,
            category_id: marketId,
            amount_minor: 1_745_000n,
          },
          {
            id: uuidv7(),
            transaction_id: basket,
            household_id: householdId,
            category_id: fuelId,
            amount_minor: 500_000n,
          },
        ],
      }),
    );

    await row({
      amountMinor: 420_000n,
      day: '2026-09-06',
      description: 'NIS',
      categoryId: fuelId,
      tagIds: [tagId],
    });
    await row({
      amountMinor: 15_000_000n,
      day: '2026-09-01',
      description: 'Plata',
      kind: 'INCOME',
    });
    // A 999.000 PENDING row and a 20.000 uncategorised row flagged for review: the first must not
    // contribute to anything (I-7), the second must contribute to spend and appear in the queue.
    await row({
      amountMinor: 99_900_000n,
      day: '2026-09-07',
      description: 'PENDING row',
      categoryId: marketId,
      status: 'PENDING',
    });
    await row({ amountMinor: 2_000_000n, day: '2026-09-08', description: 'Kirija', needsReview: true });

    // ---- August, for the trend comparison -----------------------------------------------------
    await row({ amountMinor: 1_000_000n, day: '2026-08-10', description: 'Avgust', categoryId: marketId });

    // ---- The other Household's own ledger, which must never appear above ----------------------
    await runWithTenant(otherContext, async () => {
      const account = await prisma.client.accounts.create({
        data: {
          id: uuidv7(),
          household_id: otherHouseholdId,
          name: 'Tuđi',
          kind: 'BANK',
          currency: 'RSD',
        },
      });
      await prisma.client.transactions.create({
        data: {
          id: uuidv7(),
          household_id: otherHouseholdId,
          account_id: account.id,
          kind: 'EXPENSE',
          amount_minor: 500_000n,
          currency: 'RSD',
          description: 'Tuđa kupovina',
          source: 'MANUAL',
          status: 'CONFIRMED',
          occurred_at: new Date('2026-09-05T10:00:00.000Z'),
          occurred_local_date: new Date('2026-09-05T00:00:00.000Z'),
        },
      });
    });

    planner = {
      today: TODAY,
      categories: [
        { id: foodId, name: 'Hrana', path: 'Hrana' },
        { id: marketId, name: 'Supermarket', path: 'Hrana / Supermarket' },
        { id: fuelId, name: 'Gorivo', path: 'Gorivo' },
      ],
      merchants: [{ id: lidlId, name: 'Lidl' }],
      accounts: [{ id: accountId, name: 'Tekući' }],
      tags: [{ id: tagId, name: 'Putovanje' }],
    };
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

  /** A plan for one template, without going through the phrase table — the assembler's own test. */
  function planFor(intent: AssistantIntent, slots: Partial<ResolvedSlots> = {}): Plan {
    return {
      intent,
      template: INTENT_TEMPLATES[intent],
      slots: { period: PERIOD, ...slots },
      matchedOn: [],
    };
  }

  const assemble = (plan: Plan) => asTenant(() => facts.assemble(householdId, plan, { today: TODAY }));

  /** The path the resolver will take: a question in, the facts out. */
  async function ask(question: string) {
    const plan = planQuestion(question, planner);
    return { plan, result: await assemble(plan) };
  }

  const totalMinor = (result: { facts: { totals: readonly { money: { amountMinor: string } }[] } }): string | undefined =>
    result.facts.totals[0]?.money.amountMinor;

  /** The first figure the answer is built on: a total where the template has one, else the top row. */
  const firstFigure = (
    result: {
      facts: {
        totals: readonly { money: { amountMinor: string } }[];
        rows: readonly { value: string }[];
      };
    },
  ): string | undefined => result.facts.totals[0]?.money.amountMinor ?? result.facts.rows[0]?.value;

  // ---------------------------------------------------------------------------------------------
  // Spending
  // ---------------------------------------------------------------------------------------------

  it('totals spending over the period, and PENDING contributes nothing (I-7)', async () => {
    const result = await assemble(planFor('SPEND_TOTAL'));

    // 22.450 (the split basket) + 4.200 (fuel) + 20.000 (uncategorised, but CONFIRMED) = 46.650.
    // The 999.000 PENDING row is excluded, so a bug here is off by ~21×, not by a rounding unit.
    expect(totalMinor(result)).toBe('4665000');
    expect(result.facts.formatted['headline']).toContain('46.650');
    expect(result.facts.formatted['currency']).toBe('RSD');
    expect(result.provenance.transactionCount).toBe(3);
  });

  it('puts a split in its own Category and leaves the parent basket out of the trunk', async () => {
    const supermarket = await assemble(planFor('SPEND_BY_CATEGORY', { categoryId: marketId }));
    expect(totalMinor(supermarket)).toBe('1745000');

    const fuel = await assemble(planFor('SPEND_BY_CATEGORY', { categoryId: fuelId }));
    // 4.200 direct + 5.000 of the basket.
    expect(totalMinor(fuel)).toBe('920000');
    // Two Transaction rows reach this Category: one split, one direct. Still two rows, not three.
    expect(fuel.provenance.transactionCount).toBe(2);
  });

  it('expands a parent Category to its children, the way the budget tile does (I-11)', async () => {
    const parent = await assemble(planFor('SPEND_BY_CATEGORY', { categoryId: foodId }));
    // `Hrana` + `Hrana / Supermarket`, and the fuel share of the same basket stays out.
    expect(totalMinor(parent)).toBe('1745000');
    expect(parent.provenance.filters['categoryIds']).toBe(`${foodId},${marketId}`);
  });

  it('scopes by Merchant, by Account and by Tag', async () => {
    const merchant = await assemble(planFor('SPEND_BY_MERCHANT', { merchantId: lidlId }));
    expect(totalMinor(merchant)).toBe('2245000');

    const account = await assemble(planFor('SPEND_BY_ACCOUNT', { accountId }));
    expect(totalMinor(account)).toBe('4665000');

    const tag = await assemble(planFor('SPEND_BY_TAG', { tagId }));
    expect(totalMinor(tag)).toBe('420000');
    expect(tag.facts.formatted['headline']).toContain('4.200');
  });

  it('names the scope it aggregated, so the answer can say what the figure is *of*', async () => {
    // Before this, a scoped total carried the scope only as an id inside `filters`: the facts said
    // "Spending 4.000,00 RSD" with nothing tying it to Lidl, and the narrator — told never to guess —
    // refused the question while the answer sat in the payload. Measured live before the fix:
    // `koliko sam potrošio u lidlu` answered "the data does not contain the spend for Lidl".
    const merchant = await assemble(planFor('SPEND_BY_MERCHANT', { merchantId: lidlId }));
    expect(merchant.facts.formatted['scope']).toBe('at Lidl');
    expect(merchant.facts.totals[0]?.label).toBe('Spending at Lidl');

    const category = await assemble(planFor('SPEND_BY_CATEGORY', { categoryId: foodId }));
    // The *named* node, not the subtree's first id: "on Hrana", never "on Hrana / Supermarket".
    expect(category.facts.formatted['scope']).toBe('on Hrana');

    const account = await assemble(planFor('SPEND_BY_ACCOUNT', { accountId }));
    expect(account.facts.formatted['scope']).toBe('from Tekući');

    const tag = await assemble(planFor('SPEND_BY_TAG', { tagId }));
    expect(tag.facts.formatted['scope']).toBe('tagged Putovanje');
  });

  it('leaves an unscoped total without a scope, rather than inventing one', async () => {
    const result = await assemble(planFor('SPEND_TOTAL'));

    expect(result.facts.formatted['scope']).toBeUndefined();
    expect(result.facts.totals[0]?.label).toBe('Spending');
  });

  it('names the top Categories with their full path and their machine value', async () => {
    const result = await assemble(planFor('TOP_CATEGORIES'));

    expect(result.facts.rows[0]?.label).toBe('Hrana / Supermarket');
    expect(result.facts.rows[0]?.value).toBe('1745000');
    expect(result.facts.rows[0]?.categoryId).toBe(marketId);
    expect(result.facts.rows.map((row) => row.label)).toEqual(['Hrana / Supermarket', 'Gorivo']);
    // The uncategorised row has no Category to rank, so it is absent rather than an unnamed bucket.
    expect(result.facts.rows).toHaveLength(2);
  });

  it('names the top Merchants, full amounts and unresolved descriptions included', async () => {
    const result = await assemble(planFor('TOP_MERCHANTS'));

    // Lidl carries the **whole** 22.450 basket even though I-1 files that money under two Categories
    // (docs/06 §4.3: a split receipt was still paid to Lidl in full). The 20.000 rent and the 4.200
    // fuel row have no Merchant, so they are ranked under their own description rather than dropped —
    // before 3.3.1 the `merchant_id: { not: null }` filter hid both.
    expect(result.facts.rows.map((row) => [row.label, row.value])).toEqual([
      ['Lidl', '2245000'],
      ['Kirija', '2000000'],
      ['NIS', '420000'],
    ]);
    expect(result.facts.rows[0]?.merchantId).toBe(lidlId);
    expect(result.facts.rows[1]?.merchantId).toBeUndefined();
  });

  it('reports the largest transactions by amount, and the count includes both kinds', async () => {
    const largest = await assemble(planFor('LARGEST_TRANSACTIONS'));
    expect(largest.facts.rows.map((row) => row.value)).toEqual(['2245000', '2000000', '420000']);
    expect(largest.facts.rows[0]?.label).toBe('Lidl');

    const count = await assemble(planFor('TRANSACTION_COUNT'));
    // Four CONFIRMED rows in September: three expenses and the salary.
    expect(count.facts.formatted['headline']).toBe('4');
    expect(count.provenance.transactionCount).toBe(4);
  });

  it('lists transactions, honouring a Category scope', async () => {
    const all = await assemble(planFor('TRANSACTION_LIST'));
    expect(all.facts.rows).toHaveLength(4);

    const scoped = await assemble(planFor('TRANSACTION_LIST', { categoryId: fuelId }));
    // The split basket's *category* is null, so it is not in this list; the direct fuel row is.
    expect(scoped.facts.rows.map((row) => row.label)).toEqual(['NIS']);
  });

  it('averages daily spend over the days in the period, in minor units', async () => {
    const result = await assemble(planFor('AVERAGE_DAILY_SPEND'));
    // 46.650 over 30 days = 1.555, exactly — no float, so the division is asserted rather than tolerated.
    expect(totalMinor(result)).toBe('155500');
    expect(result.facts.formatted['days']).toBe('30');
    expect(result.facts.formatted['total']).toContain('46.650');
  });

  it('reads the review queue with the same predicate as the nav badge', async () => {
    const result = await assemble(planFor('UNCATEGORISED_REVIEW'));
    expect(result.facts.rows.map((row) => row.label)).toEqual(['Kirija']);
    expect(result.facts.formatted['headline']).toBe('1');
  });

  // ---------------------------------------------------------------------------------------------
  // Income, balances, budgets
  // ---------------------------------------------------------------------------------------------

  it('answers income and net cashflow with both sides computed separately', async () => {
    const income = await assemble(planFor('INCOME_TOTAL'));
    expect(totalMinor(income)).toBe('15000000');

    const net = await assemble(planFor('NET_CASHFLOW'));
    const totals = new Map(net.facts.totals.map((total) => [total.label, total.money.amountMinor]));
    expect(totals.get('Income')).toBe('15000000');
    expect(totals.get('Spending')).toBe('4665000');
    expect(totals.get('Net')).toBe('10335000');
  });

  it('reports balances from AccountsService, never by re-deriving them (I-4)', async () => {
    // The balance is the **whole** ledger: 150.000 income − 46.650 September − 10.000 August. That
    // August row is also why the provenance range for a balance is "today", not the plan's period.
    const scoped = await assemble(planFor('ACCOUNT_BALANCE', { accountId }));
    expect(scoped.facts.rows.map((row) => [row.label, row.value])).toEqual([['Tekući', '9335000']]);

    const all = await assemble(planFor('ACCOUNT_BALANCE_ALL'));
    expect(all.facts.rows[0]?.label).toBe('Tekući');
    expect(all.facts.rows[0]?.value).toBe('9335000');
    // The PENDING row is not in it, and neither is the other Household's spending.
    expect(all.provenance.transactionCount).toBe(0);
  });

  it('reports budget consumption from BudgetsService, including the split (I-5)', async () => {
    const result = await assemble(planFor('BUDGET_STATUS'));

    // 100.000 limit − 17.450 spent on the Hrana subtree.
    expect(totalMinor(result)).toBe('8255000');
    expect(result.facts.formatted['limit']).toContain('100.000');
    expect(result.facts.formatted['spent']).toContain('17.450');
    expect(result.facts.rows.map((row) => row.label)).toEqual(['Hrana']);
  });

  it('reports the safe-to-spend figure, zero when no Household budget exists', async () => {
    const result = await assemble(planFor('SAFE_TO_SPEND'));
    // A Category budget is not a Household budget: docs/04 §4's safe-to-spend needs the latter, and
    // a number invented from the former would be a made-up allowance.
    expect(totalMinor(result)).toBe('0');
    expect(result.facts.formatted['spent']).toContain('46.650');
  });

  it('reports the month projection with its reliability, and a budget list as rows', async () => {
    const projection = await assemble(planFor('MONTH_PROJECTION'));
    expect(projection.facts.totals[0]?.money.amountMinor).toMatch(/^\d+$/);
    expect(projection.facts.formatted['reliable']).toMatch(/^(true|false)$/);

    const list = await assemble(planFor('BUDGET_LIST'));
    expect(list.facts.rows.map((row) => row.label)).toEqual(['Hrana']);
    expect(list.facts.formatted['headline']).toBe('1');
  });

  it('reports only the budgets actually ahead of pace', async () => {
    const result = await assemble(planFor('BUDGET_PACE_VS_PLAN'));
    // 17.450 of 100.000 after 20 of 30 days is behind pace, so the honest answer is "none".
    expect(result.facts.rows).toEqual([]);
    expect(result.facts.formatted['headline']).toBe('0');
  });

  // ---------------------------------------------------------------------------------------------
  // Trends
  // ---------------------------------------------------------------------------------------------

  it('compares this period with the previous one, both figures computed', async () => {
    const result = await assemble(planFor('TREND_VS_LAST_MONTH'));
    const totals = new Map(result.facts.totals.map((total) => [total.label, total.money.amountMinor]));
    expect(totals.get('This period')).toBe('4665000');
    expect(totals.get('Previous period')).toBe('1000000');
    expect(totals.get('Change')).toBe('3665000');
    expect(result.facts.formatted['previousPeriod']).toContain('2026-08');
  });

  it('compares this period with the Household\'s own three-month average', async () => {
    const result = await assemble(planFor('TREND_VS_AVERAGE'));
    const totals = new Map(result.facts.totals.map((total) => [total.label, total.money.amountMinor]));
    expect(totals.get('This period')).toBe('4665000');
    // June and July are zero, August is 10.000 ⇒ 10.000/3 = 3.333,33, truncated to minor units.
    expect(totals.get('Usual')).toBe('333333');
    expect(totals.get('Difference')).toBe('4331667');
    expect(result.facts.formatted['periodsCompared']).toBe('3');
  });

  // ---------------------------------------------------------------------------------------------
  // Provenance, refusals, isolation
  // ---------------------------------------------------------------------------------------------

  it('carries provenance for the range it actually aggregated (docs/06 §8.3)', async () => {
    const result = await assemble(planFor('SPEND_BY_CATEGORY', { categoryId: foodId }));
    expect(result.provenance.periodStart).toBe('2026-09-01');
    expect(result.provenance.periodEnd).toBe('2026-09-30');
    expect(result.provenance.sourceQuery).toBe('spend.byCategory.v1');
    expect(result.provenance.ledgerCurrency).toBe('RSD');
    expect(result.provenance.transactionCount).toBe(1);
    expect(result.provenance.computedAt).toBeInstanceOf(Date);
  });

  it('reports the range a state figure is true for, not the period the question named', async () => {
    // A balance is the whole ledger: the plan's period would be a claim about the number that is false.
    const balance = await assemble(planFor('ACCOUNT_BALANCE_ALL'));
    expect(balance.provenance.periodStart).toBe(TODAY);
    expect(balance.provenance.periodEnd).toBe(TODAY);
    expect(balance.provenance.filters['asOf']).toBe('now');

    // A budget reports its own period, which is the current month here but need not be.
    const budget = await assemble(
      planFor('BUDGET_STATUS', { period: { ...monthPeriod('2026-08-01' as LocalDate), matchedOn: 'prošlog meseca' } }),
    );
    expect(budget.provenance.periodStart).toBe('2026-09-01');
    expect(budget.provenance.periodEnd).toBe('2026-09-30');
  });

  it('answers a zero period as zero rather than failing (docs/06 §8.3)', async () => {
    const result = await assemble(
      planFor('SPEND_TOTAL', { period: { ...monthPeriod('2026-06-01' as LocalDate), matchedOn: 'junu' } }),
    );
    expect(result.available).toBe(true);
    expect(result.provenance.transactionCount).toBe(0);
    expect(totalMinor(result)).toBe('0');
    expect(result.facts.formatted['headline']).toContain('0');
  });

  it('refuses a plan whose required slot is unresolved, without querying (ADR-017)', async () => {
    // `SPEND_BY_CATEGORY` with no category would aggregate *everything* and label it "Hrana".
    const uncategorised = await assemble(planFor('SPEND_BY_CATEGORY'));
    expect(uncategorised.available).toBe(false);
    expect(uncategorised.reason).toBe('UNRUNNABLE:categoryId');
    expect(uncategorised.facts.totals).toEqual([]);

    const goal = await assemble(planFor('GOAL_PROGRESS'));
    expect(goal.reason).toBe('UNRUNNABLE:goalId');
  });

  it('refuses an intent whose data does not exist in this build, with a reason and no figures', async () => {
    const goals = await assemble(planFor('GOAL_REQUIRED_MONTHLY'));
    expect(goals.available).toBe(false);
    expect(goals.reason).toBe('UNRUNNABLE:goalId');
    expect(goals.facts.totals).toEqual([]);
    expect(goals.facts.rows).toEqual([]);
    expect(goals.facts.formatted).toEqual({});

    const recurring = await assemble(planFor('RECURRING_LIST'));
    expect(recurring.reason).toBe('NOT_BUILT:recurring');

    const comparison = await assemble(planFor('COMPARE_PERIODS'));
    expect(comparison.reason).toBe('NEEDS_TWO_PERIODS');

    const refusal = await assemble(planFor('NO_TEMPLATE_MATCH'));
    expect(refusal.reason).toBe('NO_TEMPLATE_MATCH');
  });

  it('has a builder for every intent in the registry, and only the known ones refuse', async () => {
    // The `Record` makes this a compile-time property; this asserts the assembled set rather than
    // trusting that a future edit did not reach for a cast.
    const available: readonly (readonly [AssistantIntent, Partial<ResolvedSlots>])[] = [
      ['SPEND_BY_CATEGORY', { categoryId: foodId }],
      ['SPEND_BY_MERCHANT', { merchantId: lidlId }],
      ['SPEND_BY_ACCOUNT', { accountId }],
      ['SPEND_BY_TAG', { tagId }],
      ['ACCOUNT_BALANCE', { accountId }],
      // F-30 needs a target amount, which the planner resolves from the question ("kako da uštedim
      // 20.000"); without one it refuses, which is the point of the test below.
      ['SAVINGS_PROPOSAL', { targetMinor: '500000' }],
    ];
    const slotsFor = new Map<AssistantIntent, Partial<ResolvedSlots>>(available);

    const reasons = new Map<AssistantIntent, string | undefined>();
    for (const intent of ASSISTANT_INTENTS) {
      const result = await assemble(planFor(intent, slotsFor.get(intent) ?? {}));
      if (!result.available) reasons.set(intent, result.reason);
    }

    expect([...reasons.keys()].sort()).toEqual(
      [
        'COMPARE_PERIODS',
        'GOAL_PROGRESS',
        'GOAL_REQUIRED_MONTHLY',
        'NO_TEMPLATE_MATCH',
        'RECURRING_LIST',
        'RECURRING_UPCOMING',
      ].sort(),
    );
    expect(reasons.get('RECURRING_UPCOMING')).toBe('NOT_BUILT:recurring');
    expect(reasons.get('GOAL_REQUIRED_MONTHLY')).toBe('UNRUNNABLE:goalId');
  });

  it('proposes reductions that add up to the target, biggest Category first (F-30)', async () => {
    // September: the basket's 17.450 in Supermarket, 9.200 in Gorivo (4.200 direct + the 5.000 split).
    // 20 % of each is 3.490 and 1.840 = 5.330, so a 5.000 target is met from those two alone.
    const result = await assemble(planFor('SAVINGS_PROPOSAL', { targetMinor: '500000' }));

    expect(result.available).toBe(true);
    expect(result.facts.rows.map((row) => [row.label, row.value])).toEqual([
      ['Hrana / Supermarket', '349000'],
      ['Gorivo', '151000'],
    ]);
    const totals = new Map(result.facts.totals.map((total) => [total.label, total.money.amountMinor]));
    expect(totals.get('Target')).toBe('500000');
    expect(totals.get('Proposed')).toBe('500000');
    expect(totals.get('Shortfall')).toBe('0');
    expect(result.facts.formatted['meetsTarget']).toBe('true');
    expect(result.facts.formatted['capPercent']).toBe('20');
  });

  it('reports the shortfall when the cap cannot cover the target, instead of stretching the rule', async () => {
    // 20 % of everything September spent (17.450 + 9.200 + 20.000 uncategorised, which has no Category
    // to cut) is 5.330 — a 20.000 target is not reachable, and the answer says so.
    const result = await assemble(planFor('SAVINGS_PROPOSAL', { targetMinor: '2000000' }));

    expect(result.available).toBe(true);
    const totals = new Map(result.facts.totals.map((total) => [total.label, total.money.amountMinor]));
    expect(totals.get('Proposed')).toBe('533000');
    expect(totals.get('Shortfall')).toBe('1467000');
    expect(result.facts.formatted['meetsTarget']).toBe('false');
  });

  it('refuses a savings question with no amount rather than proposing against a default target', async () => {
    const result = await assemble(planFor('SAVINGS_PROPOSAL'));

    expect(result.available).toBe(false);
    expect(result.reason).toBe('UNRUNNABLE:targetMinor');
    expect(result.facts.rows).toEqual([]);
  });

  it('hands the narrator minor-unit strings and pre-formatted strings, never a float', async () => {
    const result = await assemble(planFor('TOP_CATEGORIES'));
    for (const row of result.facts.rows) {
      expect(row.value).toMatch(/^-?\d+$/);
      expect(row.formatted).toMatch(/RSD|\d/);
    }
    for (const total of result.facts.totals) {
      expect(total.money.amountMinor).toMatch(/^-?\d+$/);
    }
    expect(typeof result.facts.formatted['headline']).toBe('string');
  });

  // ---------------------------------------------------------------------------------------------
  // The whole path: a question in, the facts out
  // ---------------------------------------------------------------------------------------------

  it.each([
    ['Koliko sam potrošio ovog meseca?', 'SPEND_TOTAL', '4665000'],
    ['Koliko sam potrošio na hranu ovog meseca?', 'SPEND_BY_CATEGORY', '1745000'],
    ['Koliko sam potrošio na gorivo?', 'SPEND_BY_CATEGORY', '920000'],
    ['Koliko sam potrošio u lidlu?', 'SPEND_BY_MERCHANT', '2245000'],
    ['Na šta mi odlazi najviše novca ovog meseca?', 'TOP_CATEGORIES', '1745000'],
    ['Koliko mi je ostalo od budžeta?', 'BUDGET_STATUS', '8255000'],
  ])('answers %s as %s', async (question, intent, expected) => {
    const { plan, result } = await ask(question);
    expect(plan.intent).toBe(intent);
    expect(result.available).toBe(true);
    expect(firstFigure(result)).toBe(expected);
  });

  it('answers the canonical trend and safety questions', async () => {
    const trend = await ask('Kako stojim u odnosu na prošli mesec?');
    expect(trend.plan.intent).toBe('TREND_VS_LAST_MONTH');
    expect(trend.result.facts.formatted['previousPeriod']).toContain('2026-08');

    const safe = await ask('Koliko mogu da potrošim danas?');
    expect(safe.plan.intent).toBe('SAFE_TO_SPEND');
    expect(safe.result.available).toBe(true);

    const review = await ask('Šta je za proveru?');
    expect(review.plan.intent).toBe('UNCATEGORISED_REVIEW');
    expect(review.result.facts.rows.map((row) => row.label)).toEqual(['Kirija']);

    // The scope resolved against the Household's own names: `hranu` is not `Hrana`.
    const category = await ask('Koliko sam potrošio na hranu ovog meseca?');
    expect(category.plan.slots.categoryId).toBe(foodId);
  });

  it('keeps another Household\'s ledger out of every figure (ADR-008)', async () => {
    const plan = planFor('SPEND_TOTAL');
    const result = await runWithTenant(otherContext, () =>
      facts.assemble(otherHouseholdId, plan, { today: TODAY }),
    );
    // That Household has 5.000 of its own spending, so a missing predicate shows up as 500000.
    expect(totalMinor(result)).toBe('500000');
    expect(result.provenance.transactionCount).toBe(1);
  });

  // ---------------------------------------------------------------------------------------------
  // A derived figure may be NEGATIVE, and every one of these used to be an INTERNAL error
  // ---------------------------------------------------------------------------------------------

  /**
   * The class of defect behind `MONTH_PROJECTION`'s 500, asserted rather than fixed once.
   *
   * Every total is derived from movements, so any of them can be negative in ordinary use: a month
   * that spent less than the last one, a **budget past its limit**, an **overdrawn account**, a
   * projection *under* budget. `formatMoney` throws on a negative amount (ADR-003 keeps a Transaction
   * amount non-negative) and `MoneyScalar` refuses one on the wire, so each of these answered an
   * INTERNAL error. The fixture below is a Household with nothing but overspending and a deficit,
   * which is the only way to reach those states at all — the main fixture is comfortably in surplus,
   * which is why the defect survived every earlier test.
   */
  describe('a Household whose derived figures are negative', () => {
    const negHouseholdId = uuidv7();
    const negUserId = uuidv7();
    const negContext: TenantContext = {
      householdId: negHouseholdId,
      userId: negUserId,
      role: 'OWNER',
      requestId: 'facts-it-negative',
    };
    const asNegTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(negContext, fn);
    const assembleNeg = (plan: Plan) =>
      asNegTenant(() => facts.assemble(negHouseholdId, plan, { today: TODAY }));

    beforeAll(async () => {
      const stamp = Date.now();
      await prisma.client.users.create({
        data: { id: negUserId, email: `facts-neg-${stamp}@example.com`, display_name: 'Negative' },
      });
      await asNegTenant(() =>
        prisma.client.households.create({
          data: {
            id: negHouseholdId,
            name: 'Negative',
            owner_user_id: negUserId,
            ledger_currency: 'RSD',
            iana_timezone: 'Europe/Belgrade',
          },
        }),
      );

      await asNegTenant(async () => {
        const account = await prisma.client.accounts.create({
          data: {
            id: uuidv7(),
            household_id: negHouseholdId,
            name: 'Neg Tekući',
            kind: 'BANK',
            currency: 'RSD',
          },
        });
        const category = await prisma.client.categories.create({
          data: { id: uuidv7(), name: 'Troškovi', kind: 'EXPENSE' },
        });

        // A 10.000 Category budget against 50.000 of spending: `remaining` is negative.
        await prisma.client.budgets.create({
          data: {
            id: uuidv7(),
            household_id: negHouseholdId,
            category_id: category.id,
            period: 'MONTHLY',
            period_start: new Date('2026-09-01T00:00:00.000Z'),
            amount_minor: 1_000_000n,
            currency: 'RSD',
            include_subcategories: false,
            rollover: false,
          },
        });
        // A 100.000 **Household** budget, which is what makes `projectedOverrun` non-null at all.
        await prisma.client.budgets.create({
          data: {
            id: uuidv7(),
            household_id: negHouseholdId,
            category_id: null,
            period: 'MONTHLY',
            period_start: new Date('2026-09-01T00:00:00.000Z'),
            amount_minor: 10_000_000n,
            currency: 'RSD',
            include_subcategories: false,
            rollover: false,
          },
        });

        for (const [amountMinor, day, description] of [
          [20_000_000n, '2026-08-10', 'Avgust veliki'], // last month: 200.000
          [5_000_000n, '2026-09-06', 'Septembar mali'], // this month: 50.000, no income at all
        ] as const) {
          await prisma.client.transactions.create({
            data: {
              id: uuidv7(),
              household_id: negHouseholdId,
              account_id: account.id,
              kind: 'EXPENSE',
              amount_minor: amountMinor,
              currency: 'RSD',
              category_id: category.id,
              description,
              source: 'MANUAL',
              status: 'CONFIRMED',
              occurred_at: new Date(`${day}T10:00:00.000Z`),
              occurred_local_date: new Date(`${day}T00:00:00.000Z`),
            },
          });
        }
      });
    });

    afterAll(async () => {
      await asNegTenant(() => prisma.client.households.deleteMany({ where: { id: negHouseholdId } }));
      await prisma.client.users.deleteMany({ where: { id: negUserId } });
    });

    const totalValue = (
      result: { facts: { totals: readonly { label: string; money: { amountMinor: string } }[] } },
      label: string,
    ): string | undefined => result.facts.totals.find((total) => total.label === label)?.money.amountMinor;

    it('renders a negative net cashflow instead of throwing', async () => {
      const result = await assembleNeg(planFor('NET_CASHFLOW'));

      expect(result.available).toBe(true);
      expect(totalValue(result, 'Income')).toBe('0');
      expect(totalValue(result, 'Spending')).toBe('5000000');
      expect(totalValue(result, 'Net')).toBe('-5000000');
      // The rendered sentence carries the sign: a figure the narrator may quote verbatim.
      expect(result.facts.formatted['headline']).toContain('-');
      expect(result.facts.totals[2]?.formatted).toContain('-');
    });

    it('renders a negative period-over-period change in both trend templates', async () => {
      const previous = await assembleNeg(planFor('TREND_VS_LAST_MONTH'));
      expect(totalValue(previous, 'Change')).toBe('-15000000');
      expect(previous.facts.formatted['headline']).toContain('-');

      const average = await assembleNeg(planFor('TREND_VS_AVERAGE'));
      // 50.000 against the 66.666,66 mean of the three months before it (200.000, 0, 0), floored to
      // whole para: 200.000 / 3 = 66.666,66, so the difference is −16.666,66.
      expect(totalValue(average, 'Difference')).toBe('-1666666');
      expect(average.facts.formatted['headline']).toContain('-');
    });

    it('renders an overdrawn account balance as a negative, not as an error (I-4)', async () => {
      const result = await assembleNeg(planFor('ACCOUNT_BALANCE_ALL'));

      expect(result.available).toBe(true);
      expect(result.facts.rows[0]?.value).toBe('-25000000');
      expect(result.facts.rows[0]?.formatted).toContain('-');
      expect(result.facts.formatted['headline']).toContain('-');
    });

    it('renders a budget past its limit as negative remaining', async () => {
      const result = await assembleNeg(planFor('BUDGET_STATUS'));

      expect(result.available).toBe(true);
      expect(totalMinor(result)).toBe('-4000000');
      expect(result.facts.formatted['headline']).toContain('-');
    });

    it('emits NO overrun fact when the projection is under budget', async () => {
      const result = await assembleNeg(planFor('MONTH_PROJECTION'));

      expect(result.available).toBe(true);
      // The projection is 50.000 extrapolated over 20 of 30 days ≈ 75.000, under a 100.000 budget —
      // so there is no overspend to report. Emitting the signed value under the label "Projected
      // overrun" would assert one, and the template frame reads this total by exactly that label:
      // it would have said "over by -25.000,00 RSD".
      expect(result.facts.totals.map((total) => total.label)).toEqual(['Projected total']);
      expect(result.facts.formatted['headline']).not.toContain('-');
    });
  });
});
