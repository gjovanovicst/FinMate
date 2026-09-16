import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7, type LocalDate } from '@finmate/domain';

import { runWithTenant, type TenantContext } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { BudgetingModule } from '../budgeting/budgeting.module';
import { MailService } from '../mail/mail.service';
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

  /**
   * A stand-in for SMTP.
   *
   * The suite is not testing nodemailer or Mailhog, and a real socket would make it flaky; what it
   * *is* testing is that dispatch hands the row to the mailer with the lock-screen-safe copy. So the
   * stub records what it was given.
   */
  const sentMail: { to: string; subject: string; text: string }[] = [];
  const mailStub = {
    sendNotification: (to: string, subject: string, text: string): Promise<void> => {
      sentMail.push({ to, subject, text });
      return Promise.resolve();
    },
  };

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
      // `AuthModule` is in the graph because it is `@Global` and provides `MailService` — the same
      // reason `AppModule` imports it. The real transport is replaced below: CI has no Mailhog.
      imports: [
        ConfigModule.forRoot(),
        PrismaModule,
        AuthModule,
        BudgetingModule,
        InsightsModule,
        NotificationsModule,
      ],
    })
      .overrideProvider(MailService)
      .useValue(mailStub)
      .compile();
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
        await prisma.client.recurring_rules.deleteMany({ where: { household_id: id } });
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
    expect(rules.map((rule) => rule.kind).sort()).toEqual([
      'PACE_OVERRUN',
      'RECURRING_DUE',
      'UNUSUAL_SPEND',
    ]);
    expect(rules.every((rule) => rule.isActive)).toBe(true);
    expect(rules.every((rule) => rule.channels.includes('IN_APP'))).toBe(true);

    await asTenant(() => notifications.run(householdId, userId, TODAY));
    expect(await asTenant(() => notifications.alerts(householdId))).toHaveLength(3);
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

  it('turns a due charge into an in-app notification with the bill’s own words (F-22, T-09)', async () => {
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
          description: 'Netflix',
          rrule: 'RRULE:FREQ=MONTHLY;BYMONTHDAY=21',
          next_occurrence_on: new Date('2026-09-21T00:00:00.000Z'),
          auto_confirm: true,
          is_detected: false,
          is_active: true,
        },
      }),
    );

    const run = await asTenant(() => notifications.run(householdId, userId, TODAY));
    expect(run.insightsCreated).toBeGreaterThan(0);

    const row = await asTenant(() =>
      prisma.client.notifications.findFirst({
        where: { household_id: householdId, dedupe_key: { startsWith: 'RECURRING_DUE:2026-09-21' } },
      }),
    );
    expect(row).not.toBeNull();
    expect(row?.channel).toBe('IN_APP');
    // `IN_APP` means the row *is* the delivery.
    expect(row?.status).toBe('SENT');
    expect(row?.title).toBe('Bill due tomorrow: Netflix');
    expect(row?.body).toBe('1299.00 is charged tomorrow.');

    // The producer is reachable only because it is mapped to a rule and that rule exists by default.
    const rules = await asTenant(() => notifications.alerts(householdId));
    expect(rules.some((rule) => rule.kind === 'RECURRING_DUE' && rule.isActive)).toBe(true);

    // Remove the rule: the rest of this suite shares the Household and asserts exact notification counts
    // for later months, which a live monthly rule would silently add to.
    await asTenant(() => prisma.client.recurring_rules.deleteMany({ where: { id: ruleId } }));
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

  it('keeps every non-in-app body free of figures (T-09), and the in-app body full', async () => {
    const [rule] = await asTenant(() => notifications.alerts(householdId));
    await asTenant(() =>
      notifications.updateRule(householdId, { id: rule!.id, channels: ['IN_APP', 'EMAIL'] }),
    );
    // The preference must accept EMAIL too, or the row is never written at all.
    await asTenant(() => notifications.updatePreferences(householdId, { channels: ['IN_APP', 'EMAIL'] }));
    await budgetFor('2027-01-01');
    await spend(foodId, 12_000n, '2027-01-05');
    await asTenant(() => notifications.run(householdId, userId, '2027-01-20' as LocalDate));

    const rows = await asTenant(() =>
      prisma.client.notifications.findMany({
        where: { household_id: householdId, dedupe_key: { startsWith: 'BUDGET_PACE:2027-01-01' } },
      }),
    );
    const inApp = rows.find((row) => row.channel === 'IN_APP');
    const email = rows.find((row) => row.channel === 'EMAIL');
    expect(inApp).toBeDefined();
    expect(email).toBeDefined();
    // In-app carries the figures…
    expect(/\d/.test(inApp!.body)).toBe(true);
    // …and the channel that lands on a lock screen carries none, by the only test that survives a
    // new generator: no digit at all (docs/08 T-09).
    expect(/\d/.test(email!.title)).toBe(false);
    expect(/\d/.test(email!.body)).toBe(false);
  });

  it('stores preferences in households.settings and honours them', async () => {
    const updated = await asTenant(() =>
      notifications.updatePreferences(householdId, {
        channels: ['IN_APP'],
        quietHours: { start: '21:00', end: '08:00' },
        positiveFeedback: false,
        locale: 'sr-Latn',
      }),
    );
    expect(updated.quietHours).toEqual({ start: '21:00', end: '08:00' });
    expect(updated.positiveFeedback).toBe(false);

    // Read back through the same path the resolver uses.
    expect(await asTenant(() => notifications.preferences(householdId))).toEqual(updated);

    // The write must not clobber the other keys in the settings document.
    const household = await asTenant(() =>
      prisma.client.households.findFirst({ where: { id: householdId }, select: { settings: true } }),
    );
    const settings = household?.settings as Record<string, unknown>;
    expect(settings['notifications']).toEqual(updated);

    // And the evaluator sees them: EMAIL is refused by the preference even when the rule allows it.
    const [rule] = await asTenant(() => notifications.alerts(householdId));
    await asTenant(() =>
      notifications.updateRule(householdId, { id: rule!.id, channels: ['IN_APP', 'EMAIL'] }),
    );
    await budgetFor('2027-02-01');
    await spend(foodId, 12_000n, '2027-02-05');
    await asTenant(() => notifications.run(householdId, userId, '2027-02-20' as LocalDate));
    const february = await asTenant(() =>
      prisma.client.notifications.findMany({
        where: { household_id: householdId, dedupe_key: { startsWith: 'BUDGET_PACE:2027-02-01' } },
      }),
    );
    expect(february.map((row) => row.channel)).toEqual(['IN_APP']);

    await asTenant(() => notifications.updatePreferences(householdId, { quietHours: null }));
  });

  it('dispatches what is due: in-app becomes SENT, email goes out, push stays queued', async () => {
    // A quiet-hours window covering now, so the run writes QUEUED rows rather than SENT ones.
    const hour = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Belgrade',
      hour: '2-digit',
      hour12: false,
    }).format(new Date());
    const next = String((Number(hour) + 1) % 24).padStart(2, '0');
    await asTenant(() =>
      notifications.updatePreferences(householdId, {
        channels: ['IN_APP', 'EMAIL', 'WEB_PUSH'],
        quietHours: { start: `${hour}:00`, end: `${next}:00` },
      }),
    );
    const [rule] = await asTenant(() => notifications.alerts(householdId));
    await asTenant(() =>
      notifications.updateRule(householdId, {
        id: rule!.id,
        isActive: true,
        channels: ['IN_APP', 'EMAIL', 'WEB_PUSH'],
      }),
    );
    await budgetFor('2027-03-01');
    await spend(foodId, 12_000n, '2027-03-05');
    const run = await asTenant(() => notifications.run(householdId, userId, '2027-03-20' as LocalDate));
    expect(run.queued).toBeGreaterThan(0);

    // Still inside the window: the drain defers everything.
    const deferred = await asTenant(() => notifications.dispatch(householdId));
    expect(deferred.deferred).toBeGreaterThan(0);
    expect(deferred.sent).toBe(0);

    // Window over.
    await asTenant(() => notifications.updatePreferences(householdId, { quietHours: null }));
    const pass = await asTenant(() => notifications.dispatch(householdId));
    expect(pass.sent).toBeGreaterThan(0);
    expect(pass.skipped).toBeGreaterThan(0);
    // The skip is never a bare count: the test environment has no VAPID key pair, so the reason names
    // exactly what an operator would have to configure (ADR-028 decision 2).
    expect(pass.reasons.some((reason) => reason.includes('VAPID_PUBLIC_KEY'))).toBe(true);

    const rows = await asTenant(() =>
      prisma.client.notifications.findMany({
        where: { household_id: householdId, dedupe_key: { startsWith: 'BUDGET_PACE:2027-03-01' } },
      }),
    );
    const byChannel = new Map(rows.map((row) => [row.channel, row]));
    expect(byChannel.get('IN_APP')?.status).toBe('SENT');
    expect(byChannel.get('IN_APP')?.sent_at).not.toBeNull();
    // EMAIL is handed to the mailer, with the lock-screen-safe copy (T-09) and the owner's address.
    expect(byChannel.get('EMAIL')?.status).toBe('SENT');
    const mailed = sentMail.find((entry) => entry.subject === byChannel.get('EMAIL')?.title);
    expect(mailed).toBeDefined();
    expect(/\d/.test(mailed!.text)).toBe(false);
    expect(mailed!.to).toContain('@');
    // Push is configured through the `WEB_PUSH` seam (ADR-028), and this environment has no VAPID key
    // pair, so the row is left QUEUED rather than marked sent — the honest state.
    expect(byChannel.get('WEB_PUSH')?.status).toBe('QUEUED');

    // Idempotent as far as sending goes: nothing is delivered twice. Push rows are still *considered*
    // on every pass — with no VAPID keys they stay QUEUED — which is why `skipped`, not `considered`,
    // is the count that returns to zero.
    const again = await asTenant(() => notifications.dispatch(householdId));
    expect(again.sent).toBe(0);
    expect(again.skipped).toBeGreaterThan(0);
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
