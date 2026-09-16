import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7, type LocalDate } from '@finmate/domain';

import { runWithTenant, type TenantContext } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { BudgetingModule } from '../budgeting/budgeting.module';
import { InsightsModule } from './insights.module';
import { InsightsService } from './insights.service';

/**
 * Insights against a real database — docs/01 F-20/F-22, docs/06 §5.13.
 *
 * ## What only Postgres can answer
 *
 * The generators are pure and unit-tested; what is *not* proven there is the wiring: that the facts
 * the service loads are the right rows (CONFIRMED only, I-7), that a re-run does not duplicate a
 * condition, that a dismissal sticks and is not a delete, and that one Household cannot see or dismiss
 * another's insights (ADR-008). Those are all row-level questions.
 */
describe('insights (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let insights: InsightsService;

  const householdId = uuidv7();
  const otherHouseholdId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();

  const context: TenantContext = { householdId, userId, role: 'OWNER', requestId: 'insights-it' };
  const otherContext: TenantContext = {
    householdId: otherHouseholdId,
    userId: otherUserId,
    role: 'OWNER',
    requestId: 'insights-it-other',
  };
  const asTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(context, fn);

  let accountId: string;
  let foodId: string;
  let fuelId: string;

  const TODAY = '2026-09-20' as LocalDate;

  /** Insert a confirmed expense directly: the ledger's own API is not what is under test. */
  async function spend(
    categoryId: string | null,
    amountMinor: bigint,
    occurredOn: string,
    kind: 'EXPENSE' | 'INCOME' = 'EXPENSE',
    status: 'CONFIRMED' | 'PENDING' = 'CONFIRMED',
  ): Promise<string> {
    const id = uuidv7();
    await asTenant(() =>
      prisma.client.transactions.create({
        data: {
          id,
          household_id: householdId,
          account_id: accountId,
          kind,
          amount_minor: amountMinor,
          currency: 'RSD',
          category_id: categoryId,
          description: 'test row',
          source: 'MANUAL',
          status,
          occurred_at: new Date(`${occurredOn}T10:00:00.000Z`),
          occurred_local_date: new Date(`${occurredOn}T00:00:00.000Z`),
        },
      }),
    );
    return id;
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule, BudgetingModule, InsightsModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    insights = moduleRef.get(InsightsService);

    const stamp = Date.now();
    await prisma.client.users.createMany({
      data: [
        { id: userId, email: `ins-${stamp}@example.com`, display_name: 'Insights Test' },
        { id: otherUserId, email: `ins-b-${stamp}@example.com`, display_name: 'Other' },
      ],
    });

    for (const [ctx, id, owner] of [
      [context, householdId, userId],
      [otherContext, otherHouseholdId, otherUserId],
    ] as const) {
      await runWithTenant(ctx, async () => {
        await prisma.client.households.create({
          data: {
            id,
            name: 'Insights Test',
            owner_user_id: owner,
            ledger_currency: 'RSD',
            iana_timezone: 'Europe/Belgrade',
          },
        });
      });
    }

    await asTenant(async () => {
      const account = await prisma.client.accounts.create({
        data: {
          id: uuidv7(),
          household_id: householdId,
          name: 'Tekući',
          // The CHECK constraint allows CASH | BANK | CARD | OTHER (docs/03 §4).
          kind: 'BANK',
          currency: 'RSD',
        },
      });
      accountId = account.id;

      const food = await prisma.client.categories.create({
        data: { id: uuidv7(), name: 'Hrana', kind: 'EXPENSE' },
      });
      const supermarket = await prisma.client.categories.create({
        data: { id: uuidv7(), name: 'Supermarket', kind: 'EXPENSE', parent_id: food.id },
      });
      foodId = supermarket.id;
      const fuel = await prisma.client.categories.create({
        data: { id: uuidv7(), name: 'Gorivo', kind: 'EXPENSE' },
      });
      fuelId = fuel.id;

      await prisma.client.budgets.create({
        data: {
          id: uuidv7(),
          household_id: householdId,
          category_id: foodId,
          period: 'MONTHLY',
          period_start: new Date('2026-09-01T00:00:00.000Z'),
          amount_minor: 10_000n,
          currency: 'RSD',
          include_subcategories: true,
          rollover: false,
        },
      });
    });

    // Three complete baseline months of 10 000 for the supermarket, so a spike and a positive trend
    // are both computable; and a heavy September that projects a budget overrun.
    for (const month of ['2026-06', '2026-07', '2026-08']) {
      await spend(foodId, 10_000n, `${month}-10`);
    }
    // Current period: 30 000 in one purchase (a spike, and a budget overrun on a 10 000 limit).
    await spend(foodId, 30_000n, '2026-09-10');
    // A pending row that must not count (I-7).
    await spend(foodId, 500_000n, '2026-09-11', 'EXPENSE', 'PENDING');
    // A fuel row on no budget, so it produces no budget insight.
    await spend(fuelId, 5_000n, '2026-09-12');
  });

  afterAll(async () => {
    for (const [ctx, id] of [
      [context, householdId],
      [otherContext, otherHouseholdId],
    ] as const) {
      await runWithTenant(ctx, async () => {
        await prisma.client.insights.deleteMany({ where: { household_id: id } });
        await prisma.client.recurring_rules.deleteMany({ where: { household_id: id } });
        await prisma.client.budgets.deleteMany({ where: { household_id: id } });
        await prisma.client.households.deleteMany({ where: { id } });
      });
    }
    await prisma.client.users.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await moduleRef?.close();
  });

  it('generates the four kinds from real rows, and never counts a PENDING row (I-7)', async () => {
    const result = await asTenant(() => insights.generate(householdId, TODAY));
    expect(result.drafts).toBeGreaterThan(0);
    expect(result.created).toBe(result.drafts);

    const rows = await asTenant(() =>
      prisma.client.insights.findMany({ where: { household_id: householdId } }),
    );
    const kinds = rows.map((row) => row.kind).sort();
    expect(kinds).toContain('BUDGET_PACE');
    expect(kinds).toContain('CATEGORY_SPIKE');

    const pace = rows.find((row) => row.kind === 'BUDGET_PACE');
    const payload = pace?.payload as Record<string, string>;
    // 30 000 spent on day 20 of 30, limit 10 000: projected 45 000, overrun 35 000 — CRITICAL, and the
    // PENDING 500 000 is nowhere in the number.
    expect(payload['spentMinor']).toBe('30000');
    expect(pace?.severity).toBe('CRITICAL');

    const spike = rows.find((row) => row.kind === 'CATEGORY_SPIKE');
    expect((spike?.payload as Record<string, string>)['currentMinor']).toBe('30000');
    expect((spike?.payload as Record<string, string>)['baselineMeanMinor']).toBe('10000');
  });

  it('stores the dedupe key with the facts and does not duplicate a condition on a re-run', async () => {
    const again = await asTenant(() => insights.generate(householdId, TODAY));
    expect(again.created).toBe(0);
    expect(again.alreadyRecorded).toBe(again.drafts);
    expect(again.drafts).toBeGreaterThan(0);

    const rows = await asTenant(() =>
      prisma.client.insights.findMany({ where: { household_id: householdId } }),
    );
    const keys = rows.map((row) => (row.payload as { dedupeKey?: string }).dedupeKey);
    expect(keys.every((key) => typeof key === 'string')).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('pages the feed newest-first with an exact cursor', async () => {
    const firstPage = await asTenant(() => insights.list(householdId, {}, 1));
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.hasNextPage).toBe(true);
    expect(firstPage.totalCount).toBeGreaterThan(1);

    const secondPage = await asTenant(() =>
      insights.list(householdId, {}, 1, firstPage.endCursor ?? undefined),
    );
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
  });

  it('filters by kind and by severity', async () => {
    const byKind = await asTenant(() => insights.list(householdId, { kind: ['BUDGET_PACE'] }, 50));
    expect(byKind.items.length).toBeGreaterThan(0);
    expect(byKind.items.every((item) => item.kind === 'BUDGET_PACE')).toBe(true);

    const bySeverity = await asTenant(() => insights.list(householdId, { severity: ['CRITICAL'] }, 50));
    expect(bySeverity.items.every((item) => item.severity === 'CRITICAL')).toBe(true);
  });

  it('dismisses rather than deletes, and hides the row from the default feed', async () => {
    const [row] = await asTenant(() => insights.latest(householdId, 1));
    expect(row).toBeDefined();

    const dismissed = await asTenant(() => insights.dismiss(householdId, row!.id));
    expect(dismissed?.isDismissed).toBe(true);

    const visible = await asTenant(() => insights.list(householdId, {}, 50));
    expect(visible.items.some((item) => item.id === row!.id)).toBe(false);

    const withDismissed = await asTenant(() =>
      insights.list(householdId, { includeDismissed: true }, 50),
    );
    expect(withDismissed.items.some((item) => item.id === row!.id)).toBe(true);

    const stillThere = await asTenant(() =>
      prisma.client.insights.findFirst({ where: { id: row!.id } }),
    );
    expect(stillThere).not.toBeNull();
  });

  it('cannot dismiss or generate into another Household', async () => {
    const [row] = await asTenant(() => insights.latest(householdId, 1));
    const foreign = await runWithTenant(otherContext, () => insights.dismiss(otherHouseholdId, row!.id));
    expect(foreign).toBeNull();

    const otherRows = await runWithTenant(otherContext, () =>
      prisma.client.insights.findMany({ where: { household_id: otherHouseholdId } }),
    );
    expect(otherRows).toEqual([]);

    // The other Household has no budgets and no transactions, so its run produces nothing — and
    // nothing of the first Household's.
    const other = await runWithTenant(otherContext, () => insights.generate(otherHouseholdId, TODAY));
    expect(other.created).toBe(0);
  });

  it('generates nothing for a Household with no spend', async () => {
    const result = await asTenant(() => insights.generate(householdId, '2026-11-15'));
    expect(result.drafts).toBe(0);
    expect(result.created).toBe(0);
  });

  it('projects a budget with the recurring charges still due in the period (task 3.4.2)', async () => {
    // A subscription filed under the budget's Category, due **after** the Housefold's today, so it is
    // committed money rather than spend.
    const ruleId = uuidv7();
    await asTenant(() =>
      prisma.client.recurring_rules.create({
        data: {
          id: ruleId,
          household_id: householdId,
          account_id: accountId,
          kind: 'EXPENSE',
          amount_minor: 4_000n,
          currency: 'RSD',
          category_id: foodId,
          description: 'Pretplata',
          rrule: 'RRULE:FREQ=MONTHLY;BYMONTHDAY=25',
          next_occurrence_on: new Date('2026-09-25T00:00:00.000Z'),
          auto_confirm: true,
          is_detected: false,
          is_active: true,
        },
      }),
    );

    const readPace = async (): Promise<Record<string, string>> => {
      const row = await asTenant(() =>
        prisma.client.insights.findFirst({
          where: { household_id: householdId, kind: 'BUDGET_PACE' },
          orderBy: { id: 'desc' },
        }),
      );
      return (row?.payload ?? {}) as Record<string, string>;
    };

    // A fresh period so the insight is written rather than recognised as already recorded.
    await asTenant(() => prisma.client.insights.deleteMany({ where: { household_id: householdId } }));
    await asTenant(() => insights.generate(householdId, TODAY));
    expect((await readPace())['committedMinor']).toBe('4000');

    // Once the occurrence is posted it is `spent`, not `committed`: counting it twice would double the
    // bill in the projection.
    await asTenant(() =>
      prisma.client.transactions.create({
        data: {
          id: uuidv7(),
          household_id: householdId,
          account_id: accountId,
          kind: 'EXPENSE',
          amount_minor: 4_000n,
          currency: 'RSD',
          category_id: foodId,
          description: 'Pretplata',
          source: 'RECURRING',
          status: 'CONFIRMED',
          recurring_rule_id: ruleId,
          occurred_at: new Date('2026-09-25T10:00:00.000Z'),
          occurred_local_date: new Date('2026-09-25T00:00:00.000Z'),
        },
      }),
    );

    await asTenant(() => prisma.client.insights.deleteMany({ where: { household_id: householdId } }));
    await asTenant(() => insights.generate(householdId, TODAY));
    expect((await readPace())['committedMinor']).toBe('0');

    await asTenant(() =>
      prisma.client.recurring_rules.deleteMany({ where: { household_id: householdId, id: ruleId } }),
    );
  });

  it('announces a recurring charge that is still to be posted (task 3.4.3)', async () => {
    const ruleId = uuidv7();
    await asTenant(() =>
      prisma.client.recurring_rules.create({
        data: {
          id: ruleId,
          household_id: householdId,
          account_id: accountId,
          kind: 'EXPENSE',
          amount_minor: 1_299_00n,
          currency: 'RSD',
          category_id: null,
          description: 'Netflix',
          rrule: 'RRULE:FREQ=MONTHLY;BYMONTHDAY=21',
          next_occurrence_on: new Date('2026-09-21T00:00:00.000Z'),
          auto_confirm: true,
          is_detected: false,
          is_active: true,
        },
      }),
    );

    const read = () =>
      asTenant(() =>
        prisma.client.insights.findMany({ where: { household_id: householdId, kind: 'RECURRING_DUE' } }),
      );

    await asTenant(() => prisma.client.insights.deleteMany({ where: { household_id: householdId } }));
    await asTenant(() => insights.generate(householdId, TODAY));

    const rows = await read();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // A charge that is expected is information, not a warning.
    expect(row.severity).toBe('INFO');
    const payload = row.payload as Record<string, unknown>;
    expect(payload['description']).toBe('Netflix');
    expect(payload['amountMinor']).toBe('129900');
    expect(payload['occurredOn']).toBe('2026-09-21');
    expect(payload['daysUntil']).toBe(1);
    expect(payload['dedupeKey']).toBe(`RECURRING_DUE:2026-09-21:${ruleId}`);

    // A re-run writes nothing new — the writer looks the key up under the draft's own period.
    const again = await asTenant(() => insights.generate(householdId, TODAY));
    expect(again.created).toBe(0);
    expect(await read()).toHaveLength(1);

    // Post it, and the condition is gone: an occurrence with a Transaction behind it is spend.
    await asTenant(() =>
      prisma.client.transactions.create({
        data: {
          id: uuidv7(),
          household_id: householdId,
          account_id: accountId,
          kind: 'EXPENSE',
          amount_minor: 1_299_00n,
          currency: 'RSD',
          category_id: null,
          description: 'Netflix',
          source: 'RECURRING',
          status: 'CONFIRMED',
          recurring_rule_id: ruleId,
          occurred_at: new Date('2026-09-21T10:00:00.000Z'),
          occurred_local_date: new Date('2026-09-21T00:00:00.000Z'),
        },
      }),
    );
    await asTenant(() => prisma.client.insights.deleteMany({ where: { household_id: householdId } }));
    await asTenant(() => insights.generate(householdId, TODAY));
    expect(await read()).toEqual([]);

    await asTenant(() => prisma.client.recurring_rules.deleteMany({ where: { id: ruleId } }));
  });

  it('files a charge dated next month under next month’s period, and still de-duplicates it', async () => {
    // The one draft whose period is not the run's own: a bill on the 1st is announced on the last day of
    // the month before, and a writer that looked the key up under the run's month would re-insert it on
    // every retry (the defect this test pins).
    const ruleId = uuidv7();
    await asTenant(() =>
      prisma.client.recurring_rules.create({
        data: {
          id: ruleId,
          household_id: householdId,
          account_id: accountId,
          kind: 'EXPENSE',
          amount_minor: 10_000n,
          currency: 'RSD',
          description: 'Kirija',
          rrule: 'RRULE:FREQ=MONTHLY;BYMONTHDAY=1',
          next_occurrence_on: new Date('2026-10-01T00:00:00.000Z'),
          auto_confirm: true,
          is_detected: false,
          is_active: true,
        },
      }),
    );

    const read = () =>
      asTenant(() =>
        prisma.client.insights.findMany({ where: { household_id: householdId, kind: 'RECURRING_DUE' } }),
      );

    await asTenant(() => prisma.client.insights.deleteMany({ where: { household_id: householdId } }));
    await asTenant(() => insights.generate(householdId, '2026-09-30'));

    const rows = await read();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.period_start.toISOString().slice(0, 10)).toBe('2026-10-01');
    expect((rows[0]?.payload as Record<string, unknown>)['daysUntil']).toBe(1);

    const again = await asTenant(() => insights.generate(householdId, '2026-09-30'));
    expect(again.created).toBe(0);
    expect(await read()).toHaveLength(1);

    await asTenant(() => prisma.client.recurring_rules.deleteMany({ where: { id: ruleId } }));
  });

  it('keeps every amount in the payload as a minor-unit string (ADR-003)', async () => {
    const rows = await asTenant(() =>
      prisma.client.insights.findMany({ where: { household_id: householdId } }),
    );
    for (const row of rows) {
      const payload = row.payload as Record<string, unknown>;
      for (const [key, value] of Object.entries(payload)) {
        if (key.endsWith('Minor')) {
          expect(typeof value, `${row.kind}.${key}`).toBe('string');
          expect(String(value)).toMatch(/^-?\d+$/);
        }
      }
    }
  });
});
