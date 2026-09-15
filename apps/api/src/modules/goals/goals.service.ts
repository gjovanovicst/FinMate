import { Injectable } from '@nestjs/common';

import {
  DEFAULT_TIME_ZONE,
  goalProgress,
  reconcileGoalStatus,
  todayIn,
  uuidv7,
  type GoalStatus,
  type LocalDate,
} from '@finmate/domain';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import { ledgerCurrencyOf } from '../../common/households/ledger-currency';
import { PrismaService } from '../../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import type { Account } from '../accounts/account.model';

/**
 * Saving goals — F-18, docs/06 §4/§5.7, docs/02 §4.13, docs/03 §6.
 *
 * ## What this service owns, and what it does not
 *
 * It owns the **write** and the composition of a goal: the target, the deadline, the Account it is set
 * aside in, and the contributions. It owns no arithmetic — `goalProgress` and `reconcileGoalStatus`
 * are pure functions in `@finmate/domain`, tested there, because "required per month" is the figure a
 * user plans their life around and it must not be possible for two callers to compute it differently.
 *
 * ## A contribution is not a Transaction
 *
 * `goal_contributions` is the only input to progress (docs/02 §4.13). Nothing here writes a
 * Transaction or reads the ledger, so a contribution cannot be counted twice — once as spending and
 * once as savings. `ContributeToGoalInput.createTransaction` from docs/06 §5.7 is therefore **not
 * implemented**: recording the outflow is an Account-to-Account transfer (which the ledger supports
 * through `transfer_peer_id` and no feature builds yet), and a naive `EXPENSE` row would invent
 * spending for money that was not spent. Recorded in docs/06 §5.7.
 *
 * ## Idempotency
 *
 * A contribution is money, so `idempotencyKey` is required and the lookup mirrors `createTransaction`
 * (I-10): a known key short-circuits before the insert, and the partial unique index is the real guard
 * — a concurrent double-submit is caught as a `P2002` and re-read as the original contribution.
 *
 * @module apps/api/src/modules/goals
 */

export interface ContributionView {
  readonly id: string;
  readonly goalId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly contributedOn: LocalDate;
  readonly note: string | null;
  readonly createdAt: Date;
}

export interface GoalView {
  readonly id: string;
  readonly name: string;
  readonly targetMinor: bigint;
  readonly currency: string;
  readonly targetDate: LocalDate | null;
  readonly accountId: string | null;
  readonly account: Account | null;
  readonly status: GoalStatus;
  readonly contributedMinor: bigint;
  readonly remainingMinor: bigint;
  readonly progress: number;
  readonly requiredPerMonthMinor: bigint | null;
  readonly monthsRemaining: number | null;
  readonly contributions: readonly ContributionView[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateGoalInput {
  readonly name: string;
  readonly targetMinor: bigint;
  readonly targetDate?: string | null;
  readonly accountId?: string | null;
}

export interface UpdateGoalInput {
  readonly goalId: string;
  readonly name?: string | null;
  readonly targetMinor?: bigint | null;
  readonly targetDate?: string | null;
  readonly clearTargetDate?: boolean | null;
  readonly accountId?: string | null;
  readonly clearAccount?: boolean | null;
  readonly status?: GoalStatus | null;
}

export interface ContributeInput {
  readonly goalId: string;
  readonly amountMinor: bigint;
  readonly contributedOn?: string | null;
  readonly note?: string | null;
  readonly idempotencyKey: string;
}

/** How many Accounts a goals query will resolve names for. A Household has a handful. */
const ACCOUNT_PAGE = 200;

@Injectable()
export class GoalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
  ) {}

  /** Every goal of the Household, optional status filter, active first then oldest first. */
  async list(householdId: string, statuses?: readonly GoalStatus[] | null): Promise<readonly GoalView[]> {
    const goals = await this.prisma.client.saving_goals.findMany({
      where: {
        household_id: householdId,
        deleted_at: null,
        // A nullable list argument arrives as `null`, not `undefined` (docs/15), and an explicit
        // empty list means "no filter" rather than "no goals".
        ...(statuses === undefined || statuses === null || statuses.length === 0
          ? {}
          : { status: { in: [...statuses] } }),
      },
      orderBy: { id: 'asc' },
    });

    if (goals.length === 0) return [];

    const contributions = await this.prisma.client.goal_contributions.findMany({
      where: { household_id: householdId, goal_id: { in: goals.map((goal) => goal.id) } },
      orderBy: [{ contributed_on: 'desc' }, { id: 'desc' }],
    });

    const accounts = await this.accountViews(householdId, goals.map((goal) => goal.account_id));
    const today = await this.today(householdId);

    return goals.map((goal) =>
      this.toView(
        goal,
        contributions.filter((contribution) => contribution.goal_id === goal.id),
        accounts,
        today,
      ),
    );
  }

