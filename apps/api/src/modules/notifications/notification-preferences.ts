import type { NotificationChannel, QuietHours } from '@finmate/domain';

/**
 * Notification preferences — docs/06 §3.2's `NotificationPreferencesInput`, stored in
 * `households.settings.notifications`.
 *
 * ## Why `households.settings` and not a table
 *
 * The same reason onboarding progress lives there (docs/06 §5.12): the setting belongs to the
 * Household, the column already exists, and v1 has exactly one Member per Household (F-29 is a `Won't`).
 * A per-member preferences table becomes meaningful when sharing lands, and inventing one now would be
 * a migration for a distinction nothing can express.
 *
 * ## A malformed document is not an error
 *
 * `settings` is JSONB and anything can be in it — an older shape, a hand-edited value, a partially
 * written object. Parsing therefore **falls back per field** to the documented default rather than
 * throwing: preferences decide whether a user is interrupted, and a bad value must degrade to the
 * default, never to a 500 on the notification centre. `resolveLaneThresholds` (docs/04 §7) follows the
 * same rule for the same reason.
 *
 * @module apps/api/src/modules/notifications
 */

export interface NotificationPreferences {
  /** Channels the user accepts at all. A rule may name others; they are not delivered. */
  readonly channels: readonly NotificationChannel[];
  /** Window applied to a rule that has none of its own. `null` disables quiet hours. */
  readonly quietHours: QuietHours | null;
  /** Whether good news is delivered at all (F-22 requires the option; the default is yes). */
  readonly positiveFeedback: boolean;
  /** Recorded now, honoured when server-side copy is localised (docs/06 §5.14). */
  readonly locale: string | null;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  channels: ['IN_APP'],
  quietHours: null,
  positiveFeedback: true,
  locale: null,
};

const CHANNELS: readonly NotificationChannel[] = ['IN_APP', 'EMAIL', 'PUSH', 'WEB_PUSH'];
const TIME_PATTERN = /^\d{2}:\d{2}$/;

function asChannelList(value: unknown): readonly NotificationChannel[] | null {
  if (!Array.isArray(value)) return null;
  const channels = value.filter(
    (entry): entry is NotificationChannel =>
      typeof entry === 'string' && (CHANNELS as readonly string[]).includes(entry),
  );
  return channels.length === 0 ? null : channels;
}

function asQuietHours(value: unknown): QuietHours | null {
  if (typeof value !== 'object' || value === null) return null;
  const start = (value as { start?: unknown }).start;
  const end = (value as { end?: unknown }).end;
  if (typeof start !== 'string' || typeof end !== 'string') return null;
  if (!TIME_PATTERN.test(start) || !TIME_PATTERN.test(end)) return null;
  return { start, end };
}

/** Read preferences out of whatever is in `households.settings.notifications`. */
export function parseNotificationPreferences(raw: unknown): NotificationPreferences {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_NOTIFICATION_PREFERENCES;
  const source = raw as Record<string, unknown>;

  return {
    channels: asChannelList(source['channels'] ?? source['channelsEnabled']) ??
      DEFAULT_NOTIFICATION_PREFERENCES.channels,
    quietHours: asQuietHours(source['quietHours']),
    positiveFeedback:
      typeof source['positiveFeedback'] === 'boolean'
        ? source['positiveFeedback']
        : DEFAULT_NOTIFICATION_PREFERENCES.positiveFeedback,
    locale: typeof source['locale'] === 'string' ? source['locale'] : null,
  };
}

/** The JSONB document to store, normalised so a reader never has to guess a shape. */
export function serialiseNotificationPreferences(input: {
  readonly channels?: readonly NotificationChannel[];
  readonly quietHours?: QuietHours | null;
  readonly positiveFeedback?: boolean;
  readonly locale?: string | null;
}): Record<string, unknown> {
  return {
    channels: input.channels === undefined ? ['IN_APP'] : [...input.channels],
    quietHours: input.quietHours ?? null,
    positiveFeedback: input.positiveFeedback ?? true,
    locale: input.locale ?? null,
  };
}

/**
 * The quiet hours that actually govern a rule: the rule's own window, or the Household preference.
 *
 * A rule's own window wins because it is the more specific statement — the user who set "no alerts
 * about groceries at night" on one rule meant it.
 */
export function effectiveQuietHours(
  ruleQuietHours: QuietHours | null,
  preferences: NotificationPreferences,
): QuietHours | null {
  return ruleQuietHours ?? preferences.quietHours;
}

/** Intersect a rule's channels with what the user accepts; never widen. */
export function effectiveChannels(
  ruleChannels: readonly NotificationChannel[],
  preferences: NotificationPreferences,
): readonly NotificationChannel[] {
  return ruleChannels.filter((channel) => preferences.channels.includes(channel));
}
