import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7, type LocalDate } from '@finmate/domain';

import { runWithTenant, type TenantContext } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { BudgetingModule } from '../budgeting/budgeting.module';
import { InsightsModule } from '../insights/insights.module';
import { NotificationsModule } from './notifications.module';
import { NotificationsService } from './notifications.service';

/**
 * Alerts and notifications against a real database — docs/05 §9, docs/06 §5.14.
 *
 * The evaluator's own rules are unit-tested in `@finmate/domain`; what only Postgres can answer is
 * what happens to the **rows**: that `UNIQUE (user_id, dedupe_key)` is what actually stops a repeat,
 * that a `SUPPRESSED` decision writes nothing (writing it would burn the key forever), that quiet hours
 * queue rather than drop, and that the user-scoped predicate is what stops one person reading or
 * marking another's notification.
 */
describe('notifications (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let notifications: NotificationsService;

  const householdId = uuidv7();
  const otherHouseholdId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();

  const context: TenantContext = { householdId, userId, role: 'OWNER', requestId: 'notif-it' };
  const otherContext: TenantContext = {
    householdId: otherHouseholdId,
    userId: otherUserId,
    role: 'OWNER',
    requestId: 'notif-it-other',
  };
  const asTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(context, fn);

  let accountId: string;
  let foodId: string;
  const TODAY = '2026-09-20' as LocalDate;

  async function spend(categoryId: string, amountMinor: bigint, occurredOn: string): Promise<void> {
    await asTenant(() =>
      prisma.client.transactions.create({
        data: {
          id: uuidv7(),
          household_id: householdId,
          account_id: accountId,
          kind: 'EXPENSE',
          amount_minor: amountMinor,
          currency: 'RSD',
          category_id: categoryId,
          description: 'test row',
          source: 'MANUAL',
          status: 'CONFIRMED',
          occurred_at: new Date(`${occurredOn}T10:00:00.000Z`),
          occurred_local_date: new Date(`${occurredOn}T00:00:00.000Z`),
        },
      }),
    );
  }

  /**
   * Move the Household's budget for this category to another month.
   *
   * `budgets_unique_scope` allows **one row per scope**, so a monthly budget is a single row whose
   * `period_start` is the month it currently applies to — it does not roll forward by itself, and the
   * insight generator correctly stops projecting for a period the budget is not in.
   */
  async function budgetFor(monthStart: string): Promise<void> {
    await asTenant(() =>
      prisma.client.budgets.updateMany({
        where: { household_id: householdId, category_id: foodId },
        data: { period_start: new Date(`${monthStart}T00:00:00.000Z`) },
      }),
    );
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule, BudgetingModule, InsightsModule, NotificationsModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    notifications = moduleRef.get(NotificationsService);

    const stamp = Date.now();
    await prisma.client.users.createMany({
      data: [
        { id: userId, email: `ntf-${stamp}@example.com`, display_name: 'Notifications Test' },
        { id: otherUserId, email: `ntf-b-${stamp}@example.com`, display_name: 'Other' },
      ],
    });
    for (const [ctx, id, owner] of [
      [context, householdId, userId],
      [otherContext, otherHouseholdId, otherUserId],
    ] as const) {
      await runWithTenant(ctx, () =>
        prisma.client.households.create({
          data: { id, name: 'Notifications Test', owner_user_id: owner, ledger_currency: 'RSD' },
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
      const supermarket = await prisma.client.categories.create({
        data: { id: uuidv7(), name: 'Supermarket', kind: 'EXPENSE', parent_id: food.id },
      });
      foodId = supermarket.id;

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

    for (const month of ['2026-06', '2026-07', '2026-08']) {
      await spend(foodId, 10_000n, `${month}-10`);
    }
    await spend(foodId, 30_000n, '2026-09-10');
  });

  afterAll(async () => {
    for (const [ctx, id] of [
      [context, householdId],
      [otherContext, otherHouseholdId],
    ] as const) {
      await runWithTenant(ctx, async () => {
        await prisma.client.notifications.deleteMany({ where: { household_id: id } });
        await prisma.client.insights.deleteMany({ where: { household_id: id } });
        await prisma.client.alert_rules.deleteMany({ where: { household_id: id } });
        await prisma.client.budgets.deleteMany({ where: { household_id: id } });
        await prisma.client.households.deleteMany({ where: { id } });
      });
    }
    await prisma.client.users.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await moduleRef?.close();
  });

  it('materialises the documented default rules once, and does not duplicate them', async () => {
    const first = await asTenant(() => notifications.run(householdId, userId, TODAY));
    expect(first.insightsCreated).toBeGreaterThan(0);
    expect(first.notificationsCreated).toBeGreaterThan(0);

    const rules = await asTenant(() => notifications.alerts(householdId));
    expect(rules.map((rule) => rule.kind).sort()).toEqual(['PACE_OVERRUN', 'UNUSUAL_SPEND']);
    expect(rules.every((rule) => rule.isActive)).toBe(true);
    expect(rules.every((rule) => rule.channels.includes('IN_APP'))).toBe(true);

    await asTenant(() => notifications.run(householdId, userId, TODAY));
    expect(await asTenant(() => notifications.alerts(householdId))).toHaveLength(2);
  });

  it('writes copy whose numbers come from the insight payload, formatted in the ledger currency', async () => {
    const rows = await asTenant(() =>
      prisma.client.notifications.findMany({ where: { household_id: householdId } }),
    );
    const pace = rows.find((row) => row.dedupe_key.startsWith('BUDGET_PACE'));
    expect(pace).toBeDefined();
    // 30 000 spent on a 10 000 limit: the body names the projection, the limit and the overrun.
    expect(pace?.body).toContain('450.00');
    expect(pace?.body).toContain('100.00');
    expect(pace?.body).toContain('350.00');
    expect(pace?.title).toContain('Supermarket');
    expect(pace?.status).toBe('SENT');
    expect(pace?.sent_at).not.toBeNull();
  });

  it('does not send the same condition twice: the unique key is the dedupe', async () => {
    const second = await asTenant(() => notifications.run(householdId, userId, TODAY));
    expect(second.notificationsCreated).toBe(0);
    expect(second.duplicates).toBeGreaterThan(0);

    const rows = await asTenant(() =>
      prisma.client.notifications.findMany({ where: { household_id: householdId } }),
    );
    const keys = rows.map((row) => row.dedupe_key);
    expect(new Set(keys).size).toBe(keys.length);

    // And the constraint itself, not just the service's courtesy check.
    await expect(
      asTenant(() =>
        prisma.client.notifications.create({
          data: {
            id: uuidv7(),
            household_id: householdId,
            user_id: userId,
            channel: rows[0]!.channel,
            title: 'duplicate',
            body: 'duplicate',
            dedupe_key: rows[0]!.dedupe_key,
            status: 'SENT',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('queues during quiet hours instead of dropping, and writes nothing for a suppressed decision', async () => {
    // Quiet hours set on the pace rule covering "now" in the Household zone.
    const hour = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Belgrade',
      hour: '2-digit',
      hour12: false,
    }).format(new Date());
    const next = String((Number(hour) + 1) % 24).padStart(2, '0');
    const [pace] = await asTenant(() => notifications.alerts(householdId));
    const paceRule = pace!;
    await asTenant(() =>
      notifications.updateRule(householdId, {
        id: paceRule.id,
        quietHours: { start: `${hour}:00`, end: `${next}:00` },
      }),
    );

    // A fresh period and its own budget row: a monthly budget does not roll forward, so October
    // needs an October budget before it has anything to project.
    await budgetFor('2026-10-01');
    await spend(foodId, 20_000n, '2026-10-05');
    const october = await asTenant(() => notifications.run(householdId, userId, '2026-10-20' as LocalDate));
    expect(october.queued).toBeGreaterThan(0);

    const queued = await asTenant(() =>
      prisma.client.notifications.findMany({
        where: { household_id: householdId, status: 'QUEUED' },
      }),
    );
    expect(queued.length).toBeGreaterThan(0);
    expect(queued.every((row) => row.sent_at === null)).toBe(true);

    // Now switch the rule off entirely: a new condition must be suppressed and — crucially — must not
    // occupy its dedupe key, or it could never be delivered again after the rule is re-enabled.
    await asTenant(() => notifications.updateRule(householdId, { id: paceRule.id, isActive: false }));
    await asTenant(() => notifications.updateRule(householdId, { id: paceRule.id, quietHours: null }));
    await budgetFor('2026-12-01');
    await spend(foodId, 5_000n, '2026-12-05');
    const before = await asTenant(() =>
      prisma.client.notifications.count({ where: { household_id: householdId } }),
    );
    const december = await asTenant(() => notifications.run(householdId, userId, '2026-12-20' as LocalDate));
    const after = await asTenant(() =>
      prisma.client.notifications.count({ where: { household_id: householdId } }),
    );
    expect(december.notificationsCreated).toBe(0);
    expect(december.suppressed).toBeGreaterThan(0);
    expect(after).toBe(before);
  });

  it('rate-limits non-critical notifications but never a CRITICAL one', async () => {
    const [rule] = await asTenant(() => notifications.alerts(householdId));
    await asTenant(() =>
      notifications.updateRule(householdId, { id: rule!.id, isActive: true, quietHours: null }),
    );

    // Saturate the user's window with rows that are not tied to a condition.
    await asTenant(() =>
      prisma.client.notifications.createMany({
        data: Array.from({ length: 10 }, (_, index) => ({
          id: uuidv7(),
          household_id: householdId,
          user_id: userId,
          channel: 'IN_APP',
          title: 'filler',
          body: 'filler',
          dedupe_key: `FILLER:${index}`,
          status: 'SENT',
        })),
      }),
    );

    // November has no budget (the row now anchors December), so the only condition it can produce is
    // a CATEGORY_SPIKE — 40 000 against a 20 000 baseline mean, which is WARNING, not CRITICAL.
    await budgetFor('2026-12-01');
    await spend(foodId, 40_000n, '2026-11-05');
    const limited = await asTenant(() => notifications.run(householdId, userId, '2026-11-20' as LocalDate));
    expect(limited.rateLimited).toBeGreaterThan(0);
    expect(
      await asTenant(() =>
        prisma.client.notifications.findFirst({
          where: { household_id: householdId, dedupe_key: { startsWith: 'CATEGORY_SPIKE:2026-11-01' } },
        }),
      ),
    ).toBeNull();

    // December's budget projects a CRITICAL overrun, and the cap must not swallow it.
    await spend(foodId, 25_000n, '2026-12-05');
    await asTenant(() => notifications.run(householdId, userId, '2026-12-20' as LocalDate));
    const critical = await asTenant(() =>
      prisma.client.notifications.findFirst({
        where: { household_id: householdId, dedupe_key: { startsWith: 'BUDGET_PACE:2026-12-01' } },
      }),
    );
    expect(critical).not.toBeNull();
    expect(critical?.title).toContain('Budget overrun');
  });

  it('pages, filters and counts unread; marking read reports the new count', async () => {
    const page = await asTenant(() => notifications.list(householdId, userId, {}, 2));
    expect(page.items).toHaveLength(2);
    expect(page.hasNextPage).toBe(true);
    expect(page.totalCount).toBeGreaterThan(2);

    const first = page.items[0]!;
    const marked = await asTenant(() => notifications.markRead(householdId, userId, first.id));
    expect(marked?.notification.readAt).not.toBeNull();
    expect(marked?.unreadCount).toBe((await asTenant(() => notifications.unreadCount(householdId, userId))));

    // Marking the same row again is a no-op, not an error.
    const again = await asTenant(() => notifications.markRead(householdId, userId, first.id));
    expect(again?.notification.id).toBe(first.id);

    const unread = await asTenant(() => notifications.list(householdId, userId, { unreadOnly: true }, 50));
    expect(unread.items.every((item) => item.readAt === null)).toBe(true);

    const changed = await asTenant(() => notifications.markAllRead(householdId, userId));
    expect(changed).toBeGreaterThanOrEqual(0);
    expect(await asTenant(() => notifications.unreadCount(householdId, userId))).toBe(0);
  });

  it('keeps one user\'s notifications out of another Household and another user\'s reach', async () => {
    const [row] = (await asTenant(() => notifications.list(householdId, userId, {}, 1))).items;
    expect(row).toBeDefined();

    // Same Household, different user: the row is not theirs.
    const otherMember = await asTenant(() => notifications.markRead(householdId, otherUserId, row!.id));
    expect(otherMember).toBeNull();

    // Different Household: nothing of the first Household's is visible at all.
    const foreign = await runWithTenant(otherContext, () =>
      notifications.list(otherHouseholdId, otherUserId, {}, 50),
    );
    expect(foreign.totalCount).toBe(0);

    const otherRun = await runWithTenant(otherContext, () =>
      notifications.run(otherHouseholdId, otherUserId, TODAY),
    );
    expect(otherRun.notificationsCreated).toBe(0);
  });

  it('refuses to edit or delete another Household\'s rule', async () => {
    const [rule] = await asTenant(() => notifications.alerts(householdId));
    const foreignUpdate = await runWithTenant(otherContext, () =>
      notifications.updateRule(otherHouseholdId, { id: rule!.id, isActive: false }),
    );
    expect(foreignUpdate).toBeNull();

    const foreignDelete = await runWithTenant(otherContext, () =>
      notifications.deleteRule(otherHouseholdId, rule!.id),
    );
    expect(foreignDelete).toBe(false);

    const stillOn = await asTenant(() => notifications.alerts(householdId));
    expect(stillOn.some((entry) => entry.id === rule!.id)).toBe(true);
  });
});