  /** One goal, or NOT_FOUND — the scoped predicate is the tenancy check (ADR-008). */
  async getById(householdId: string, id: string): Promise<GoalView> {
    const goal = await this.requireGoal(householdId, id);
    const contributions = await this.prisma.client.goal_contributions.findMany({
      where: { household_id: householdId, goal_id: goal.id },
      orderBy: [{ contributed_on: 'desc' }, { id: 'desc' }],
    });
    const accounts = await this.accountViews(householdId, [goal.account_id]);
    return this.toView(goal, contributions, accounts, await this.today(householdId));
  }

  async create(householdId: string, input: CreateGoalInput): Promise<GoalView> {
    const name = input.name.trim();
    if (name.length === 0) throw new ApiError('VALIDATION_FAILED', 'A goal needs a name.');
    if (input.targetMinor <= 0n) {
      throw new ApiError('VALIDATION_FAILED', 'A goal target must be greater than zero.');
    }

    const currency = await ledgerCurrencyOf(this.prisma, householdId);
    await this.assertAccountIsVisible(householdId, input.accountId ?? null);

    const created = await this.prisma.client.saving_goals.create({
      data: {
        id: uuidv7(),
        household_id: householdId,
        name,
        target_minor: input.targetMinor,
        currency,
        target_date: input.targetDate == null ? null : this.date(input.targetDate),
        account_id: input.accountId ?? null,
        status: 'ACTIVE',
      },
    });

    return this.getById(householdId, created.id);
  }

  /**
   * Patch a goal. Every field is optional and an **absent** field is left alone, which is why removing
   * a target date or an Account needs its own flag (`clearTargetDate` / `clearAccount`) rather than
   * being expressed as "null means clear" — the same absent-vs-null distinction docs/06 §5.6 uses for
   * a Budget's Category, and for the same reason: a client that omits a field is not asking to unset it.
   */
  async update(householdId: string, input: UpdateGoalInput): Promise<GoalView> {
    const goal = await this.requireGoal(householdId, input.goalId);

    const name = input.name === undefined || input.name === null ? null : input.name.trim();
    if (name !== null && name.length === 0) throw new ApiError('VALIDATION_FAILED', 'A goal needs a name.');
    if (input.targetMinor !== undefined && input.targetMinor !== null && input.targetMinor <= 0n) {
      throw new ApiError('VALIDATION_FAILED', 'A goal target must be greater than zero.');
    }
    if (input.accountId !== undefined && input.accountId !== null) {
      await this.assertAccountIsVisible(householdId, input.accountId);
    }

    const targetDate =
      input.clearTargetDate === true
        ? null
        : input.targetDate === undefined || input.targetDate === null
          ? goal.target_date
          : this.date(input.targetDate);
    const accountId =
      input.clearAccount === true
        ? null
        : input.accountId === undefined || input.accountId === null
          ? goal.account_id
          : input.accountId;
    const targetMinor = input.targetMinor ?? goal.target_minor;

    // `ACHIEVED` is recomputed here too: raising the target above what has been saved un-achieves the
    // goal, and lowering it achieves it. A status the user chose is what `reconcileGoalStatus` protects.
    const status = reconcileGoalStatus(
      (input.status ?? goal.status) as GoalStatus,
      await this.contributedMinor(householdId, goal.id),
      targetMinor,
    );

    await this.prisma.client.saving_goals.update({
      where: { id: goal.id },
      data: {
        ...(name === null ? {} : { name }),
        target_minor: targetMinor,
        target_date: targetDate,
        account_id: accountId,
        status,
        updated_at: new Date(),
      },
    });

    return this.getById(householdId, goal.id);
  }

