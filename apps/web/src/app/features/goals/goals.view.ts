import { parseAmount, type CurrencyCode } from '@finmate/domain';

import type { TranslationKey } from '../../core/i18n/translations';
import type { MoneyWire } from '../../shared/ui/money/money.component';

/**
 * The goals screen's decisions, as pure functions — F-18, docs/02 §4.13, docs/06 §5.7.
 *
 * What lives here is the part that is **wrong silently**:
 *
 *  - **the write plan.** A target is typed as prose and has to become `Money` exactly once, through
 *    the same `parseAmount` the capture path uses — a second reader of "120.000" is a second answer to
 *    what the user meant. A goal with an unreadable or zero target must be refused *before* the
 *    mutation, because the API's `target_minor > 0` CHECK is the last line of defence, not the first.
 *  - **the order of the list.** Active goals first, soonest deadline first, then the ones with no
 *    deadline, then the achieved ones, then the archived — a card list that reshuffles is one nobody
 *    can scan, and the wireframe's whole point is "what do I put money into next".
 *  - **the rate.** `requiredPerMonth` is the backend's and is **never editable** (docs/02 §4.13); the
 *    screen's only job is to render it, or to nudge for a target date when there is none.
 *  - **an idempotency key per submission**, minted once (I-10) — the client half of the guarantee the
 *    API enforces, so a double-tap on *Dodaj uplatu* cannot save the money twice.
 *
 * Nothing here computes money: `progress` and `requiredPerMonth` arrive as `Money`/`Float` and are
 * only rounded for display.
 *
 * @module apps/web/src/app/features/goals
 */

export type GoalStatus = 'ACTIVE' | 'ACHIEVED' | 'ARCHIVED';

export const GOAL_STATUSES: readonly GoalStatus[] = ['ACTIVE', 'ACHIEVED', 'ARCHIVED'];

export interface GoalContribution {
  readonly id: string;
  readonly goalId: string;
  readonly amount: MoneyWire;
  readonly contributedOn: string;
  readonly note: string | null;
}

export interface GoalAccount {
  readonly id: string;
  readonly name: string;
}

export interface Goal {
  readonly id: string;
  readonly name: string;
  readonly target: MoneyWire;
  readonly targetDate: string | null;
  readonly accountId: string | null;
  readonly account: GoalAccount | null;
  readonly status: GoalStatus;
  readonly contributed: MoneyWire;
  readonly remaining: MoneyWire;
  readonly progress: number;
  readonly requiredPerMonth: MoneyWire | null;
  readonly monthsRemaining: number | null;
  readonly contributions: readonly GoalContribution[];
}

/** The create form, as typed. */
export interface GoalDraft {
  readonly name: string;
  readonly target: string;
  readonly targetDate: string;
  readonly accountId: string;
}

export const EMPTY_DRAFT: GoalDraft = { name: '', target: '', targetDate: '', accountId: '' };

/** Which field is wrong, or `null` when the draft can be written. */
export type DraftProblem = 'NAME' | 'TARGET' | 'TARGET_DATE' | null;

/** A typed amount as minor units, read once through the domain parser, or `null`. */
export function amountMinor(text: string, currency: CurrencyCode): bigint | null {
  const parsed = parseAmount(text, currency);
  if (!parsed.money || parsed.money.amountMinor <= 0n) return null;
  return parsed.money.amountMinor;
}

/**
 * The catalogue key for a problem, as a `Record` so a new problem cannot be added without wording
 * (a `switch` with a `default` would silently render the wrong sentence).
 */
export function problemKey(problem: Exclude<DraftProblem, null>): TranslationKey {
  const keys: Record<Exclude<DraftProblem, null>, TranslationKey> = {
    NAME: 'goals.problem.NAME',
    TARGET: 'goals.problem.TARGET',
    TARGET_DATE: 'goals.problem.TARGET_DATE',
  };
  return keys[problem];
}

