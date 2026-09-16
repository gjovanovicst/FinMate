import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addDays, addMonths, todayIn, uuidv7, type LocalDate } from '@finmate/domain';

import { runWithTenant, type TenantContext } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { SpendReadModel } from '../ledger/spend-read-model';
import { RecurringModule } from './recurring.module';
import { RecurringService } from './recurring.service';

/**
 * Recurring rules against a real database — F-16, docs/06 §5.8, docs/10 §5.3.
 *
 * What only Postgres can answer here, and the four gates the docs name for this job:
 *
 *  - **Idempotent on double execution** — the derived `recurring:{rule}:{date}` key means a second run
 *    posts nothing, whatever the caller sends. Asserted by counting Transactions, not by trusting the
 *    flag.
 *  - **`auto_confirm` respected** — a rule without it posts `PENDING` **and** `needs_review`, which then
 *    does not count as spend (I-7) but does appear for confirmation (I-8).
 *  - **`next_occurrence_on` advances**, including a catch-up run that was missed for two months.
 *  - **The RRULE expands across a month boundary** rather than drifting, and a `COUNT`-limited rule
 *    retires itself.
 *
 * The arithmetic itself is `packages/domain/src/recurring.spec.ts`'s; this file proves the service uses
 * it, and that a materialised row is a **real** ledger row written through the ledger's own path.
 */
