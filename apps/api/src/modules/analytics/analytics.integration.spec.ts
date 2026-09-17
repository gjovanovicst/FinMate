import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { monthPeriod, uuidv7, type LocalDate } from '@finmate/domain';

import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { runWithTenant, type TenantContext } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AnalyticsService } from './analytics.service';
import { BudgetsService } from '../budgeting/budgets.service';
import { BudgetingModule } from '../budgeting/budgeting.module';
import { AccountsModule } from '../accounts/accounts.module';
import { GoalsModule } from '../goals/goals.module';
import { RecurringModule } from '../recurring/recurring.module';
import { FactAssemblyService } from '../assistant/fact-assembly.service';
import { INTENT_TEMPLATES, type AssistantIntent } from '../assistant/assistant-intents';
import { planQuestion, type Plan, type PlannerContext, type ResolvedSlots } from '../assistant/query-planner';
import { LedgerModule } from '../ledger/ledger.module';
import { SpendReadModel } from '../ledger/spend-read-model';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';

/**
 * Analytics against a real database — docs/06 §4.3, docs/01 F-20.
 *
 * What only Postgres can answer here:
 *
 *  - **I-1**: a split receipt's money lands in each split's Category *and* in the parent Category's
 *    subtree total, while the **Merchant** figure carries the whole receipt.
 *  - **I-7**: a `PENDING` row is in no figure — total, bucket, Category or merchant.
 *  - **The identity that makes the uncategorised bucket trustworthy**:
 *    `uncategorised + Σ byCategory === total`, splits included. A Household that cannot tell where its
 *    money went is the one case docs/02 §4.15's screen exists to fix, so a silently omitted 30 % would
 *    defeat the whole feature.
 *  - **The agreement test** (this task's headline): the same Category and the same split-containing
 *    month, read through **analytics**, the **assistant's** fact assembly and the **budget tile** — three
 *    paths, one number. Before 3.3.1 the insights counted direct rows only, the assistant counted
 *    splits, and the tile counted splits through a third implementation (docs/06 §5.13).
 *
 * The last one deliberately asserts an *equality between modules* rather than a literal: a literal
 * would keep passing while two of the three drifted apart.
 */
