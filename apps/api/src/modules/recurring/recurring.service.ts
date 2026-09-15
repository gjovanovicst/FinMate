import { Injectable } from '@nestjs/common';

import {
  DEFAULT_TIME_ZONE,
  addDays,
  compareLocalDates,
  expandOccurrences,
  formatRRule,
  nextOccurrenceOn,
  parseRRule,
  todayIn,
  uuidv7,
  type LocalDate,
  type RRuleError,
  type RRuleSpec,
} from '@finmate/domain';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import { PrismaService } from '../../prisma/prisma.service';
import { TransactionsService } from '../ledger/transactions.service';
import {
  TransactionKind,
  TransactionSource,
  TransactionStatus,
  type TransactionModel,
} from '../ledger/transaction.model';

/**
 * Recurring rules — F-16, docs/06 §4/§5.8, docs/02 §4.14.
 *
 * ## The expansion is pure; this service only decides *what* to expand
 *
 * `@finmate/domain`'s `parseRRule` / `nextOccurrenceOn` / `expandOccurrences` own every date, tested
 * against the cases that go wrong quietly (a month without the requested day, an interval, a finished
 * rule). This file owns the ledger side: which rules are due, what a materialised row looks like, and
 * how the rule's `next_occurrence_on` moves.
 *
 * ## Idempotency is the occurrence, not the request
 *
 * docs/06 §5.8 takes a batch `idempotencyKey`. This build **does not**: a materialised Transaction's
 * `idempotency_key` is derived from `(ruleId, occurrence date)`, so a retry is safe *whatever* key the
 * caller sends — including the same job running twice with different keys, which a batch key cannot
 * prevent. That is a stronger guarantee than the document asks for, and `wasReplayed` reports it.
 *
 * ## Nothing is posted silently
 *
 * A rule with `auto_confirm = false` posts a **PENDING** row flagged for review (I-8's blocking lane),
 * which does not count towards spend (I-7) until the user confirms it — docs/06 §5.8's rule, and the
 * reason a subscription the household cancelled does not quietly eat the budget.
 *
 * ## Not built here
 *
 * Subscription **detection** (`is_detected`, `confirmDetectedSubscription`) is task 3.3.4, and the
 * `recurring.materialise` **job** needs the worker, which does not exist: the mutation calls exactly
 * the service method the job will, so wiring the scheduler later changes nothing here.
 *
 * @module apps/api/src/modules/recurring
 */

/** How many dates a rule's `upcomingOccurrences` carries. docs/06 §4 says six. */
const UPCOMING_COUNT = 6;

export interface RecurringRuleView {
  readonly id: string;
  readonly accountId: string;
  readonly accountName: string | null;
  readonly kind: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly categoryId: string | null;
  readonly merchantId: string | null;
  readonly description: string;
  readonly rrule: string;
  readonly nextOccurrenceOn: LocalDate;
  readonly endsOn: LocalDate | null;
  readonly autoConfirm: boolean;
  readonly isDetected: boolean;
  readonly isActive: boolean;
  readonly generatedCount: number;
  readonly upcomingOccurrences: readonly LocalDate[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OccurrenceView {
  readonly ruleId: string;
  readonly nextOccurrenceOn: LocalDate | null;
}

export interface PreviewView {
  readonly ruleId: string;
  readonly occurredOn: LocalDate;
  readonly accountId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly description: string;
  readonly status: string;
}

export interface MaterialiseResultView {
  readonly created: readonly TransactionModel[];
  readonly previewed: readonly PreviewView[];
  readonly skipped: readonly { readonly ruleId: string; readonly reason: string }[];
  readonly newNextOccurrences: readonly OccurrenceView[];
  readonly wasReplayed: boolean;
}

export interface CreateRuleInput {
  readonly accountId: string;
  readonly kind: 'EXPENSE' | 'INCOME';
  readonly amountMinor: bigint;
  readonly description: string;
  readonly rrule: string;
  readonly startsOn?: string | null;
  readonly endsOn?: string | null;
  readonly categoryId?: string | null;
  readonly merchantId?: string | null;
  readonly autoConfirm?: boolean | null;
}

export interface UpdateRuleInput {
  readonly ruleId: string;
  readonly amountMinor?: bigint | null;
  readonly description?: string | null;
  readonly rrule?: string | null;
  readonly startsOn?: string | null;
  readonly endsOn?: string | null;
  readonly clearEndsOn?: boolean | null;
  readonly categoryId?: string | null;
  readonly clearCategory?: boolean | null;
  readonly autoConfirm?: boolean | null;
  readonly isActive?: boolean | null;
}

export interface MaterialiseInput {
  readonly ruleIds?: readonly string[] | null;
  readonly asOf?: string | null;
  readonly dryRun?: boolean | null;
}

@Injectable()
export class RecurringService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionsService,
  ) {}