  /**
   * Soft-delete a goal (docs/03 §4 keeps financial rows). Its contributions stay attached and are
   * simply no longer reachable, which is what makes an accidental delete recoverable in Phase 5's
   * audit view rather than a silent loss of the contributed total.
   */
  async remove(householdId: string, id: string): Promise<void> {
    const result = await this.prisma.client.saving_goals.updateMany({
      where: { id, household_id: householdId, deleted_at: null },
      data: { deleted_at: new Date(), updated_at: new Date() },
    });
    if (result.count === 0) throw new ApiError('NOT_FOUND', 'Goal not found.');
  }

  /**
   * Put money aside. Idempotent on `idempotencyKey` (I-10).
   *
   * The goal's status is reconciled in the same request, so the response the client renders — and the
   * `ACHIEVED` badge it draws — never depends on a later read.
   */
  async contribute(
    householdId: string,
    input: ContributeInput,
  ): Promise<{ goal: GoalView; contribution: ContributionView; wasReplayed: boolean }> {
    const key = input.idempotencyKey.trim();
    if (key.length === 0) {
      throw new ApiError('VALIDATION_FAILED', 'idempotencyKey is required (invariant I-10).');
    }
    if (input.amountMinor <= 0n) {
      throw new ApiError('VALIDATION_FAILED', 'A contribution must be greater than zero.');
    }

    const goal = await this.requireGoal(householdId, input.goalId);
    if (goal.status === 'ARCHIVED') {
      throw new ApiError(
        'VALIDATION_FAILED',
        'This goal is archived. Restore it before adding a contribution.',
      );
    }

    // The replay short-circuit: an identical retry returns the original row instead of saving twice.
    const existing = await this.prisma.client.goal_contributions.findFirst({
      where: { household_id: householdId, idempotency_key: key },
    });
    if (existing) {
      return {
        goal: await this.getById(householdId, goal.id),
        contribution: this.toContributionView(existing, goal.currency),
        wasReplayed: true,
      };
    }

    const contributedOn =
      input.contributedOn == null ? await this.today(householdId) : (input.contributedOn as LocalDate);

    let created;
    try {
      created = await this.prisma.client.goal_contributions.create({
        data: {
          id: uuidv7(),
          household_id: householdId,
          goal_id: goal.id,
          amount_minor: input.amountMinor,
          contributed_on: this.date(contributedOn),
          note: input.note ?? null,
          idempotency_key: key,
        },
      });
    } catch (error) {
      // The partial unique index, not the lookup above, is what makes this safe under a concurrent
      // double-submit: the loser reads back the winner's row and reports a replay.
      if (this.isUniqueViolation(error)) {
        const winner = await this.prisma.client.goal_contributions.findFirst({
          where: { household_id: householdId, idempotency_key: key },
        });
        if (winner) {
          return {
            goal: await this.getById(householdId, goal.id),
            contribution: this.toContributionView(winner, goal.currency),
            wasReplayed: true,
          };
        }
      }
      throw error;
    }

    await this.reconcileStatus(householdId, goal.id);

    return {
      goal: await this.getById(householdId, goal.id),
      contribution: this.toContributionView(created, goal.currency),
      wasReplayed: false,
    };
  }

