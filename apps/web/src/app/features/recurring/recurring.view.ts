import { parseRRule, type LocalDate, type RRuleSpec, type Weekday, type CurrencyCode } from '@finmate/domain';

import type { TranslationKey } from '../../core/i18n/translations';
import type { MoneyWire } from '../../shared/ui/money/money.component';
import { amountMinor } from '../goals/goals.view';

/**
 * The recurring screen's decisions, as pure functions — F-16, docs/02 §4.14, docs/06 §4/§5.8.
 *
 * What lives here is the part that is **wrong silently**:
 *
 *  - **building an RRULE from the form.** The string is what the backend expands and stores; a wrong
 *    one posts money on the wrong days. The builder is the inverse of the description below, and both
 *    are tested against each other.
 *  - **describing an RRULE in words.** docs/02 §4.14 requires the rule to read as a sentence; the raw
 *    RFC 5545 text is the advanced disclosure. A description that disagrees with the schedule is worse
 *    than no sentence at all, so the words are derived from the same parse the server uses.
 *  - **the "next 30 days" line.** It flattens each rule's server-expanded dates; the client never
 *    expands a recurrence itself, and it never shows a date the API did not produce.
 *  - **the write plan** for the form: description, amount (`parseAmount`, the one reader), an optional
 *    end date, and the Schedule the picker produced.
 *
 * @module apps/web/src/app/features/recurring
 */

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export const FREQUENCIES: readonly Frequency[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

export interface RecurringRule {
  readonly id: string;
  readonly accountId: string;
  readonly accountName: string | null;
  readonly kind: string;
  readonly amount: MoneyWire;
  readonly categoryId: string | null;
  readonly description: string;
  readonly rrule: string;
  readonly nextOccurrenceOn: string;
  readonly endsOn: string | null;
  readonly autoConfirm: boolean;
  readonly isDetected: boolean;
  readonly isActive: boolean;
  readonly generatedCount: number;
  readonly upcomingOccurrences: readonly string[];
}

/** The form, as typed. */
export interface RuleDraft {
  readonly description: string;
  readonly amount: string;
  readonly accountId: string;
  readonly kind: 'EXPENSE' | 'INCOME';
  readonly frequency: Frequency;
  readonly interval: string;
  readonly byDay: readonly Weekday[];
  readonly startsOn: string;
  readonly endsOn: string;
  readonly autoConfirm: boolean;
}

export const EMPTY_DRAFT: RuleDraft = {
  description: '',
  amount: '',
  accountId: '',
  kind: 'EXPENSE',
  frequency: 'MONTHLY',
  interval: '1',
  byDay: [],
  startsOn: '',
  endsOn: '',
  autoConfirm: false,
};

export type DraftProblem = 'DESCRIPTION' | 'AMOUNT' | 'ACCOUNT' | 'INTERVAL' | 'START_DATE' | 'END_DATE' | null;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `1` when the field is blank or unreadable, clamped to the interval the domain accepts. */
export function intervalOf(draft: RuleDraft): number {
  const parsed = Number(draft.interval.trim() === '' ? '1' : draft.interval.trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) return 1;
  return parsed;
}

/**
 * The RRULE the form describes.
 *
 * `MONTHLY` takes the day from the start date (a rule "on the 15th" is what a person means by
 * monthly), and `WEEKLY` takes its weekdays from the picker — empty means the start date's own
 * weekday, which the backend anchors for us. An unsupported combination is impossible by construction:
 * the picker can only produce the parts `@finmate/domain` expands.
 */
export function buildRRule(draft: RuleDraft): string {
  const interval = intervalOf(draft);
  const parts = [`FREQ=${draft.frequency}`];
  if (interval !== 1) parts.push(`INTERVAL=${interval}`);
  if (draft.frequency === 'WEEKLY' && draft.byDay.length > 0) parts.push(`BYDAY=${draft.byDay.join(',')}`);
  if (draft.frequency === 'MONTHLY' && DATE_PATTERN.test(draft.startsOn)) {
    parts.push(`BYMONTHDAY=${Number(draft.startsOn.slice(8, 10))}`);
  }
  if (DATE_PATTERN.test(draft.endsOn)) parts.push(`UNTIL=${draft.endsOn.replace(/-/g, '')}`);
  return `RRULE:${parts.join(';')}`;
}

/** The picker's state for an existing rule, so editing does not start from a blank form. */
export function draftFromRule(rule: RecurringRule): RuleDraft {
  const parsed = parseRRule(rule.rrule);
  const spec: RRuleSpec | null = parsed.ok ? parsed.spec : null;
  return {
    description: rule.description,
    amount: rule.amount.amountMinor,
    accountId: rule.accountId,
    kind: rule.kind === 'INCOME' ? 'INCOME' : 'EXPENSE',
    frequency: (spec?.frequency ?? 'MONTHLY') as Frequency,
    interval: String(spec?.interval ?? 1),
    byDay: spec?.byDay ?? [],
    startsOn: rule.nextOccurrenceOn,
    endsOn: rule.endsOn ?? '',
    autoConfirm: rule.autoConfirm,
  };
}

/** A schedule in words: a catalogue key plus the params it interpolates. */
export interface ScheduleSentence {
  readonly key: TranslationKey;
  readonly params: Record<string, string | number>;
}

/** The day-of-month and weekday placeholders, localised by the caller. */
export function describeSchedule(rrule: string): ScheduleSentence | null {
  const parsed = parseRRule(rrule);
  if (!parsed.ok) return null;
  const spec = parsed.spec;
  const interval = spec.interval;

  switch (spec.frequency) {
    case 'DAILY':
      return interval === 1
        ? { key: 'recurring.everyDay', params: {} }
        : { key: 'recurring.everyNDays', params: { count: interval } };
    case 'WEEKLY': {
      if (spec.byDay.length > 0) {
        return interval === 1
          ? { key: 'recurring.everyWeekOn', params: { days: spec.byDay.join(',') } }
          : { key: 'recurring.everyNWeeksOn', params: { count: interval, days: spec.byDay.join(',') } };
      }
      return interval === 1
        ? { key: 'recurring.everyWeek', params: {} }
        : { key: 'recurring.everyNWeeks', params: { count: interval } };
    }
    case 'MONTHLY': {
      const day = spec.byMonthDay[0];
      if (day === undefined) {
        return interval === 1
          ? { key: 'recurring.everyMonth', params: {} }
          : { key: 'recurring.everyNMonths', params: { count: interval } };
      }
      return interval === 1
        ? { key: 'recurring.everyMonthOn', params: { day } }
        : { key: 'recurring.everyNMonthsOn', params: { count: interval, day } };
    }
    case 'YEARLY':
      return interval === 1
        ? { key: 'recurring.everyYear', params: {} }
        : { key: 'recurring.everyNYears', params: { count: interval } };
  }
}

/** The weekday tokens as catalogue keys, in the order the picker draws them. */
export function weekdayLabelKey(day: Weekday): TranslationKey {
  const keys: Record<Weekday, TranslationKey> = {
    MO: 'recurring.day.MO',
    TU: 'recurring.day.TU',
    WE: 'recurring.day.WE',
    TH: 'recurring.day.TH',
    FR: 'recurring.day.FR',
    SA: 'recurring.day.SA',
    SU: 'recurring.day.SU',
  };
  return keys[day];
}

/** Why the draft cannot be saved, or `null`. */
export function draftProblem(draft: RuleDraft, currency: CurrencyCode): DraftProblem {
  if (draft.description.trim().length === 0) return 'DESCRIPTION';
  if (amountMinor(draft.amount, currency) === null) return 'AMOUNT';
  if (draft.accountId.trim().length === 0) return 'ACCOUNT';
  const rawInterval = draft.interval.trim();
  if (rawInterval !== '' && intervalOf(draft) === 1 && rawInterval !== '1') return 'INTERVAL';
  if (draft.startsOn.trim().length > 0 && !DATE_PATTERN.test(draft.startsOn.trim())) return 'START_DATE';
  if (draft.endsOn.trim().length > 0 && !DATE_PATTERN.test(draft.endsOn.trim())) return 'END_DATE';
  return null;
}

export interface RuleWriteInput {
  readonly accountId: string;
  readonly kind: 'EXPENSE' | 'INCOME';
  readonly amountMinor: bigint;
  readonly description: string;
  readonly rrule: string;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly autoConfirm: boolean;
}

export function ruleWriteInput(draft: RuleDraft, currency: CurrencyCode): RuleWriteInput | null {
  if (draftProblem(draft, currency) !== null) return null;
  const minor = amountMinor(draft.amount, currency);
  if (minor === null) return null;

  return {
    accountId: draft.accountId.trim(),
    kind: draft.kind,
    amountMinor: minor,
    description: draft.description.trim(),
    rrule: buildRRule(draft),
    startsOn: draft.startsOn.trim() === '' ? null : draft.startsOn.trim(),
    endsOn: draft.endsOn.trim() === '' ? null : draft.endsOn.trim(),
    autoConfirm: draft.autoConfirm,
  };
}

export function problemKey(problem: Exclude<DraftProblem, null>): TranslationKey {
  const keys: Record<Exclude<DraftProblem, null>, TranslationKey> = {
    DESCRIPTION: 'recurring.problem.DESCRIPTION',
    AMOUNT: 'recurring.problem.AMOUNT',
    ACCOUNT: 'recurring.problem.ACCOUNT',
    INTERVAL: 'recurring.problem.INTERVAL',
    START_DATE: 'recurring.problem.DATE',
    END_DATE: 'recurring.problem.DATE',
  };
  return keys[problem];
}

/** One line of the "next 30 days" summary. */
export interface UpcomingEntry {
  readonly ruleId: string;
  readonly description: string;
  readonly date: string;
  readonly amount: MoneyWire;
}

/**
 * The dates the API says will be posted inside the window, oldest first.
 *
 * **The client expands nothing**: every date comes from `upcomingOccurrences`, which the server already
 * bounded by the rule's own end and count. The wireframe's combined line is this flattened, sorted and
 * capped, so two rules that both fire on the 1st read in a stable order.
 */
export function upcomingWithin(
  rules: readonly RecurringRule[],
  today: LocalDate,
  days = 30,
  limit = 12,
): readonly UpcomingEntry[] {
  const horizon = addDaysTo(today, days);
  const entries: UpcomingEntry[] = [];

  for (const rule of rules) {
    if (!rule.isActive) continue;
    for (const date of rule.upcomingOccurrences) {
      if (date < today || date > horizon) continue;
      entries.push({ ruleId: rule.id, description: rule.description, date, amount: rule.amount });
    }
  }

  return entries
    .sort((left, right) =>
      left.date === right.date
        ? left.description.localeCompare(right.description)
        : left.date < right.date
          ? -1
          : 1,
    )
    .slice(0, limit);
}

/** A goal day as the reader's own date. */
export function dateLabel(day: string, tag: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, date)),
  );
}

/** Active rules first, then by next occurrence — the order the list is scanned in. */
export function orderedRules(rules: readonly RecurringRule[]): readonly RecurringRule[] {
  return [...rules].sort((left, right) => {
    if (left.isActive !== right.isActive) return left.isActive ? -1 : 1;
    if (left.nextOccurrenceOn !== right.nextOccurrenceOn) {
      return left.nextOccurrenceOn < right.nextOccurrenceOn ? -1 : 1;
    }
    return left.description.localeCompare(right.description);
  });
}

function addDaysTo(day: LocalDate, days: number): LocalDate {
  const parsed = new Date(`${day}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10) as LocalDate;
}
