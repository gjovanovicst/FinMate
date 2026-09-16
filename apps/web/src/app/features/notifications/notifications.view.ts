import { badgeAccessibleName, badgeText } from '../../core/navigation';
import type { TranslationKey } from '../../core/i18n/translations';

/**
 * The notification centre's decisions, as pure functions.
 *
 * docs/02 §4.17 owns the screen and F-22 the feature. What lives here is the part that is **wrong
 * silently**: which rows the unread filter shows, what a row's severity looks like, where a row
 * deep-links to, and whether the preferences form can be saved at all. All of it is tested without a
 * DOM, which is also why the component is thin.
 *
 * ## Why the deep link is derived from the kind
 *
 * docs/02 §4.17: *"Every row deep-links to the entity that caused it."* The notification carries only
 * the insight that produced it, and there is no insight detail screen — the entity the insight is
 * *about* is a Budget or a set of Transactions, so the link goes there. What must not happen is a row
 * that looks clickable and goes nowhere, or a link invented per kind inside the template where no test
 * can see it.
 *
 * ## Why quiet hours are validated here
 *
 * The API treats `start === end` as "never quiet" (docs/06 §5.14), so a user who sets both ends to the
 * same time gets no error and no quiet hours — the worst combination, because they believe they are
 * protected. The form therefore refuses it with an explanation instead of silently storing it.
 *
 * @module apps/web/src/app/features/notifications
 */

/** `insights.severity` (docs/03 §4), as the API reports it. */
export type InsightSeverity = 'INFO' | 'POSITIVE' | 'WARNING' | 'CRITICAL';

/** `notifications.channel` (docs/03 §4). */
export type NotificationChannel = 'IN_APP' | 'EMAIL' | 'PUSH' | 'WEB_PUSH';

/** `notifications.status` (docs/03 §4). */
export type NotificationStatus = 'QUEUED' | 'SENT' | 'FAILED' | 'SUPPRESSED';

/** One row of `notifications` (docs/06 §3.2), reduced to what the screen renders. */
export interface NotificationRow {
  readonly id: string;
  readonly insightId: string | null;
  /** Flattened by the API so the row's tone and its link need no join (docs/06 §5.14). */
  readonly insightKind: string | null;
  readonly insightSeverity: string | null;
  readonly channel: NotificationChannel;
  readonly title: string;
  readonly body: string;
  readonly status: NotificationStatus;
  readonly sentAt: string | null;
  readonly readAt: string | null;
  readonly createdAt: string;
}

/** One `alert_rules` row (docs/06 §3.2). */
export interface AlertRuleRow {
  readonly id: string;
  readonly kind: string;
  readonly channels: readonly NotificationChannel[];
  readonly quietHours: QuietHoursValue | null;
  readonly isActive: boolean;
}

export interface QuietHoursValue {
  readonly start: string;
  readonly end: string;
}

/** The channels a rule may name, in the order docs/06 §3.2 lists them. */
export const CHANNELS: readonly NotificationChannel[] = ['IN_APP', 'EMAIL', 'WEB_PUSH', 'PUSH'];

/**
 * The alert kinds the settings list offers.
 *
 * `BUDGET_THRESHOLD` and `GOAL_REACHED` are in the vocabulary (docs/03 §4) but no insight produces
 * them, so the screen shows the three that do — a toggle that cannot fire is a control that lies.
 */
export const CONFIGURABLE_KINDS = ['PACE_OVERRUN', 'UNUSUAL_SPEND', 'RECURRING_DUE'] as const;

/** `true` when the row still wants attention. */
export function isUnread(row: NotificationRow): boolean {
  return row.readAt === null;
}

export function unreadCount(rows: readonly NotificationRow[]): number {
  return rows.filter(isUnread).length;
}

/** The unread filter (docs/02 §4.17's "nepročitana" toggle). */
export function visibleRows(
  rows: readonly NotificationRow[],
  options: { readonly unreadOnly: boolean },
): readonly NotificationRow[] {
  return options.unreadOnly ? rows.filter(isUnread) : rows;
}

/**
 * The drawn unread badge, by the shell's one badge rule (docs/02 §2.3): hidden at 0, literal to 9,
 * `9+` above. Reused rather than re-derived so the two badges cannot disagree.
 */
export function notificationBadge(count: number): string {
  return badgeText(count);
}

export function notificationBadgeName(count: number, one: string, many: string): string | null {
  return count === 0 ? null : badgeAccessibleName(count, one, many);
}

/**
 * Where a row takes the user, or `null` when there is nothing useful to open.
 *
 * **This mapping has a second home.** A push payload has to name its destination before the SPA is
 * running, so the API's `pushDeepLink` (`apps/api/src/modules/notifications/web-push-payload.ts`)
 * carries the same table and the same fallback; the Android/iOS notification tap and the in-app row
 * must land in the same place. Task 4.2.5 aligned the two on this function's answers — change one and
 * change the other, and change `web-push-payload.spec.ts` with them.
 */
