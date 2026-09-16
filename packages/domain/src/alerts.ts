import type { LocalDate } from './dates';

/**
 * The alert evaluator (docs/01 §6 F-22, docs/05 §9, docs/09 task 3.1.2).
 *
 * ```text
 * insight ──► AlertEvaluator (deterministic)
 *         ──► dedupe by (user_id, dedupe_key)
 *         ──► quiet hours / rate limit check
 *         ──► channel fan-out: IN_APP | EMAIL | WEB_PUSH
 * ```
 *
 * ## Why this is a pure decision, not a side effect
 *
 * Whether a user is told something is a product decision with three independent vetoes (the rule's own
 * state, the clock, and how much we have already said today), and every one of them is the kind of
 * thing that is silently wrong in production: an inverted quiet-hours comparison mutes the product
 * overnight, a missing dedupe key re-alerts on every dashboard load, and the docs say plainly what
 * that costs — *"re-alerting every time the dashboard loads is the fastest way to get notifications
 * disabled, and a disabled channel means the retention mechanic is gone"* (docs/05 §9).
 *
 * So this module returns **decisions**, and the caller writes rows. Nothing here reads a clock, a
 * database or a locale.
 *
 * ## Two asymmetries that are deliberate
 *
 * 1. **Quiet hours delay; they do not drop.** A queued notification is delivered when the window ends
 *    (`status: 'QUEUED'`, drained by `notifications.dispatch`, docs/05 §8) — the user asked not to be
 *    *interrupted*, not to be kept ignorant.
 * 2. **`CRITICAL` bypasses the rate limit.** A cap that can swallow the one alert that mattered is
 *    worse than a noisy feed, and the cap exists for noise.
 *
 * @module @finmate/domain
 */

/** docs/03 §4's `alert_rules.kind` vocabulary. `GOAL_REACHED` has no producer yet. */
export type AlertKind =
  | 'BUDGET_THRESHOLD'
  | 'PACE_OVERRUN'
  | 'RECURRING_DUE'
  | 'UNUSUAL_SPEND'
  | 'GOAL_REACHED';

/** docs/03 §4's `notifications.channel` CHECK constraint. */
export type NotificationChannel = 'IN_APP' | 'EMAIL' | 'PUSH' | 'WEB_PUSH';

/** docs/03 §4's `notifications.status` CHECK constraint. */
export type NotificationStatus = 'QUEUED' | 'SENT' | 'FAILED' | 'SUPPRESSED';

/** The insight severities an alert can carry (docs/03 §4's `insights.severity`). */
export type AlertSeverity = 'INFO' | 'POSITIVE' | 'WARNING' | 'CRITICAL';

/** A local-time window, `HH:MM`, which may cross midnight (`21:00`–`08:00`). */
export interface QuietHours {
  readonly start: string;
  readonly end: string;
}

export interface AlertRuleFact {
  readonly id: string;
  readonly kind: AlertKind;
  readonly channels: readonly NotificationChannel[];
  readonly quietHours: QuietHours | null;
  readonly isActive: boolean;
}

/** One insight, reduced to what the evaluator needs. `dedupeKey` comes from the generator. */
export interface AlertCandidate {
  readonly insightId: string;
  /** `<INSIGHT_KIND>:<periodStart>:<subject>` — the condition's stable identity. */
  readonly dedupeKey: string;
  readonly kind: string;
  readonly severity: AlertSeverity;
  readonly periodStart: LocalDate;
  /** Which alert rule governs it. */
  readonly alertKind: AlertKind;
}

export type AlertDecisionReason =
  /** Deliverable now. */
  | 'DELIVER'
  /** Inside the user's quiet hours: queued, not dropped. */
  | 'QUIET_HOURS'
  /** The same condition was already sent — `UNIQUE (user_id, dedupe_key)` at the database. */
  | 'DUPLICATE'
  /** Over the daily cap. Never applied to `CRITICAL`. */
  | 'RATE_LIMITED'
  /** The rule for this kind is switched off. */
  | 'RULE_INACTIVE'
  /** A `POSITIVE` insight with positive feedback switched off. */
  | 'POSITIVE_DISABLED';

export interface AlertDecision {
  readonly insightId: string;
  readonly alertKind: AlertKind;
  readonly channel: NotificationChannel;
  readonly status: NotificationStatus;
  readonly reason: AlertDecisionReason;
}

export interface AlertEvaluationInput {
  readonly candidates: readonly AlertCandidate[];
  readonly rules: readonly AlertRuleFact[];
  /** The user's local time, `HH:MM`. */
  readonly localTime: string;
  /** Dedupe keys already sent to this user. */
  readonly sentDedupeKeys: ReadonlySet<string>;
  /** How many notifications this user received in the last 24 hours. */
  readonly sentInLastDay: number;
  /** Whether the user wants good news as well as warnings (docs/06 `NotificationPreferencesInput`). */
  readonly positiveFeedback: boolean;
}

/**
 * How many notifications one user may receive per rolling day before non-critical ones are held back.
 *
 * Ten is roughly "one an hour in a bad day" — high enough that a genuinely bad day still gets through,
 * low enough that a misconfigured rule cannot turn the feed into spam. `CRITICAL` is exempt
 * (see the module docs).
 */