describe('analytics (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let analytics: AnalyticsService;
  let facts: FactAssemblyService;
  let budgets: BudgetsService;
  let spend: SpendReadModel;

  /**
   * The `READ_ANALYTICS` budget, stubbed: this suite is about the figures, and `AuthModule` (which
   * exports the real limiter) is `@Global()` in the application rather than in a test module.
   */
  const limiter = {
    allowed: true,
    consume: vi.fn(async () => ({
      allowed: limiter.allowed,
      remaining: limiter.allowed ? 1 : 0,
      retryAfterSeconds: limiter.allowed ? null : 60,
    })),
  };

  const householdId = uuidv7();
  const otherHouseholdId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();

  const context: TenantContext = { householdId, userId, role: 'OWNER', requestId: 'analytics-it' };
  const otherContext: TenantContext = {
    householdId: otherHouseholdId,
    userId: otherUserId,
    role: 'OWNER',
    requestId: 'analytics-it-other',
  };
  const asTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(context, fn);

  const TODAY = '2026-09-20' as LocalDate;
  const SEPTEMBER = { start: '2026-09-01' as LocalDate, end: '2026-09-30' as LocalDate };
  const AUGUST = { start: '2026-08-01' as LocalDate, end: '2026-08-31' as LocalDate };

  let accountId: string;
  let tagId: string;
  let foodId: string;
  let marketId: string;
  let roastId: string;
  let fuelId: string;
  let clothesId: string;
  let salaryId: string;
  let lidlId: string;
  let planner: PlannerContext;

  /** One ledger row; a split Transaction carries no `categoryId` of its own (I-1). */
  async function row(input: {
    kind?: 'EXPENSE' | 'INCOME';
    amountMinor: bigint;
    day: string;
    description: string;
    categoryId?: string;
    merchantId?: string;
    status?: 'CONFIRMED' | 'PENDING';
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
          occurred_at: new Date(`${input.day}T10:00:00.000Z`),
          occurred_local_date: new Date(`${input.day}T00:00:00.000Z`),
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
        GoalsModule,
        LedgerModule,
        RecurringModule,
        TaxonomyModule,
        BudgetingModule,
      ],
      // `FactAssemblyService` directly rather than `AssistantModule`: the assistant's own resolver and
      // service need `RateLimitService`, which lives in the application-global `AuthModule` and is
      // irrelevant to the comparison being made here.
      providers: [
        AnalyticsService,
        FactAssemblyService,
        { provide: RateLimitService, useValue: limiter },
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    analytics = moduleRef.get(AnalyticsService);
    facts = moduleRef.get(FactAssemblyService);
    budgets = moduleRef.get(BudgetsService);
    spend = moduleRef.get(SpendReadModel);

    const stamp = Date.now();
    await prisma.client.users.createMany({
      data: [
        { id: userId, email: `analytics-${stamp}@example.com`, display_name: 'Analytics Test' },
        { id: otherUserId, email: `analytics-b-${stamp}@example.com`, display_name: 'Other' },
      ],
    });
    for (const [ctx, id, owner, name] of [
      [context, householdId, userId, 'Analytics Test'],
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

      const category = (name: string, kind: 'EXPENSE' | 'INCOME', parentId?: string) =>
        prisma.client.categories.create({
          data: { id: uuidv7(), name, kind, ...(parentId === undefined ? {} : { parent_id: parentId }) },
        });

      foodId = (await category('Hrana', 'EXPENSE')).id;
      marketId = (await category('Supermarket', 'EXPENSE', foodId)).id;
      roastId = (await category('Pečenjara', 'EXPENSE', foodId)).id;
      fuelId = (await category('Gorivo', 'EXPENSE')).id;
      clothesId = (await category('Odeća', 'EXPENSE')).id;
      salaryId = (await category('Plata', 'INCOME')).id;

      lidlId = (
        await prisma.client.merchants.create({
          data: { id: uuidv7(), household_id: householdId, name: 'Lidl' },
        })
      ).id;

      tagId = (
        await prisma.client.tags.create({
          data: { id: uuidv7(), household_id: householdId, name: 'Putovanje' },
        })
      ).id;

      // The budget tile's fixture: Hrana's subtree, September, which is what the agreement test
      // compares the two read paths against.
      await prisma.client.budgets.create({
        data: {
          id: uuidv7(),
          household_id: householdId,
          category_id: foodId,
          period: 'MONTHLY',
          period_start: new Date('2026-09-01T00:00:00.000Z'),
          amount_minor: 20_000_00n,
          currency: 'RSD',
          include_subcategories: true,
          rollover: false,
        },
      });
    });

    // ---- September ---------------------------------------------------------------------------
    // One 10.000 basket split by I-1 into 6.000 groceries and 4.000 roast.
    const basket = await row({
      amountMinor: 10_000_00n,
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
            amount_minor: 6_000_00n,
          },
          {
            id: uuidv7(),
            transaction_id: basket,
            household_id: householdId,
            category_id: roastId,
            amount_minor: 4_000_00n,
          },
        ],
      }),
    );

    await row({
      amountMinor: 2_000_00n,
      day: '2026-09-06',
      description: 'NIS',
      categoryId: fuelId,
      tagIds: [tagId],
    });
    await row({ amountMinor: 1_000_00n, day: '2026-09-08', description: 'Kirija' });
    await row({
      amountMinor: 50_000_00n,
      day: '2026-09-01',
      description: 'Plata',
      kind: 'INCOME',
      categoryId: salaryId,
    });
    // I-7: a PENDING row contributes to nothing at all.
    await row({
      amountMinor: 99_000_00n,
      day: '2026-09-07',
      description: 'PENDING row',
      categoryId: marketId,
      status: 'PENDING',
    });

    // ---- August, the comparison baseline ------------------------------------------------------
    await row({ amountMinor: 5_000_00n, day: '2026-08-10', description: 'Avgust market', categoryId: marketId });
    await row({ amountMinor: 3_000_00n, day: '2026-08-11', description: 'Avgust gorivo', categoryId: fuelId });
    await row({ amountMinor: 2_000_00n, day: '2026-08-12', description: 'Avgust odeća', categoryId: clothesId });
    await row({ amountMinor: 500_00n, day: '2026-08-13', description: 'Avgust neraspoređeno' });

    // ---- The other Household's ledger, which must never appear above ---------------------------
    await runWithTenant(otherContext, async () => {
      const account = await prisma.client.accounts.create({
        data: { id: uuidv7(), household_id: otherHouseholdId, name: 'Tuđi', kind: 'BANK', currency: 'RSD' },
      });
      await prisma.client.transactions.create({
        data: {
          id: uuidv7(),
          household_id: otherHouseholdId,
          account_id: account.id,
          kind: 'EXPENSE',
          amount_minor: 777_000_00n,
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
        { id: roastId, name: 'Pečenjara', path: 'Hrana / Pečenjara' },
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

  const byCategory = (input: Parameters<AnalyticsService['spendByCategory']>[1]) =>
    asTenant(() => analytics.spendByCategory(householdId, input));

  const rowFor = (
    rows: readonly { categoryId: string | null; total: { amountMinor: string } }[],
    categoryId: string | null,
  ) => rows.find((row) => row.categoryId === categoryId);

  // ---------------------------------------------------------------------------------------------
  // spendByCategory
  // ---------------------------------------------------------------------------------------------

  it('sums a Category subtree, keeps the leaves, and reports the uncategorised bucket', async () => {
    const rows = await byCategory({ range: SEPTEMBER });

    // 10.000 split basket + 2.000 fuel + 1.000 uncategorised. The 99.000 PENDING row is nowhere (I-7).
    expect(rowFor(rows, foodId)?.total.amountMinor).toBe(1000000n);
    expect(rowFor(rows, marketId)?.total.amountMinor).toBe(600000n);
    expect(rowFor(rows, roastId)?.total.amountMinor).toBe(400000n);
    expect(rowFor(rows, fuelId)?.total.amountMinor).toBe(200000n);
    expect(rowFor(rows, null)?.total.amountMinor).toBe(100000n);
    expect(rowFor(rows, salaryId)).toBeUndefined();

    // A split Transaction is one Transaction, counted once in each Category it touches (I-1) — and the
    // parent's figure is a **sum of contributions**, so the one receipt appears in both of Hrana's
    // children and therefore twice under Hrana. That is the difference the schema's `transactionCount`
    // description records: a subtree aggregate is not a distinct count of Transactions, because
    // counting one receipt once for a whole subtree would need a query per node.
    expect(rowFor(rows, marketId)?.transactionCount).toBe(1);
    expect(rowFor(rows, foodId)?.transactionCount).toBe(2);
    expect(rowFor(rows, null)?.transactionCount).toBe(1);
    expect(rowFor(rows, null)?.category).toBeNull();
  });

  it('flags the subtree aggregate and makes the leaf shares add up to the range', async () => {
    const rows = await byCategory({ range: SEPTEMBER });

    expect(rowFor(rows, foodId)?.isSubtreeAggregate).toBe(true);
    expect(rowFor(rows, marketId)?.isSubtreeAggregate).toBe(false);
    expect(rowFor(rows, null)?.isSubtreeAggregate).toBe(false);

    // Shares are of the whole range, so the rows a flat chart draws (the roots, plus the
    // uncategorised bucket) account for every minor unit — nothing is described twice, nothing is
    // missing.
    const roots = rows.filter(
      (row) => row.categoryId === null || row.category?.parentId === null,
    );
    const rootTotal = roots.reduce((sum, row) => sum + row.total.amountMinor, 0n);
    expect(rootTotal).toBe(13_000_00n);

    const leafShares = rows
      .filter((row) => row.isSubtreeAggregate === false && row.total.amountMinor !== 0n)
      .reduce((sum, row) => sum + row.shareOfTotal, 0);
    expect(leafShares).toBeCloseTo(1, 10);
  });

  it('returns only the Categories that carry their own spend when subcategories are excluded', async () => {
    const rows = await byCategory({ range: SEPTEMBER, includeSubcategories: false });

    expect(rowFor(rows, foodId)).toBeUndefined();
    expect(rowFor(rows, marketId)?.total.amountMinor).toBe(600000n);
    expect(rowFor(rows, roastId)?.total.amountMinor).toBe(400000n);
    expect(rowFor(rows, fuelId)?.total.amountMinor).toBe(200000n);
  });

  it('holds uncategorised + every Category total equal to the range total (the splits identity)', async () => {
    const rows = await byCategory({ range: SEPTEMBER, includeSubcategories: false });
    const sum = rows.reduce((total, row) => total + row.total.amountMinor, 0n);

    // The read model's own total over the same range, with no Category scope: the two must be the same
    // money, or the uncategorised bucket is hiding (or inventing) part of the ledger.
    const whole = await asTenant(() =>
      spend.total(householdId, { from: SEPTEMBER.start, to: SEPTEMBER.end }, { kind: 'EXPENSE' }),
    );

    expect(sum.toString()).toBe(whole.minor.toString());
    expect(sum).toBe(13_000_00n);
  });

  it('never counts another Household’s spending', async () => {
    const ours = await byCategory({ range: SEPTEMBER });
    const theirs = await runWithTenant(otherContext, () =>
      analytics.spendByCategory(otherHouseholdId, { range: SEPTEMBER }),
    );

    expect(rowFor(ours, null)?.total.amountMinor).toBe(100000n);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]?.categoryId).toBeNull();
    expect(theirs[0]?.total.amountMinor).toBe(777000_00n);
  });

  it('applies the READ_ANALYTICS budget per Household (docs/06 §11.2)', async () => {
    limiter.allowed = false;
    try {
      await expect(byCategory({ range: SEPTEMBER })).rejects.toThrow(/Too many analytics queries/);
    } finally {
      limiter.allowed = true;
    }
    expect(limiter.consume).toHaveBeenCalledWith('analytics:read', householdId, 120, 60);
  });

  it('refuses an inverted range instead of drawing an empty chart', async () => {
    await expect(
      byCategory({ range: { start: '2026-09-30', end: '2026-09-01' } }),
    ).rejects.toThrow(/ends before it starts/);
  });

  // ---------------------------------------------------------------------------------------------
  // spendOverTime and cashflow
  // ---------------------------------------------------------------------------------------------

  it('buckets the spend series, splitting included, and keeps empty buckets', async () => {
    const buckets = await asTenant(() =>
      analytics.spendOverTime(householdId, { range: SEPTEMBER, bucket: 'MONTH' }),
    );

    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.expenseTotal.amountMinor).toBe(1300000n);
    expect(buckets[0]?.incomeTotal.amountMinor).toBe(5000000n);
    // Three expenses and the salary. The PENDING row is not one of them (I-7).
    expect(buckets[0]?.transactionCount).toBe(4);
  });

  it('scopes the series to a Category subtree, on the day the receipt was paid', async () => {
    const whole = await asTenant(() =>
      analytics.spendOverTime(householdId, {
        range: SEPTEMBER,
        bucket: 'WEEK',
        categoryIds: [foodId],
      }),
    );

    // The basket is 2026-09-05, the first day of the ISO week beginning 2026-08-31 — clipped to the
    // range's own start, which is what `bucketRanges` guarantees.
    expect(whole.map((bucket) => bucket.bucketStart)).toEqual([
      '2026-09-01',
      '2026-09-07',
      '2026-09-14',
      '2026-09-21',
      '2026-09-28',
    ]);
    expect(whole[0]?.expenseTotal.amountMinor).toBe(1000000n);
    expect(whole[0]?.transactionCount).toBe(1);
    // Every other week is present and empty rather than missing.
    expect(whole.slice(1).map((bucket) => bucket.expenseTotal.amountMinor)).toEqual([0n, 0n, 0n, 0n]);
  });

  it('counts a split Transaction once in the Category it was split into', async () => {
    const buckets = await asTenant(() =>
      analytics.spendOverTime(householdId, {
        range: SEPTEMBER,
        bucket: 'MONTH',
        categoryIds: [marketId],
      }),
    );

    expect(buckets[0]?.expenseTotal.amountMinor).toBe(600000n);
    expect(buckets[0]?.transactionCount).toBe(1);
  });

  it('reports a signed net per bucket, negative in a deficit month', async () => {
    const buckets = await asTenant(() =>
      analytics.cashflow(householdId, { range: AUGUST, bucket: 'MONTH' }),
    );

    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.income.amountMinor).toBe(0n);
    expect(buckets[0]?.expense.amountMinor).toBe(1050000n);
    // A `Money` could not carry this: the whole point of the `Balance` scalar (docs/06 §4.3).
    expect(buckets[0]?.net.amountMinor).toBe(-1050000n);

    const september = await asTenant(() =>
      analytics.cashflow(householdId, { range: SEPTEMBER, bucket: 'MONTH' }),
    );
    expect(september[0]?.net.amountMinor).toBe(3700000n);
  });

  // ---------------------------------------------------------------------------------------------
  // topMerchants
  // ---------------------------------------------------------------------------------------------

  it('ranks Merchants by the whole Transaction, and names the unresolved ones by description', async () => {
    const rows = await asTenant(() =>
      analytics.topMerchants(householdId, { range: SEPTEMBER, limit: 10 }),
    );

    expect(rows.map((row) => [row.displayName, row.total.amountMinor])).toEqual([
      // The full 10.000 basket, although I-1 filed it under two Categories.
      ['Lidl', 10_000_00n],
      ['NIS', 2000_00n],
      ['Kirija', 1000_00n],
    ]);
    expect(rows[0]?.merchantId).toBe(lidlId);
    expect(rows[1]?.merchantId).toBeNull();
    expect(rows[0]?.transactionCount).toBe(1);
  });

  it('honours the merchant limit', async () => {
    const rows = await asTenant(() =>
      analytics.topMerchants(householdId, { range: SEPTEMBER, limit: 1 }),
    );
    expect(rows.map((row) => row.displayName)).toEqual(['Lidl']);
  });

  // ---------------------------------------------------------------------------------------------
  // monthComparison
  // ---------------------------------------------------------------------------------------------

  it('compares two months and gives a ratio only where there is a basis for one', async () => {
    const comparison = await asTenant(() =>
      analytics.monthComparison(householdId, { period: '2026-09' }),
    );

    expect(comparison.period).toBe('2026-09');
    expect(comparison.compareTo).toBe('2026-08');
    expect(comparison.total.amountMinor).toBe(1300000n);
    expect(comparison.compareTotal.amountMinor).toBe(1050000n);
    expect(comparison.delta.amountMinor).toBe(250000n);
    expect(comparison.deltaRatio).toBeCloseTo(2500 / 10500, 10);

    const byId = new Map(comparison.categories.map((row) => [row.categoryId, row]));
    expect(byId.get(foodId)?.priorPeriodTotal?.amountMinor).toBe(500000n);
    expect(byId.get(foodId)?.changeRatio).toBeCloseTo(1, 10);
    expect(byId.get(marketId)?.changeRatio).toBeCloseTo(0.2, 10);
    // Nothing was spent on roast in August, so there is no basis for a ratio — null, never Infinity.
    // This is docs/02 §4.15's "nema osnova za poređenje".
    expect(byId.get(roastId)?.priorPeriodTotal?.amountMinor).toBe(0n);
    expect(byId.get(roastId)?.changeRatio).toBeNull();
    // A Category that disappeared is present with a total of zero and a ratio of −1, rather than
    // being dropped: stopping is the most interesting thing a Category can do.
    expect(byId.get(clothesId)?.total.amountMinor).toBe(0n);
    expect(byId.get(clothesId)?.changeRatio).toBe(-1);
    expect(byId.get(null)?.total.amountMinor).toBe(100000n);
    expect(byId.get(null)?.priorPeriodTotal?.amountMinor).toBe(50000n);
  });

  it('takes an explicit baseline month and refuses a malformed month key', async () => {
    const comparison = await asTenant(() =>
      analytics.monthComparison(householdId, { period: '2026-09', compareTo: '2026-08' }),
    );
    expect(comparison.compareTo).toBe('2026-08');

    await expect(
      asTenant(() => analytics.monthComparison(householdId, { period: 'September' })),
    ).rejects.toThrow(/month formatted YYYY-MM/);
  });

  // ---------------------------------------------------------------------------------------------
  // The agreement test
  // ---------------------------------------------------------------------------------------------

  it('agrees with the budget tile and the assistant on a split-containing month', async () => {
    const [rows, tile] = await Promise.all([
      byCategory({ range: SEPTEMBER }),
      asTenant(() => budgets.list(householdId, TODAY)),
    ]);

    // The question goes through the **real planner**, so the Category it names and the period it reads
    // are the same ones the assistant would answer with.
    const plan = planQuestion('koliko sam potrošio na hranu ovog meseca', planner);

    const analyticsTotal = rowFor(rows, foodId)?.total.amountMinor;
    const tileTotal = tile.find((budget) => budget.categoryId === foodId)?.spent.amountMinor.toString();

    // The assistant's own path: the planner's plan, through fact assembly.
    const assembled = await asTenant(() => facts.assemble(householdId, plan, { today: TODAY }));
    const assistantTotal = assembled.facts.totals[0]?.money.amountMinor;

    // The planner resolves the named Category; the figure it is asked about is the subtree, splits
    // included, in the period the question named.
    expect(plan.intent).toBe('SPEND_BY_CATEGORY');
    expect(analyticsTotal).toBe(10_000_00n);
    expect(tileTotal).toBe(analyticsTotal?.toString());
    expect(assistantTotal).toBe(analyticsTotal?.toString());

    // And the leaves sum to it, so the detail behind the agreement is right too.
    const leaves = await byCategory({ range: SEPTEMBER, includeSubcategories: false });
    const leafSum =
      (rowFor(leaves, marketId)?.total.amountMinor ?? 0n) +
      (rowFor(leaves, roastId)?.total.amountMinor ?? 0n);
    expect(leafSum.toString()).toBe(analyticsTotal?.toString());
  });

  /** A plan for one template, without the phrase table — the assistant's own test does the same. */
  function planFor(intent: AssistantIntent, slots: Partial<ResolvedSlots> = {}): Plan {
    return {
      intent,
      template: INTENT_TEMPLATES[intent],
      slots: { period: { ...monthPeriod(TODAY), matchedOn: 'ovog meseca' }, ...slots },
      matchedOn: [],
    };
  }

  it('agrees with the assistant on the top Categories of the same month', async () => {
    const [rows, assembled] = await Promise.all([
      byCategory({ range: SEPTEMBER, includeSubcategories: false }),
      asTenant(() =>
        facts.assemble(householdId, planFor('TOP_CATEGORIES'), { today: TODAY }),
      ),
    ]);

    const assistantRows = new Map(
      assembled.facts.rows.map((fact) => [fact.categoryId, fact.value]),
    );
    for (const [categoryId, expected] of assistantRows) {
      expect(rowFor(rows, categoryId ?? null)?.total.amountMinor.toString()).toBe(expected);
    }
    // Supermarket first (6.000), then roast (4.000), then fuel (2.000) — the uncategorised bucket has
    // no Category to rank and the assistant leaves it out, which the analytics row for it confirms is
    // the remainder rather than a missing figure.
    expect([...assistantRows.keys()]).toEqual([marketId, roastId, fuelId]);
  });
});