  /**
   * Remove a contribution and put the goal's derived status back where it belongs.
   *
   * This is the case that makes derived status worth recomputing rather than latching: deleting the
   * contribution that crossed the target must not leave a goal reading "achieved" with 0 % saved.
   */
  async removeContribution(householdId: string, id: string): Promise<GoalView> {
    const contribution = await this.prisma.client.goal_contributions.findFirst({
      where: { id, household_id: householdId },
    });
    if (!contribution) throw new ApiError('NOT_FOUND', 'Contribution not found.');

    await this.prisma.client.goal_contributions.deleteMany({
      where: { id, household_id: householdId },
    });
    await this.reconcileStatus(householdId, contribution.goal_id);

    return this.getById(householdId, contribution.goal_id);
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  /** `findFirst`, never `findUnique`: the tenancy guard refuses the latter on scoped models. */
  private async requireGoal(householdId: string, id: string) {
    const goal = await this.prisma.client.saving_goals.findFirst({
      where: { id, household_id: householdId, deleted_at: null },
    });
    if (!goal) throw new ApiError('NOT_FOUND', 'Goal not found.');
    return goal;
  }

  private async contributedMinor(householdId: string, goalId: string): Promise<bigint> {
    const result = await this.prisma.client.goal_contributions.aggregate({
      where: { household_id: householdId, goal_id: goalId },
      _sum: { amount_minor: true },
    });
    return result._sum.amount_minor ?? 0n;
  }

  /** Write back the status the contributions imply, when it changed. */
  private async reconcileStatus(householdId: string, goalId: string): Promise<void> {
    const goal = await this.requireGoal(householdId, goalId);
    const status = reconcileGoalStatus(
      goal.status as GoalStatus,
      await this.contributedMinor(householdId, goalId),
      goal.target_minor,
    );
    if (status === goal.status) return;

    await this.prisma.client.saving_goals.update({
      where: { id: goalId },
      data: { status, updated_at: new Date() },
    });
  }

  private async assertAccountIsVisible(householdId: string, accountId: string | null): Promise<void> {
    if (accountId === null) return;
    const account = await this.prisma.client.accounts.findFirst({
      where: { id: accountId, household_id: householdId, deleted_at: null },
      select: { id: true },
    });
    if (!account) throw new ApiError('NOT_FOUND', 'Account not found.');
  }

  /**
   * The `Account` views a page of goals points at.
   *
   * Through `AccountsService`, so the balance is the same derived figure the Accounts screen shows
   * (I-4). A soft-deleted or archived Account simply resolves to `null` while the goal keeps its
   * `accountId`: the link is not broken, the name is just not available.
   */
  private async accountViews(
    householdId: string,
    accountIds: readonly (string | null)[],
  ): Promise<ReadonlyMap<string, Account>> {
    const wanted = new Set(accountIds.filter((id): id is string => id !== null));
    if (wanted.size === 0) return new Map();

    const page = await this.accounts.list({ householdId, first: ACCOUNT_PAGE });
    return new Map(page.items.filter((account) => wanted.has(account.id)).map((account) => [account.id, account]));
  }

  private async today(householdId: string): Promise<LocalDate> {
    const household = await this.prisma.client.households.findFirst({
      where: { id: householdId },
      select: { iana_timezone: true },
    });
    return todayIn(household?.iana_timezone || DEFAULT_TIME_ZONE);
  }

  private toView(
    goal: {
      id: string;
      name: string;
      target_minor: bigint;
      currency: string;
      target_date: Date | null;
      account_id: string | null;
      status: string;
      created_at: Date;
      updated_at: Date;
    },
    contributions: readonly {
      id: string;
      goal_id: string;
      amount_minor: bigint;
      contributed_on: Date;
      note: string | null;
      created_at: Date;
    }[],
    accounts: ReadonlyMap<string, Account>,
    today: LocalDate,
  ): GoalView {
    const contributedMinor = contributions.reduce((sum, row) => sum + row.amount_minor, 0n);
    const progress = goalProgress({
      targetMinor: goal.target_minor,
      contributedMinor,
      targetDate: goal.target_date === null ? null : this.iso(goal.target_date),
      today,
    });

    return {
      id: goal.id,
      name: goal.name,
      targetMinor: goal.target_minor,
      currency: goal.currency,
      targetDate: goal.target_date === null ? null : this.iso(goal.target_date),
      accountId: goal.account_id,
      account: goal.account_id === null ? null : (accounts.get(goal.account_id) ?? null),
      status: goal.status as GoalStatus,
      contributedMinor,
      remainingMinor: progress.remainingMinor,
      progress: progress.progress,
      requiredPerMonthMinor: progress.requiredPerMonthMinor,
      monthsRemaining: progress.monthsRemaining,
      contributions: contributions.map((row) => this.toContributionView(row, goal.currency)),
      createdAt: goal.created_at,
      updatedAt: goal.updated_at,
    };
  }

  /**
   * A contribution has no currency column of its own: its money is denominated in the goal's own
   * ledger currency (the column would only be able to disagree with it). It is passed in rather than
   * defaulted, so a caller cannot render an amount without one.
   */
  private toContributionView(
    row: {
      id: string;
      goal_id: string;
      amount_minor: bigint;
      contributed_on: Date;
      note: string | null;
      created_at: Date;
    },
    currency: string,
  ): ContributionView {
    return {
      id: row.id,
      goalId: row.goal_id,
      amountMinor: row.amount_minor,
      currency,
      contributedOn: this.iso(row.contributed_on),
      note: row.note,
      createdAt: row.created_at,
    };
  }

  private date(day: string): Date {
    return new Date(`${day}T00:00:00.000Z`);
  }

  private iso(value: Date): LocalDate {
    return value.toISOString().slice(0, 10) as LocalDate;
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'P2002'
    );
  }
}