describe('recurring rules (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let recurring: RecurringService;
  let spend: SpendReadModel;

  const householdId = uuidv7();
  const otherHouseholdId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();

  const context: TenantContext = { householdId, userId, role: 'OWNER', requestId: 'recurring-it' };
  const otherContext: TenantContext = {
    householdId: otherHouseholdId,
    userId: otherUserId,
    role: 'OWNER',
    requestId: 'recurring-it-other',
  };
  const asTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(context, fn);

  /** A fixed "today" for the arithmetic, so the expectations do not move with the calendar. */
  const TODAY = todayIn('Europe/Belgrade');

  let accountId: string;
  let otherAccountId: string;
  let expenseCategoryId: string;
  let incomeCategoryId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule, RecurringModule],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    recurring = moduleRef.get(RecurringService);
    spend = moduleRef.get(SpendReadModel);

    const stamp = Date.now();
    await prisma.client.users.createMany({
      data: [
        { id: userId, email: `recurring-${stamp}@example.com`, display_name: 'Recurring Test' },
        { id: otherUserId, email: `recurring-b-${stamp}@example.com`, display_name: 'Other' },
      ],
    });
    for (const [ctx, id, owner, name] of [
      [context, householdId, userId, 'Recurring Test'],
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

    accountId = await asTenant(async () => {
      const account = await prisma.client.accounts.create({
        data: { id: uuidv7(), household_id: householdId, name: 'Tekući', kind: 'BANK', currency: 'RSD' },
      });
      return account.id;
    });
    otherAccountId = await runWithTenant(otherContext, async () => {
      const account = await prisma.client.accounts.create({
        data: { id: uuidv7(), household_id: otherHouseholdId, name: 'Tuđi', kind: 'BANK', currency: 'RSD' },
      });
      return account.id;
    });

    await asTenant(async () => {
      expenseCategoryId = (
        await prisma.client.categories.create({
          data: { id: uuidv7(), household_id: householdId, name: 'Pretplate', kind: 'EXPENSE' },
        })
      ).id;
      incomeCategoryId = (
        await prisma.client.categories.create({
          data: { id: uuidv7(), household_id: householdId, name: 'Plata', kind: 'INCOME' },
        })
      ).id;
    });
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

  /** One confirmed expense row, for the detection fixtures. */
  async function row(input: {
    amountMinor: bigint;
    day: LocalDate;
    description: string;
    merchantId?: string | null;
  }): Promise<void> {
    await asTenant(() =>
      prisma.client.transactions.create({
        data: {
          id: uuidv7(),
          household_id: householdId,
          account_id: accountId,
          kind: 'EXPENSE',
          amount_minor: input.amountMinor,
          currency: 'RSD',
          category_id: null,
          merchant_id: input.merchantId ?? null,
          description: input.description,
          source: 'MANUAL',
          status: 'CONFIRMED',
          occurred_at: new Date(`${input.day}T10:00:00.000Z`),
          occurred_local_date: new Date(`${input.day}T00:00:00.000Z`),
        },
      }),
    );
  }

  const create = (overrides: Partial<Parameters<RecurringService['create']>[1]> = {}) =>
    asTenant(() =>
      recurring.create(householdId, {
        accountId,
        kind: 'EXPENSE',
        amountMinor: 129_900n,
        description: 'Netflix',
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=15',
        startsOn: '2026-01-15',
        categoryId: expenseCategoryId,
        ...overrides,
      }),
    );

  // ---------------------------------------------------------------------------------------------
  // CRUD and the schedule
  // ---------------------------------------------------------------------------------------------

  it('stores the canonical schedule and expands the next occurrences', async () => {
    const rule = await create({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=15' });

    expect(rule.rrule).toBe('RRULE:FREQ=MONTHLY;BYMONTHDAY=15');
    expect(rule.nextOccurrenceOn).toBe('2026-01-15');
    expect(rule.currency).toBe('RSD');
    expect(rule.isActive).toBe(true);
    expect(rule.generatedCount).toBe(0);
    expect(rule.upcomingOccurrences).toEqual([
      '2026-01-15',
      '2026-02-15',
      '2026-03-15',
      '2026-04-15',
      '2026-05-15',
      '2026-06-15',
    ]);
    expect(rule.accountName).toBe('Tekući');
  });

  it('refuses a schedule this build cannot expand, rather than ignoring the part', async () => {
    await expect(create({ rrule: 'FREQ=MONTHLY;BYSETPOS=-1' })).rejects.toThrow(/does not expand/);
    await expect(create({ rrule: 'FREQ=HOURLY' })).rejects.toThrow(/DAILY, WEEKLY, MONTHLY and YEARLY/);
    await expect(create({ rrule: 'FREQ=DAILY;INTERVAL=0' })).rejects.toThrow(/whole number/);
    await expect(create({ rrule: 'nonsense' })).rejects.toThrow(/could not be read/);
  });

  it('refuses an empty description, a zero amount, a foreign Account and a mismatched Category (I-3)', async () => {
    await expect(create({ description: '   ' })).rejects.toThrow(/description is required/);
    await expect(create({ amountMinor: 0n })).rejects.toThrow(/greater than zero/);
    await expect(create({ accountId: otherAccountId })).rejects.toThrow(/Account not found/);
    await expect(create({ categoryId: incomeCategoryId })).rejects.toThrow(/I-3/);
  });

  it('patches a rule, and re-anchors the schedule when it changes', async () => {
    const rule = await create({ description: 'Kirija', rrule: 'FREQ=MONTHLY;BYMONTHDAY=1', startsOn: '2026-01-01' });

    const patched = await asTenant(() =>
      recurring.update(householdId, { ruleId: rule.id, amountMinor: 45_000_00n, autoConfirm: true }),
    );
    expect(patched.amountMinor).toBe(4_500_000n);
    expect(patched.autoConfirm).toBe(true);
    // An absent field is left alone.
    expect(patched.nextOccurrenceOn).toBe('2026-01-01');

    const rescheduled = await asTenant(() =>
      recurring.update(householdId, { ruleId: rule.id, rrule: 'FREQ=WEEKLY;BYDAY=MO', startsOn: '2026-03-02' }),
    );
    expect(rescheduled.rrule).toBe('RRULE:FREQ=WEEKLY;BYDAY=MO');
    expect(rescheduled.nextOccurrenceOn).toBe('2026-03-02');

    const cleared = await asTenant(() => recurring.update(householdId, { ruleId: rule.id, clearCategory: true }));
    expect(cleared.categoryId).toBeNull();
  });

  it('lists active rules by default, and deactivating keeps the row', async () => {
    const rule = await create({ description: 'Stari', startsOn: '2026-01-20' });
    await asTenant(() => recurring.update(householdId, { ruleId: rule.id, isActive: false }));

    const active = await asTenant(() => recurring.list(householdId, true));
    expect(active.some((row) => row.id === rule.id)).toBe(false);
    const all = await asTenant(() => recurring.list(householdId, false));
    expect(all.some((row) => row.id === rule.id)).toBe(true);

    // A nullable Boolean arrives as `null` from the wire: it must not be read as "active only".
    const nulled = await asTenant(() => recurring.list(householdId, null));
    expect(nulled.some((row) => row.id === rule.id)).toBe(true);
  });

  it('soft-deletes a rule without touching the rows it posted', async () => {
    const rule = await create({ description: 'Brisanje', startsOn: '2026-01-25' });
    await asTenant(() => recurring.remove(householdId, rule.id));

    await expect(asTenant(() => recurring.getById(householdId, rule.id))).rejects.toThrow(
      /Recurring rule not found/,
    );
    // Soft delete: the row is still there, deactivated, for the audit trail.
    const stored = await asTenant(() =>
      prisma.client.recurring_rules.findFirst({ where: { id: rule.id } }),
    );
    expect(stored?.deleted_at).not.toBeNull();
    expect(stored?.is_active).toBe(false);
  });

  // ---------------------------------------------------------------------------------------------
  // Materialisation
  // ---------------------------------------------------------------------------------------------

  it('posts a due occurrence as a real CONFIRMED Transaction and advances the rule', async () => {
    const rule = await create({
      description: 'Teretana',
      amountMinor: 3_000_00n,
      startsOn: '2026-05-10',
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=10',
      autoConfirm: true,
    });

    const result = await asTenant(() => recurring.materialise(householdId, { ruleIds: [rule.id], asOf: '2026-05-10' }));

    expect(result.created).toHaveLength(1);
    const posted = result.created[0]!;
    expect(posted.source).toBe('RECURRING');
    expect(posted.status).toBe('CONFIRMED');
    expect(posted.needsReview).toBe(false);
    expect(posted.amount.amountMinor).toBe(300_000n);
    expect(posted.occurredLocalDate).toBe('2026-05-10');

    const after = await asTenant(() => recurring.getById(householdId, rule.id));
    expect(after.generatedCount).toBe(1);
    expect(after.nextOccurrenceOn).toBe('2026-06-10');
    expect(result.newNextOccurrences).toEqual([{ ruleId: rule.id, nextOccurrenceOn: '2026-06-10' }]);
  });

  it('is idempotent on a second run, whatever the caller sends (I-10)', async () => {
    const rule = await create({
      description: 'Osiguranje',
      startsOn: '2026-05-20',
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=20',
      autoConfirm: true,
    });

    const first = await asTenant(() => recurring.materialise(householdId, { ruleIds: [rule.id], asOf: '2026-05-20' }));
    expect(first.created).toHaveLength(1);

    // The rule has advanced, so nothing is due at all on the second run.
    const second = await asTenant(() => recurring.materialise(householdId, { ruleIds: [rule.id], asOf: '2026-05-20' }));
    expect(second.created).toHaveLength(0);

    // And even with the date rewound (a job replaying an old window), nothing is posted twice.
    await asTenant(() =>
      prisma.client.recurring_rules.update({
        where: { id: rule.id },
        data: { next_occurrence_on: new Date('2026-05-20T00:00:00.000Z') },
      }),
    );
    const replay = await asTenant(() => recurring.materialise(householdId, { ruleIds: [rule.id], asOf: '2026-05-20' }));
    expect(replay.created).toHaveLength(0);
    expect(replay.skipped).toEqual([{ ruleId: rule.id, reason: 'ALREADY_MATERIALISED' }]);
    expect(replay.wasReplayed).toBe(true);

    const rows = await asTenant(() =>
      prisma.client.transactions.count({ where: { household_id: householdId, recurring_rule_id: rule.id } }),
    );
    expect(rows).toBe(1);
  });

  it('posts PENDING and flagged for review without auto-confirm, and that is not spend (I-7, I-8)', async () => {
    const rule = await create({
      description: 'Neplaćena pretplata',
      amountMinor: 500_00n,
      startsOn: '2026-06-01',
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=1',
      autoConfirm: false,
    });

    const result = await asTenant(() => recurring.materialise(householdId, { ruleIds: [rule.id], asOf: '2026-06-01' }));
    const posted = result.created[0]!;
    expect(posted.status).toBe('PENDING');
    expect(posted.needsReview).toBe(true);

    // I-7: a PENDING row contributes to no figure. The read model only counts CONFIRMED.
    const total = await asTenant(() =>
      spend.total(householdId, { from: '2026-06-01' as LocalDate, to: '2026-06-30' as LocalDate }, { kind: 'EXPENSE' }),
    );
    expect(total.minor).toBe(0n);

    // I-8: it is in the blocking lane, so the user sees it.
    const queue = await asTenant(() =>
      prisma.client.transactions.count({
        where: { household_id: householdId, needs_review: true, deleted_at: null },
      }),
    );
    expect(queue).toBeGreaterThanOrEqual(1);
  });

  it('catches up every missed occurrence and advances past them', async () => {
    const rule = await create({
      description: 'Zakašnjelo',
      startsOn: '2026-07-05',
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=5',
      autoConfirm: true,
    });

    // The job did not run for two months: July, August and September are all due.
    const result = await asTenant(() => recurring.materialise(householdId, { ruleIds: [rule.id], asOf: '2026-09-05' }));
    expect(result.created.map((row) => row.occurredLocalDate)).toEqual([
      '2026-07-05',
      '2026-08-05',
      '2026-09-05',
    ]);

    const after = await asTenant(() => recurring.getById(householdId, rule.id));
    expect(after.generatedCount).toBe(3);
    expect(after.nextOccurrenceOn).toBe('2026-10-05');
  });

  it('previews with dryRun and writes nothing', async () => {
    const rule = await create({
      description: 'Pregled',
      startsOn: '2026-08-11',
      rrule: 'FREQ=DAILY;INTERVAL=10',
      autoConfirm: true,
    });

    const preview = await asTenant(() =>
      recurring.materialise(householdId, { ruleIds: [rule.id], asOf: '2026-08-31', dryRun: true }),
    );
    expect(preview.previewed.map((row) => row.occurredOn)).toEqual(['2026-08-11', '2026-08-21', '2026-08-31']);
    expect(preview.created).toHaveLength(0);
    expect(preview.previewed[0]?.status).toBe('CONFIRMED');

    // Nothing was written and the rule did not move.
    const after = await asTenant(() => recurring.getById(householdId, rule.id));
    expect(after.generatedCount).toBe(0);
    expect(after.nextOccurrenceOn).toBe('2026-08-11');
  });

  it('posts the occurrences inside the rule’s own window, then retires it', async () => {
    const rule = await create({
      description: 'Isteklo',
      startsOn: '2026-01-10',
      endsOn: '2026-02-10',
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=10',
      autoConfirm: true,
    });

    // A run that arrives after the end still posts the occurrences the rule actually had (January and
    // February are inside `endsOn`); dropping them would silently lose two months of a paid bill.
    const result = await asTenant(() => recurring.materialise(householdId, { ruleIds: [rule.id], asOf: '2026-06-01' }));
    expect(result.created.map((row) => row.occurredLocalDate)).toEqual(['2026-01-10', '2026-02-10']);

    // The rule is finished: no further occurrence exists, so it retires itself.
    const after = await asTenant(() => recurring.getById(householdId, rule.id));
    expect(after.isActive).toBe(false);
    expect(after.nextOccurrenceOn).toBe('2026-02-10');

    // A later run reports the finish rather than posting anything.
    const later = await asTenant(() => recurring.materialise(householdId, { ruleIds: [rule.id], asOf: '2026-06-01' }));
    expect(later.created).toHaveLength(0);
    expect(later.wasReplayed).toBe(false);
  });

  it('respects COUNT and deactivates once the occurrences are used up', async () => {
    const rule = await create({
      description: 'Dva puta',
      startsOn: '2026-09-01',
      rrule: 'FREQ=MONTHLY;COUNT=2',
      autoConfirm: true,
    });

    const first = await asTenant(() => recurring.materialise(householdId, { ruleIds: [rule.id], asOf: '2026-10-01' }));
    expect(first.created).toHaveLength(2);

    const after = await asTenant(() => recurring.getById(householdId, rule.id));
    expect(after.generatedCount).toBe(2);
    expect(after.isActive).toBe(false);
    expect(after.upcomingOccurrences).toEqual([]);
  });

  it('materialises every due rule when no ids are given, and lists the window', async () => {
    const soon = await create({ description: 'Uskoro', startsOn: addMonths(TODAY, 1), rrule: 'FREQ=MONTHLY;BYMONTHDAY=1' });
    const far = await create({
      description: 'Daleko',
      startsOn: addDays(addMonths(TODAY, 3), 0),
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=1',
    });

    const upcoming = await asTenant(() => recurring.occurrencesBetween(householdId, 45));
    const windowed = new Set(upcoming.filter((entry) => entry.dates.length > 0).map((entry) => entry.ruleId));
    expect(windowed.has(soon.id)).toBe(true);
    expect(windowed.has(far.id)).toBe(false);

    // No ruleIds ⇒ every due rule. `asOf` is far enough ahead that both are due.
    const all = await asTenant(() => recurring.materialise(householdId, { asOf: addMonths(TODAY, 4) }));
    const descriptions = all.created.map((row) => row.description);
    expect(descriptions).toContain('Uskoro');
    expect(descriptions).toContain('Daleko');
  });

  // ---------------------------------------------------------------------------------------------
  // What is still to be charged — the projection (3.4.2) and the due alert (3.4.3) share it
  // ---------------------------------------------------------------------------------------------

  it('lists a charge still to be posted, and drops it the moment a Transaction exists (F-22)', async () => {
    const rule = await create({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=27', startsOn: '2026-01-27' });
    const asOf = '2026-01-26' as LocalDate;

    const due = await asTenant(() => recurring.dueSoon(householdId, { asOf, withinDays: 1 }));
    const mine = due.filter((occurrence) => occurrence.ruleId === rule.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.occurredOn).toBe('2026-01-27');
    expect(mine[0]?.amountMinor).toBe(129_900n);
    expect(mine[0]?.description).toBe('Netflix');

    // The projection and the alert read the **same** list, so they cannot disagree: `committed` sums it.
    const committed = await asTenant(() =>
      recurring.committed(householdId, { from: asOf, to: '2026-01-31', asOf }),
    );
    expect(committed.occurrences).toBeGreaterThanOrEqual(1);
    expect(committed.minor).toBeGreaterThanOrEqual(129_900n);

    // A charge two days out is not yet "due soon" at a one-day horizon.
    const tooEarly = await asTenant(() =>
      recurring.dueSoon(householdId, { asOf: '2026-01-25' as LocalDate, withinDays: 1 }),
    );
    expect(tooEarly.some((occurrence) => occurrence.ruleId === rule.id)).toBe(false);

    // Post the occurrence without advancing the rule: it is spend now, and an alert about a charge that
    // has already landed is the false alarm that trains a user to ignore the feed.
    await asTenant(() =>
      prisma.client.transactions.create({
        data: {
          id: uuidv7(),
          household_id: householdId,
          account_id: accountId,
          kind: 'EXPENSE',
          amount_minor: 129_900n,
          currency: 'RSD',
          category_id: expenseCategoryId,
          description: 'Netflix',
          source: 'RECURRING',
          status: 'CONFIRMED',
          recurring_rule_id: rule.id,
          occurred_at: new Date('2026-01-27T10:00:00.000Z'),
          occurred_local_date: new Date('2026-01-27T00:00:00.000Z'),
        },
      }),
    );

    const afterPosting = await asTenant(() => recurring.dueSoon(householdId, { asOf, withinDays: 1 }));
    expect(afterPosting.some((occurrence) => occurrence.ruleId === rule.id)).toBe(false);
  });

  it('never announces an income rule, an inactive one, or another Household’s charge', async () => {
    const asOf = '2026-02-04' as LocalDate;
    const income = await create({
      kind: 'INCOME',
      categoryId: incomeCategoryId,
      description: 'Plata',
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=5',
      startsOn: '2026-02-05',
    });
    const inactive = await create({
      description: 'Ugašeno',
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=5',
      startsOn: '2026-02-05',
    });
    await asTenant(() => recurring.update(householdId, { ruleId: inactive.id, isActive: false }));

    const foreign = await runWithTenant(otherContext, () =>
      prisma.client.recurring_rules.create({
        data: {
          id: uuidv7(),
          household_id: otherHouseholdId,
          account_id: otherAccountId,
          kind: 'EXPENSE',
          amount_minor: 999_00n,
          currency: 'RSD',
          description: 'Tuđi račun',
          rrule: 'RRULE:FREQ=MONTHLY;BYMONTHDAY=5',
          next_occurrence_on: new Date('2026-02-05T00:00:00.000Z'),
          auto_confirm: false,
          is_detected: false,
          is_active: true,
        },
      }),
    );

    const due = await asTenant(() => recurring.dueSoon(householdId, { asOf, withinDays: 1 }));
    const ids = due.map((occurrence) => occurrence.ruleId);
    expect(ids).not.toContain(income.id);
    expect(ids).not.toContain(inactive.id);
    expect(ids).not.toContain(foreign.id);

    // The other Household's fixture is shared with the isolation test below, which asserts it has no
    // rules of its own — so this one is removed rather than left behind.
    await runWithTenant(otherContext, () =>
      prisma.client.recurring_rules.deleteMany({ where: { id: foreign.id } }),
    );
  });

  // ---------------------------------------------------------------------------------------------
  // Detection (3.3.4)
  // ---------------------------------------------------------------------------------------------

  /** A run of confirmed charges for one Merchant, `count` months back from `last`. */
  async function history(input: {
    description: string;
    amountMinor: bigint;
    last: LocalDate;
    count: number;
    merchantId?: string | null;
  }): Promise<void> {
    for (let index = input.count - 1; index >= 0; index -= 1) {
      await row({
        amountMinor: input.amountMinor,
        day: addMonths(input.last, -index),
        description: input.description,
        merchantId: input.merchantId ?? null,
      });
    }
  }

  it('proposes a subscription with its evidence and activates nothing', async () => {
    await history({ description: 'Spotify', amountMinor: 599_00n, last: TODAY, count: 4 });

    const proposals = await asTenant(() => recurring.detect(householdId, { today: TODAY }));

    expect(proposals).toHaveLength(1);
    const proposal = proposals[0]!;
    expect(proposal.description).toBe('Spotify');
    expect(proposal.isDetected).toBe(true);
    expect(proposal.isActive).toBe(false);
    expect(proposal.amountMinor).toBe(599_00n);
    expect(proposal.rrule).toBe('RRULE:FREQ=MONTHLY');
    expect(proposal.generatedCount).toBe(0);

    // Nothing was posted and nothing is due: a proposal is not a rule.
    const materialised = await asTenant(() => recurring.materialise(householdId, { ruleIds: [proposal.id], asOf: TODAY }));
    expect(materialised.created).toHaveLength(0);
  });

  it('accepting a proposal turns it into an ordinary rule that then posts', async () => {
    await history({ description: 'Deezer', amountMinor: 799_00n, last: addMonths(TODAY, -1), count: 3 });
    const [proposal] = await asTenant(() => recurring.detect(householdId, { today: TODAY }));
    expect(proposal).toBeDefined();

    const accepted = await asTenant(() => recurring.confirmDetected(householdId, proposal!.id));
    expect(accepted.isDetected).toBe(false);
    expect(accepted.isActive).toBe(true);

    // Its next occurrence is in the future, so nothing is due *yet* — the rule is real, not a duplicate.
    const due = await asTenant(() =>
      recurring.materialise(householdId, { ruleIds: [accepted.id], asOf: addMonths(TODAY, 2) }),
    );
    expect(due.created.length).toBeGreaterThanOrEqual(1);
    expect(due.created.every((row) => row.description === 'Deezer')).toBe(true);
  });

  it('never proposes the same identity twice, and a dismissal is remembered', async () => {
    await history({ description: 'HBO', amountMinor: 699_00n, last: TODAY, count: 3 });
    const first = await asTenant(() => recurring.detect(householdId, { today: TODAY }));
    const hbo = first.find((row) => row.description === 'HBO');
    expect(hbo).toBeDefined();

    // While it is still an open proposal, a second run does not duplicate it.
    const again = await asTenant(() => recurring.detect(householdId, { today: TODAY }));
    expect(again.some((row) => row.description === 'HBO')).toBe(false);

    await asTenant(() => recurring.dismissDetected(householdId, hbo!.id));
    const afterDismissal = await asTenant(() => recurring.detect(householdId, { today: TODAY }));
    expect(afterDismissal.some((row) => row.description === 'HBO')).toBe(false);
  });

  it('refuses to dismiss a rule the Household made', async () => {
    const rule = await create({ description: 'Moje pravilo', startsOn: '2026-01-15' });
    await expect(asTenant(() => recurring.dismissDetected(householdId, rule.id))).rejects.toThrow(
      /not a suggestion/,
    );
  });

  it('does not treat three groceries as a subscription', async () => {
    await history({ description: 'Idea', amountMinor: 1_200_00n, last: TODAY, count: 3 });
    await row({ amountMinor: 9_800_00n, day: addMonths(TODAY, -2), description: 'Idea' });
    await row({ amountMinor: 150_00n, day: addMonths(TODAY, -3), description: 'Idea' });

    const proposals = await asTenant(() => recurring.detect(householdId, { today: TODAY }));
    expect(proposals.some((row) => row.description === 'Idea')).toBe(false);
  });

  it('never detects another Household’s subscriptions', async () => {
    const proposals = await runWithTenant(otherContext, () => recurring.detect(otherHouseholdId, { today: TODAY }));
    expect(proposals).toHaveLength(0);
    await expect(
      runWithTenant(otherContext, () => recurring.confirmDetected(otherHouseholdId, '01a0a711-0000-7000-8000-000000000000')),
    ).rejects.toThrow(/Recurring rule not found/);
  });

  it('never touches another Household’s rules', async () => {
    const rule = await create({ description: 'Privatno', startsOn: '2026-01-30' });

    // Read as the OTHER Household: the guard scopes every query to the session (ADR-008), so the id
    // resolves to nothing. (Asking as the owner with a foreign `householdId` argument returns the
    // owner's row — the session decides, never the argument — which is the property that makes the
    // explicit `household_id` in every service call belt-and-braces rather than the guard itself.)
    await expect(
      runWithTenant(otherContext, () => recurring.getById(otherHouseholdId, rule.id)),
    ).rejects.toThrow(/Recurring rule not found/);
    const theirs = await runWithTenant(otherContext, () => recurring.list(otherHouseholdId, false));
    expect(theirs).toHaveLength(0);
    const posted = await runWithTenant(otherContext, () =>
      recurring.materialise(otherHouseholdId, { asOf: '2027-01-01' }),
    );
    expect(posted.created).toHaveLength(0);
  });
});
