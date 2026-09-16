import { money, toMajorString, type CurrencyCode, type NotificationChannel } from '@finmate/domain';

/**
 * Notification copy, composed per **channel** — docs/02 §7.1, docs/08 §6.5, threat **T-09**.
 *
 * ## Why the channel decides the wording
 *
 * T-09 is *"notification content on a lock screen discloses amounts or third-party names"*, and the
 * mitigation docs/08 chose is explicit:
 *
 * > **Lock-screen-safe payloads by default — no amounts, no Merchant/Counterparty names; full content
 * > in-app only.**
 *
 * A single `title`/`body` used for every channel violates that by construction: the friendly sentence
 * *"Projected 600.00 against a 100.00 limit"* is fine inside the app and a disclosure on a phone that
 * is face-down on a table. So the copy is composed **per channel** from the same payload:
 *
 * | Channel | Title | Body |
 * |---|---|---|
 * | `IN_APP` | names the subject (the user's own category, and for a due bill the rule's own words) | full figures, from the payload |
 * | everything else | names the user's own category only | **no numerals**, no entity names — "open the app" |
 *
 * A recurring rule's `description` is the one subject that is **in-app only** whatever channel it is:
 * it is free text the user (or the detector) wrote, and in practice it is the payee — *"Netflix"* — so
 * repeating it on a lock screen is the exact disclosure T-09 names. The category path is not, because
 * it is the user's own filing.
 *
 * The distinction is asserted both ways in `notification-copy.spec.ts`: an in-app body must contain
 * the figures, and a lock-screen body must contain **no digit at all**. That second assertion is the
 * one that keeps working when somebody adds a generator, because it does not depend on remembering
 * which payload keys exist.
 *
 * ## The app name is a parameter
 *
 * AGENTS.md: never hardcode a brand string — `APP_NAME` comes from config, and `FinMate` is a working
 * title that is already taken (ADR-014). So the caller passes it in and this module stays pure.
 *
 * @module apps/api/src/modules/notifications
 */

export interface NotificationCopy {
  readonly title: string;
  readonly body: string;
  /** `true` for the in-app row, `false` for anything that can appear outside the app. */
  readonly full: boolean;
}

/**
 * Compose one notification's text.
 *
 * Never computes: every figure is read out of `payload`, which the generators wrote (ADR-001).
 */
export function composeNotification(
  kind: string,
  payload: Readonly<Record<string, unknown>>,
  channel: NotificationChannel,
  appName: string,
): NotificationCopy {
  const categoryPath = typeof payload['categoryPath'] === 'string' ? payload['categoryPath'] : null;
  // A recurring rule's own words (`Netflix`). Free text, and usually the payee, so it is in-app only.
  const description = typeof payload['description'] === 'string' ? payload['description'] : null;

  if (channel !== 'IN_APP') {
    // Lock-screen safe (T-09): no amounts, no entity names. The subject is the user's own category
    // name, which is why it may stay — it is not a third party and it discloses nothing about who
    // they paid.
    const subject = categoryPath;
    return {
      title: titleFor(kind, subject),
      body:
        subject === null
          ? `Open ${appName} to see the details.`
          : `${subject}: open ${appName} to see the details.`,
      full: false,
    };
  }

  return {
    title: inAppTitle(kind, categoryPath, description, payload),
    body: inAppBody(kind, payload),
    full: true,
  };
}

/** The in-app title, which is the only place a rule's own (free-text) name may appear. */
function inAppTitle(
  kind: string,
  categoryPath: string | null,
  description: string | null,
  payload: Readonly<Record<string, unknown>>,
): string {
  if (kind === 'RECURRING_DUE') {
    const who = description ?? categoryPath ?? 'a scheduled payment';
    return `Bill due${dueDayWord(payload)}: ${who}`;
  }
  return titleFor(kind, categoryPath);
}

function titleFor(kind: string, subject: string | null): string {
  switch (kind) {
    case 'BUDGET_PACE':
      return subject === null ? 'Budget overrun ahead' : `Budget overrun ahead: ${subject}`;
    case 'CATEGORY_SPIKE':
      return `Spending spike: ${subject ?? 'a category'}`;
    case 'UNUSUAL_SPEND':
      return `Unusual amount: ${subject ?? 'a category'}`;
    case 'POSITIVE_TREND':
      return subject === null ? 'Good news' : `Good news: ${subject}`;
    case 'RECURRING_DUE':
      // Reached only for a non-in-app channel: the payee's name is deliberately not repeated there.
      return subject === null
        ? 'A scheduled payment is due'
        : `A scheduled payment is due: ${subject}`;
    default:
      return `Insight: ${kind}`;
  }
}

/**
 * ` today` / ` tomorrow`, and an empty string for anything else.
 *
 * Words, never a figure: the in-app title must not be the reason a lock screen learns a date, and the
 * generator's horizon is one day so nothing further is expected. The function stays total anyway, so a
 * widened horizon can never smuggle a digit into a title.
 */
function dueDayWord(payload: Readonly<Record<string, unknown>>): string {
  const daysUntil = payload['daysUntil'];
  if (daysUntil === 0) return ' today';
  if (daysUntil === 1) return ' tomorrow';
  return '';
}

/** The in-app body: the figures, formatted in the ledger currency. */
function inAppBody(kind: string, payload: Readonly<Record<string, unknown>>): string {
  const currency = typeof payload['currency'] === 'string' ? payload['currency'] : 'RSD';
  const amount = (key: string): string => {
    const raw = payload[key];
    if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) return '—';
    return toMajorString(money(BigInt(raw), currency as CurrencyCode));
  };

  switch (kind) {
    case 'BUDGET_PACE':
      return (
        `Projected ${amount('projectedTotalMinor')} against a ${amount('limitMinor')} limit — ` +
        `${amount('projectedOverrunMinor')} over.`
      );
    case 'CATEGORY_SPIKE':
      return (
        `${amount('currentMinor')} so far, against a usual ${amount('baselineMeanMinor')} ` +
        `(${String(payload['multiple'] ?? '—')}×).`
      );
    case 'UNUSUAL_SPEND':
      return (
        `${amount('amountMinor')} is ${String(payload['multiple'] ?? '—')}× the usual ` +
        `${amount('medianMinor')} here.`
      );
    case 'POSITIVE_TREND':
      return `${amount('savedMinor')} less than usual this month.`;
    case 'RECURRING_DUE': {
      const when = dueDayWord(payload);
      // No day word means a horizon this build does not produce; "is scheduled" still reads honestly
      // rather than claiming "today".
      return when === ''
        ? `${amount('amountMinor')} is scheduled.`
        : `${amount('amountMinor')} is charged${when}.`;
    }
    default:
      // A kind added to the vocabulary but not to this switch still produces a usable row rather than
      // an empty notification body.
      return `${kind}: ${amount('currentMinor')}`;
  }
}

/**
 * Whether text is safe for a lock screen, by the only test that survives a new generator: it must
 * contain **no digit**. A count, a percentage, a date and an amount are all disclosures of the same
 * class, and enumerating payload keys is a check that rots.
 */
export function isLockScreenSafe(text: string): boolean {
  return !/\d/.test(text);
}