export function deepLinkFor(kind: string | null): string | null {
  if (kind === 'BUDGET_PACE') return '/budgets';
  if (kind === 'CATEGORY_SPIKE' || kind === 'UNUSUAL_SPEND') return '/transactions';
  // A due charge is about a rule, and the screen that owns the rules is where a user turns it off or
  // fixes the amount.
  if (kind === 'RECURRING_DUE') return '/recurring';
  // The insight exists but this build has no screen for its kind: better to render the row without a
  // link than a link to nowhere.
  return kind === null ? null : '/transactions';
}
/**
 * The tone a severity renders as. `POSITIVE` is its own tone, not a shade of `INFO`: F-22 requires
 * good news to look like good news (docs/02 §7.1).
 */
export type InsightTone = 'positive' | 'info' | 'warning' | 'critical';

export function toneFor(severity: InsightSeverity): InsightTone {
  switch (severity) {
    case 'POSITIVE':
      return 'positive';
    case 'WARNING':
      return 'warning';
    case 'CRITICAL':
      return 'critical';
    default:
      return 'info';
  }
}

/** The translation key for a severity label. */
export function severityLabelKey(severity: InsightSeverity): TranslationKey {
  return `notifications.severity.${severity}` as TranslationKey;
}

/** The translation key for an alert kind. */
export function kindLabelKey(kind: string): TranslationKey {
  const known = CONFIGURABLE_KINDS as readonly string[];
  return known.includes(kind)
    ? (`notifications.kind.${kind}` as TranslationKey)
    : ('notifications.kind.unknown' as TranslationKey);
}

/** The translation key for a delivery channel. */
export function channelLabelKey(channel: NotificationChannel): TranslationKey {
  return `notifications.channel.${channel}` as TranslationKey;
}

/**
 * The translation key for what a status means.
 *
 * `QUEUED` is worth explaining rather than hiding: it is what quiet hours produce, and a user who
 * sees it should learn *when* the notification will arrive, not think it failed.
 */
export function statusLabelKey(status: NotificationStatus): TranslationKey {
  return `notifications.status.${status}` as TranslationKey;
}

/** `HH:MM`, 24-hour. The API's own pattern (docs/06 §5.14). */
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface QuietHoursForm {
  readonly enabled: boolean;
  readonly start: string;
  readonly end: string;
}

export type QuietHoursProblem = 'start' | 'end' | 'same' | null;

/**
 * What is wrong with the quiet-hours form, as a field name the template can point at — or `null`.
 *
 * `same` is the case worth its own message: the API stores an empty window as "never quiet", so a user
 * who sets `22:00`–`22:00` believing they are protected would be silently unprotected.
 */
export function quietHoursProblem(form: QuietHoursForm): QuietHoursProblem {
  if (!form.enabled) return null;
  if (!TIME_PATTERN.test(form.start)) return 'start';
  if (!TIME_PATTERN.test(form.end)) return 'end';
  if (form.start === form.end) return 'same';
  return null;
}

/** The mutation input for a preferences save, or `null` when the form is invalid. */
export function preferencesInput(form: {
  readonly channels: readonly NotificationChannel[];
  readonly quietHours: QuietHoursForm;
  readonly positiveFeedback: boolean;
  readonly locale: string | null;
}): {
  readonly channels: readonly NotificationChannel[];
  readonly quietHours: QuietHoursValue | null;
  readonly positiveFeedback: boolean;
  readonly locale: string | null;
} | null {
  if (quietHoursProblem(form.quietHours) !== null) return null;
  return {
    // A user who unticks every channel would silently receive nothing; `IN_APP` is the floor, because
    // the centre is where the record lives (docs/06 §5.14 on preferences).
    channels: form.channels.length === 0 ? ['IN_APP'] : [...form.channels],
    quietHours: form.quietHours.enabled
      ? { start: form.quietHours.start, end: form.quietHours.end }
      : null,
    positiveFeedback: form.positiveFeedback,
    locale: form.locale,
  };
}

/** A rule toggle's payload, so the component never builds one inline. */
export function ruleUpdateInput(
  rule: AlertRuleRow,
  change: { readonly channels?: readonly NotificationChannel[]; readonly isActive?: boolean },
): {
  readonly id: string;
  readonly channels?: readonly NotificationChannel[];
  readonly isActive?: boolean;
} {
  return {
    id: rule.id,
    ...(change.channels !== undefined ? { channels: change.channels } : {}),
    ...(change.isActive !== undefined ? { isActive: change.isActive } : {}),
  };
}