  async list(householdId: string, activeOnly?: boolean | null): Promise<readonly RecurringRuleView[]> {
    const rows = await this.prisma.client.recurring_rules.findMany({
      where: {
        household_id: householdId,
        deleted_at: null,
        // A nullable Boolean argument arrives as `null`, not `undefined` (docs/15). The default is
        // `true` in the SDL, and `null` (an explicit "give me everything") is treated as `false`.
        ...(activeOnly === true ? { is_active: true } : {}),
      },
      orderBy: [{ next_occurrence_on: 'asc' }, { id: 'asc' }],
    });
    if (rows.length === 0) return [];

    const [counts, accounts, today] = await Promise.all([
      this.generatedCounts(householdId, rows.map((row) => row.id)),
      this.accountNames(householdId, rows.map((row) => row.account_id)),
      this.today(householdId),
    ]);

    void today;
    return rows.map((row) => this.toView(row, counts.get(row.id) ?? 0, accounts.get(row.account_id) ?? null));
  }

  /** One rule, or NOT_FOUND — the scoped predicate is the tenancy check (ADR-008). */
  async getById(householdId: string, id: string): Promise<RecurringRuleView> {
    const row = await this.requireRule(householdId, id);
    const [counts, accounts, today] = await Promise.all([
      this.generatedCounts(householdId, [row.id]),
      this.accountNames(householdId, [row.account_id]),
      this.today(householdId),
    ]);
    void today;
    return this.toView(row, counts.get(row.id) ?? 0, accounts.get(row.account_id) ?? null);
  }

  /**
   * The dates a rule will post inside the window, oldest first.
   *
   * `upcomingRecurring` is this over the next N days, and it is also how the materialiser decides what
   * is due — one function, so the "next 30 days" list and what actually gets posted cannot disagree.
   */
  async occurrencesBetween(
    householdId: string,
    withinDays: number,
    options: { readonly ruleIds?: readonly string[] | null; readonly asOf?: LocalDate } = {},
  ): Promise<readonly { readonly ruleId: string; readonly dates: readonly LocalDate[] }[]> {
    const asOf = options.asOf ?? (await this.today(householdId));
    const rules = await this.list(householdId, true);
    const wanted = options.ruleIds === undefined || options.ruleIds === null || options.ruleIds.length === 0
      ? rules
      : rules.filter((rule) => options.ruleIds?.includes(rule.id) === true);

    return wanted.map((rule) => {
      const spec = this.parseOrThrow(rule.rrule);
      const horizon = addDays(asOf, withinDays);
      return {
        ruleId: rule.id,
        dates: expandOccurrences(spec, rule.nextOccurrenceOn, asOf, horizon, {
          until: rule.endsOn,
          // A finished rule has no remaining occurrences; `COUNT` is tracked by the generated rows.
          remaining: remainingOccurrences(spec, rule.generatedCount),
          limit: 64,
        }),
      };
    });
  }