export const MAX_NOTIFICATIONS_PER_DAY = 10;

/**
 * The dedupe key for one condition on one channel.
 *
 * `UNIQUE (user_id, dedupe_key)` is what actually enforces this; the key is per **channel** because
 * "we already sent you an email about this" must not suppress the in-app row — the two have different
 * costs and different meanings. The insight's own `dedupeKey` already names the condition (kind,
 * period, subject), so this only adds the channel.
 */
export function notificationDedupeKey(insightDedupeKey: string, channel: NotificationChannel): string {
  return `${insightDedupeKey}:${channel}`;
}

/**
 * Whether `localTime` falls inside a quiet-hours window.
 *
 * `start > end` means the window crosses midnight (`21:00`–`08:00` is the common case), which is the
 * comparison that gets inverted when written as `time >= start && time < end` — that version mutes
 * *daytime* instead. `start === end` is an empty window, not a whole day: a user who sets both ends to
 * `00:00` means "never quiet", and reading it as "always" would silently disable every alert.
 */
export function isQuietHour(localTime: string, quiet: QuietHours): boolean {
  const { start, end } = quiet;
  if (start === end) return false;
  if (start < end) return localTime >= start && localTime < end;
  return localTime >= start || localTime < end;
}

/**
 * Decide what happens to every candidate, in a fixed order.
 *
 * Order is the point: a switched-off rule is not a suppression the user should hear about, a duplicate
 * must not consume the daily allowance, and a quiet hour beats a rate limit because it is a delay the
 * user asked for rather than something we are withholding.
 */
export function evaluateAlerts(input: AlertEvaluationInput): readonly AlertDecision[] {
  const ruleByKind = new Map(input.rules.map((rule) => [rule.kind, rule]));
  const decisions: AlertDecision[] = [];
  let deliveredToday = input.sentInLastDay;

  for (const candidate of [...input.candidates].sort((left, right) =>
    left.dedupeKey.localeCompare(right.dedupeKey),
  )) {
    const rule = ruleByKind.get(candidate.alertKind);
    if (candidate.severity === 'POSITIVE' && !input.positiveFeedback) {
      decisions.push(decision(candidate, 'IN_APP', 'SUPPRESSED', 'POSITIVE_DISABLED'));
      continue;
    }
    if (rule === undefined || !rule.isActive) {
      decisions.push(decision(candidate, 'IN_APP', 'SUPPRESSED', 'RULE_INACTIVE'));
      continue;
    }

    // A positive insight is in-app only: good news is not worth a push notification, and docs/02 puts
    // it on its own tab rather than in the interrupt path.
    const channels =
      candidate.severity === 'POSITIVE' ? (['IN_APP'] as const) : uniqueChannels(rule.channels);

    for (const channel of channels) {
      const dedupeKey = notificationDedupeKey(candidate.dedupeKey, channel);
      if (input.sentDedupeKeys.has(dedupeKey)) {
        decisions.push(decision(candidate, channel, 'SUPPRESSED', 'DUPLICATE'));
        continue;
      }
      if (rule.quietHours !== null && isQuietHour(input.localTime, rule.quietHours)) {
        decisions.push(decision(candidate, channel, 'QUEUED', 'QUIET_HOURS'));
        continue;
      }
      if (deliveredToday >= MAX_NOTIFICATIONS_PER_DAY && candidate.severity !== 'CRITICAL') {
        decisions.push(decision(candidate, channel, 'SUPPRESSED', 'RATE_LIMITED'));
        continue;
      }
      deliveredToday += 1;
      decisions.push(decision(candidate, channel, 'SENT', 'DELIVER'));
    }
  }

  return decisions;
}

function decision(
  candidate: AlertCandidate,
  channel: NotificationChannel,
  status: NotificationStatus,
  reason: AlertDecisionReason,
): AlertDecision {
  return {
    insightId: candidate.insightId,
    alertKind: candidate.alertKind,
    channel,
    status,
    reason,
  };
}

/** A rule may list a channel twice; the dedupe key would then collide with itself. */
function uniqueChannels(channels: readonly NotificationChannel[]): readonly NotificationChannel[] {
  return [...new Set(channels)];
}

/**
 * Which alert rule governs an insight kind.
 *
 * `CATEGORY_SPIKE` and `UNUSUAL_SPEND` both map to `UNUSUAL_SPEND`: from the user's side they are one
 * question ("is this normal?") at two grains, and giving them separate rules to configure would be two
 * switches for one intention.
 *
 * `GOAL_REACHED` is in the vocabulary with no producer yet — savings goals (3.3.2) exist but nothing
 * turns one reaching its target into an insight, and docs/06 §5.5's precedent is to declare the arm
 * only when something can produce it.
 */
export function alertKindForInsight(insightKind: string): AlertKind | null {
  switch (insightKind) {
    case 'BUDGET_PACE':
      return 'PACE_OVERRUN';
    case 'CATEGORY_SPIKE':
    case 'UNUSUAL_SPEND':
      return 'UNUSUAL_SPEND';
    case 'RECURRING_DUE':
      return 'RECURRING_DUE';
    default:
      return null;
  }
}