export interface GoalWriteInput {
  readonly name: string;
  readonly targetMinor: bigint;
  readonly targetDate: string | null;
  readonly accountId: string | null;
}

/** `YYYY-MM-DD`, the only shape `LocalDate` accepts. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function draftProblem(draft: GoalDraft, currency: CurrencyCode): DraftProblem {
  if (draft.name.trim().length === 0) return 'NAME';

  // Zero is as wrong as unreadable: the column is `CHECK (target_minor > 0)`, and refusing it here
  // says *why* rather than surfacing a database constraint as an INTERNAL.
  if (amountMinor(draft.target, currency) === null) return 'TARGET';

  const date = draft.targetDate.trim();
  if (date.length > 0 && !DATE_PATTERN.test(date)) return 'TARGET_DATE';

  return null;
}

/** The mutation input for a valid draft, or `null` when it is not valid (use `draftProblem` for why). */
export function goalWriteInput(draft: GoalDraft, currency: CurrencyCode): GoalWriteInput | null {
  if (draftProblem(draft, currency) !== null) return null;
  const targetMinor = amountMinor(draft.target, currency);
  if (targetMinor === null) return null;

  return {
    name: draft.name.trim(),
    targetMinor,
    targetDate: draft.targetDate.trim().length === 0 ? null : draft.targetDate.trim(),
    accountId: draft.accountId.trim().length === 0 ? null : draft.accountId.trim(),
  };
}

/** `null` when the contribution amount is usable, `'AMOUNT'` when it is not. */
export function contributionProblem(amount: string, currency: CurrencyCode): 'AMOUNT' | null {
  return amountMinor(amount, currency) === null ? 'AMOUNT' : null;
}

/** The progress bar's width: 0–100, whole percent, clamped. */
export function percent(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, Math.round(progress * 100)));
}

/**
 * The order the cards are drawn in.
 *
 * Active first with the soonest deadline at the top (a goal with no date sits after the dated ones,
 * because it has no urgency to sort by), then what has been achieved, then what the user archived.
 * Ties break on the name so two identical goals do not swap places between renders.
 */
export function orderedGoals(goals: readonly Goal[]): readonly Goal[] {
  const rank = (goal: Goal): number =>
    goal.status === 'ACTIVE' ? 0 : goal.status === 'ACHIEVED' ? 1 : 2;

  return [...goals].sort((left, right) => {
    if (rank(left) !== rank(right)) return rank(left) - rank(right);
    if (left.targetDate === null && right.targetDate !== null) return 1;
    if (left.targetDate !== null && right.targetDate === null) return -1;
    if (left.targetDate !== null && right.targetDate !== null && left.targetDate !== right.targetDate) {
      return left.targetDate < right.targetDate ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

export function activeGoals(goals: readonly Goal[]): readonly Goal[] {
  return goals.filter((goal) => goal.status !== 'ARCHIVED');
}

export function statusLabelKey(status: GoalStatus): TranslationKey {
  switch (status) {
    case 'ACTIVE':
      return 'goals.statusActive';
    case 'ACHIEVED':
      return 'goals.statusAchieved';
    case 'ARCHIVED':
      return 'goals.statusArchived';
  }
}

/**
 * The rate line's key: the backend's figure when there is a deadline, and the *add a date* nudge when
 * there is not. A goal without a deadline has no required monthly amount by design (docs/02 §4.13),
 * so the nudge is the honest thing to render rather than a zero.
 */
export function rateLabelKey(goal: Goal): TranslationKey {
  return goal.requiredPerMonth === null ? 'goals.noDate' : 'goals.rate';
}

/** A goal day as the reader's own date, e.g. `01.06.2027.` — never through the money formatter. */
export function dateLabel(day: string, tag: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, date)),
  );
}

/** True when the user may contribute: an archived goal may not (the API refuses it too). */
export function canContribute(goal: Goal): boolean {
  return goal.status !== 'ARCHIVED';
}