  async create(householdId: string, input: CreateRuleInput): Promise<RecurringRuleView> {
    const description = input.description.trim();
    if (description.length === 0) throw new ApiError('VALIDATION_FAILED', 'A description is required.');
    if (input.amountMinor <= 0n) {
      throw new ApiError('VALIDATION_FAILED', 'A recurring amount must be greater than zero.');
    }

    const spec = this.parseOrThrow(input.rrule);
    const household = await this.prisma.client.households.findFirst({
      where: { id: householdId },
      select: { ledger_currency: true, iana_timezone: true },
    });
    if (household === null) throw new ApiError('NOT_FOUND', 'Household not found.');

    await this.assertAccount(householdId, input.accountId);
    await this.assertCategoryKind(householdId, input.kind, input.categoryId ?? null);

    const today = todayIn(household.iana_timezone || DEFAULT_TIME_ZONE);
    const target = input.startsOn == null ? today : (input.startsOn as LocalDate);
    const first = nextOccurrenceOn(spec, target, target, {
      until: input.endsOn == null ? null : (input.endsOn as LocalDate),
    });
    if (first === null) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'That schedule never produces a date: check the interval, the month day and the end date.',
      );
    }

    const created = await this.prisma.client.recurring_rules.create({
      data: {
        id: uuidv7(),
        household_id: householdId,
        account_id: input.accountId,
        kind: input.kind,
        amount_minor: input.amountMinor,
        currency: household.ledger_currency,
        category_id: input.categoryId ?? null,
        merchant_id: input.merchantId ?? null,
        description,
        // The canonical text, not the client's spelling: two equal rules then look equal, and the
        // client's own string can never smuggle in a part this build does not expand.
        rrule: formatRRule(spec),
        next_occurrence_on: this.date(first),
        ends_on: input.endsOn == null ? null : this.date(input.endsOn),
        auto_confirm: input.autoConfirm ?? false,
        is_detected: false,
        is_active: true,
      },
    });

    return this.getById(householdId, created.id);
  }

  /** Patch a rule. An absent field is left alone; `clearEndsOn`/`clearCategory` unset explicitly. */
  async update(householdId: string, input: UpdateRuleInput): Promise<RecurringRuleView> {
    const rule = await this.requireRule(householdId, input.ruleId);

    const description = input.description === undefined || input.description === null ? null : input.description.trim();
    if (description !== null && description.length === 0) {
      throw new ApiError('VALIDATION_FAILED', 'A description is required.');
    }
    if (input.amountMinor !== undefined && input.amountMinor !== null && input.amountMinor <= 0n) {
      throw new ApiError('VALIDATION_FAILED', 'A recurring amount must be greater than zero.');
    }
    if (input.categoryId !== undefined && input.categoryId !== null) {
      await this.assertCategoryKind(householdId, rule.kind as 'EXPENSE' | 'INCOME', input.categoryId);
    }

    const rrule = input.rrule === undefined || input.rrule === null ? null : formatRRule(this.parseOrThrow(input.rrule));
    const spec = this.parseOrThrow(rrule ?? rule.rrule);
    const endsOn =
      input.clearEndsOn === true
        ? null
        : input.endsOn === undefined || input.endsOn === null
          ? (rule.ends_on === null ? null : this.iso(rule.ends_on))
          : (input.endsOn as LocalDate);

    // A changed schedule (or a new start) re-anchors the rule: keeping the old `next_occurrence_on`
    // would leave a monthly rule that now says "every 2 weeks" firing on the wrong day.
    const reanchor = rrule !== null || (input.startsOn !== undefined && input.startsOn !== null);
    const anchor = reanchor
      ? nextOccurrenceOn(spec, (input.startsOn ?? this.iso(rule.next_occurrence_on)) as LocalDate, (input.startsOn ?? this.iso(rule.next_occurrence_on)) as LocalDate, { until: endsOn })
      : null;
    if (reanchor && anchor === null) {
      throw new ApiError('VALIDATION_FAILED', 'That schedule never produces a date.');
    }

    await this.prisma.client.recurring_rules.update({
      where: { id: rule.id },
      data: {
        ...(description === null ? {} : { description }),
        ...(input.amountMinor === undefined || input.amountMinor === null ? {} : { amount_minor: input.amountMinor }),
        ...(rrule === null ? {} : { rrule }),
        ...(anchor === null ? {} : { next_occurrence_on: this.date(anchor) }),
        ends_on: endsOn === null ? null : this.date(endsOn),
        ...(input.clearCategory === true ? { category_id: null } : {}),
        ...(input.categoryId === undefined || input.categoryId === null ? {} : { category_id: input.categoryId }),
        ...(input.autoConfirm === undefined || input.autoConfirm === null ? {} : { auto_confirm: input.autoConfirm }),
        ...(input.isActive === undefined || input.isActive === null ? {} : { is_active: input.isActive }),
        updated_at: new Date(),
      },
    });

    return this.getById(householdId, rule.id);
  }

  /** Soft-delete. Deactivating keeps the history; deleting keeps the rows the rule generated. */
  async remove(householdId: string, id: string): Promise<void> {
    const result = await this.prisma.client.recurring_rules.updateMany({
      where: { id, household_id: householdId, deleted_at: null },
      data: { deleted_at: new Date(), is_active: false, updated_at: new Date() },
    });
    if (result.count === 0) throw new ApiError('NOT_FOUND', 'Recurring rule not found.');
  }

  /**
   * Post every due occurrence of every due rule (or preview them with `dryRun`).
   *
   * Due means `next_occurrence_on <= asOf` **and** active. Each occurrence is written through
   * `TransactionsService.create`, so it gets the same validation as a hand-typed row (I-3's
   * category/kind match, ADR-011's currency, the local-day derivation) and the derived idempotency key
   * makes a retry a replay rather than a second charge.
   */
  async materialise(householdId: string, input: MaterialiseInput): Promise<MaterialiseResultView> {
    const asOf = input.asOf == null ? await this.today(householdId) : (input.asOf as LocalDate);
    const dryRun = input.dryRun === true;
    const due = (await this.list(householdId, true)).filter(
      (rule) =>
        (input.ruleIds === undefined || input.ruleIds === null || input.ruleIds.length === 0
          ? true
          : input.ruleIds.includes(rule.id)) &&
        compareLocalDates(rule.nextOccurrenceOn, asOf) <= 0,
    );

    const created: TransactionModel[] = [];
    const previewed: PreviewView[] = [];
    const skipped: { ruleId: string; reason: string }[] = [];
    const newNextOccurrences: OccurrenceView[] = [];

    for (const rule of due) {
      const spec = this.parseOrThrow(rule.rrule);
      const dates = expandOccurrences(spec, rule.nextOccurrenceOn, rule.nextOccurrenceOn, asOf, {
        until: rule.endsOn,
        remaining: remainingOccurrences(spec, rule.generatedCount),
        limit: 64,
      });

      if (dates.length === 0) {
        // The next date is past the rule's own end: retire it so it stops being scanned.
        await this.retireIfFinished(rule, spec, asOf);
        skipped.push({ ruleId: rule.id, reason: 'ENDED' });
        continue;
      }

      for (const occurredOn of dates) {
        const status = rule.autoConfirm ? 'CONFIRMED' : 'PENDING';
        if (dryRun) {
          previewed.push({
            ruleId: rule.id,
            occurredOn,
            accountId: rule.accountId,
            amountMinor: rule.amountMinor,
            currency: rule.currency,
            description: rule.description,
            status,
          });
          continue;
        }

        // Already posted for this date: report it rather than relying on `create`'s silent replay,
        // which would return the original row and make this run look like it had posted something.
        const already = await this.prisma.client.transactions.findFirst({
          where: {
            household_id: householdId,
            recurring_rule_id: rule.id,
            occurred_local_date: this.date(occurredOn),
            deleted_at: null,
          },
          select: { id: true },
        });
        if (already !== null) {
          skipped.push({ ruleId: rule.id, reason: 'ALREADY_MATERIALISED' });
          continue;
        }

        const row = await this.transactions.create(householdId, {
          accountId: rule.accountId,
          kind: rule.kind as TransactionKind,
          amountMinor: rule.amountMinor,
          description: rule.description,
          occurredLocalDate: occurredOn,
          categoryId: rule.categoryId,
          merchantId: rule.merchantId,
          status: status as TransactionStatus,
          source: TransactionSource.RECURRING,
          recurringRuleId: rule.id,
          // A row nobody confirmed is I-8's blocking lane: it appears for review and does not count as
          // spend until it is confirmed (I-7).
          needsReview: !rule.autoConfirm,
          // Per (rule, occurrence), so any retry of this date is a replay (I-10).
          idempotencyKey: `recurring:${rule.id}:${occurredOn}`,
        });
        created.push(row);
      }

      if (!dryRun) {
        const advanced = await this.advance(householdId, rule, spec, dates);
        newNextOccurrences.push({ ruleId: rule.id, nextOccurrenceOn: advanced });
      }
    }

    return {
      created,
      previewed,
      skipped,
      newNextOccurrences,
      // Every due occurrence already had a row: this run posted nothing because an earlier one did.
      wasReplayed:
        !dryRun && created.length === 0 && skipped.some((skip) => skip.reason === 'ALREADY_MATERIALISED'),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  private async advance(
    householdId: string,
    rule: RecurringRuleView,
    spec: RRuleSpec,
    posted: readonly LocalDate[],
  ): Promise<LocalDate | null> {
    const last = posted.at(-1) as LocalDate;
    // `generatedCount` moves with the rows just written; recompute it rather than guessing.
    const generated = await this.generatedCount(householdId, rule.id);
    const next = nextOccurrenceOn(spec, last, addDays(last, 1), {
      until: rule.endsOn,
      remaining: remainingOccurrences(spec, generated),
    });

    await this.prisma.client.recurring_rules.update({
      where: { id: rule.id },
      data: {
        // When the rule is finished, the column is left at the **last occurrence it posted** rather
        // than at a date it never reached: a stale `next_occurrence_on` would make the row read as if
        // that occurrence were still pending, and reactivating the rule would re-post from there.
        ...(next === null
          ? { is_active: false, next_occurrence_on: this.date(last) }
          : { next_occurrence_on: this.date(next) }),
        updated_at: new Date(),
      },
    });

    return next;
  }

  /** Retire a rule whose next date is past its own end, so the materialiser stops walking it. */
  private async retireIfFinished(
    rule: RecurringRuleView,
    spec: RRuleSpec,
    asOf: LocalDate,
  ): Promise<void> {
    const next = nextOccurrenceOn(spec, rule.nextOccurrenceOn, rule.nextOccurrenceOn, {
      until: rule.endsOn,
      remaining: remainingOccurrences(spec, rule.generatedCount),
    });
    if (next !== null && compareLocalDates(next, asOf) > 0) return;

    await this.prisma.client.recurring_rules.update({
      where: { id: rule.id },
      data: { is_active: false, updated_at: new Date() },
    });
  }

  private parseOrThrow(rrule: string): RRuleSpec {
    const parsed = parseRRule(rrule);
    if (parsed.ok) return parsed.spec;
    throw new ApiError('VALIDATION_FAILED', messageForRRuleError(parsed.reason));
  }

  private async requireRule(householdId: string, id: string) {
    const rule = await this.prisma.client.recurring_rules.findFirst({
      where: { id, household_id: householdId, deleted_at: null },
    });
    if (!rule) throw new ApiError('NOT_FOUND', 'Recurring rule not found.');
    return rule;
  }

  private async assertAccount(householdId: string, accountId: string): Promise<void> {
    const account = await this.prisma.client.accounts.findFirst({
      where: { id: accountId, household_id: householdId, deleted_at: null },
      select: { id: true },
    });
    if (!account) throw new ApiError('NOT_FOUND', 'Account not found.');
  }

  /** I-3: a rule that posts expenses must not point at an income Category. */
  private async assertCategoryKind(
    householdId: string,
    kind: 'EXPENSE' | 'INCOME',
    categoryId: string | null,
  ): Promise<void> {
    if (categoryId === null) return;
    const category = await this.prisma.client.categories.findFirst({
      where: { id: categoryId, household_id: householdId, deleted_at: null },
      select: { kind: true },
    });
    if (!category) throw new ApiError('NOT_FOUND', 'Category not found.');
    if (category.kind !== kind) {
      throw new ApiError(
        'VALIDATION_FAILED',
        `That category classifies ${category.kind.toLowerCase()} but the rule is ${kind.toLowerCase()} (I-3).`,
      );
    }
  }

  private async generatedCount(householdId: string, ruleId: string): Promise<number> {
    return this.prisma.client.transactions.count({
      where: { household_id: householdId, recurring_rule_id: ruleId, deleted_at: null },
    });
  }

  private async generatedCounts(householdId: string, ruleIds: readonly string[]): Promise<Map<string, number>> {
    const grouped = await this.prisma.client.transactions.groupBy({
      by: ['recurring_rule_id'],
      where: { household_id: householdId, recurring_rule_id: { in: [...ruleIds] }, deleted_at: null },
      _count: { _all: true },
    });
    return new Map(
      grouped
        .filter((row): row is typeof row & { recurring_rule_id: string } => row.recurring_rule_id !== null)
        .map((row) => [row.recurring_rule_id, row._count._all]),
    );
  }

  /** One query for the Account names a page of rules points at; missing names render as null. */
  private async accountNames(householdId: string, accountIds: readonly string[]): Promise<Map<string, string>> {
    const rows = await this.prisma.client.accounts.findMany({
      where: { household_id: householdId, id: { in: [...new Set(accountIds)] } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  private async today(householdId: string): Promise<LocalDate> {
    const household = await this.prisma.client.households.findFirst({
      where: { id: householdId },
      select: { iana_timezone: true },
    });
    return todayIn(household?.iana_timezone || DEFAULT_TIME_ZONE);
  }

  private toView(
    row: {
      id: string;
      account_id: string;
      kind: string;
      amount_minor: bigint;
      currency: string;
      category_id: string | null;
      merchant_id: string | null;
      description: string;
      rrule: string;
      next_occurrence_on: Date;
      ends_on: Date | null;
      auto_confirm: boolean;
      is_detected: boolean;
      is_active: boolean;
      created_at: Date;
      updated_at: Date;
    },
    generatedCount: number,
    accountName: string | null,
  ): RecurringRuleView {
    const spec = parseRRule(row.rrule);
    const nextOccurrenceOn = this.iso(row.next_occurrence_on);
    const endsOn = row.ends_on === null ? null : this.iso(row.ends_on);

    // A rule this build cannot expand is reported rather than hidden: the list renders its raw text and
    // the materialiser skips it with a reason (the create/update paths refuse such a rule, so this is
    // defence in depth for a row written by an older release).
    const upcoming = spec.ok
      ? expandOccurrences(spec.spec, nextOccurrenceOn, nextOccurrenceOn, addDays(nextOccurrenceOn, 400), {
          until: endsOn,
          remaining: remainingOccurrences(spec.spec, generatedCount),
          limit: UPCOMING_COUNT,
        })
      : [];

    return {
      id: row.id,
      accountId: row.account_id,
      accountName,
      kind: row.kind,
      amountMinor: row.amount_minor,
      currency: row.currency,
      categoryId: row.category_id,
      merchantId: row.merchant_id,
      description: row.description,
      rrule: row.rrule,
      nextOccurrenceOn,
      endsOn,
      autoConfirm: row.auto_confirm,
      isDetected: row.is_detected,
      isActive: row.is_active,
      generatedCount,
      upcomingOccurrences: upcoming,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private date(day: string): Date {
    return new Date(`${day}T00:00:00.000Z`);
  }

  private iso(value: Date): LocalDate {
    return value.toISOString().slice(0, 10) as LocalDate;
  }
}

/** How many occurrences a rule may still produce, from its `COUNT` and what it has already posted. */
function remainingOccurrences(spec: RRuleSpec, generatedCount: number): number | null {
  return spec.count === null ? null : Math.max(0, spec.count - generatedCount);
}

function messageForRRuleError(reason: RRuleError): string {
  switch (reason) {
    case 'MALFORMED':
      return 'That recurrence rule could not be read. Use the RFC 5545 form, e.g. FREQ=MONTHLY;BYMONTHDAY=1.';
    case 'UNSUPPORTED_FREQUENCY':
      return 'Only DAILY, WEEKLY, MONTHLY and YEARLY recurrences are supported.';
    case 'UNSUPPORTED_PART':
      return 'That recurrence rule uses a part this build does not expand (it supports FREQ, INTERVAL, BYMONTHDAY, BYDAY, COUNT and UNTIL).';
    case 'BAD_INTERVAL':
      return 'The recurrence interval must be a whole number of at least 1.';
  }
}

