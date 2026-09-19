import { money, toMajorString, type CurrencyCode, type NotificationChannel } from '@finmate/domain';

import { tr, type CopyLocale } from '../../common/i18n/copy';

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
 * which payload keys exist. It is also asserted **in every locale** — a Serbian translation that
 * spelled a number out would defeat the check, so the sweep runs over all three catalogues.
 *
 * ## The copy is bilingual, and the row is stored once
 *
 * This file used to be English-only, while `mail.service.ts` was Serbian-only and
 * `assistant-action.service.ts` was the one module with both — so a reader's notifications arrived in
 * whichever language the module's author happened to write (ADR-040). The copy is now a pair and the
 * caller resolves the locale from the **recipient's** stored preference, which is what makes the
 * stored `title`/`body` readable by the person who receives them.
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
  locale: CopyLocale = 'en',
): NotificationCopy {
  const categoryPath = typeof payload['categoryPath'] === 'string' ? payload['categoryPath'] : null;
  // A recurring rule's own words (`Netflix`). Free text, and usually the payee, so it is in-app only.
  const description = typeof payload['description'] === 'string' ? payload['description'] : null;

  if (channel !== 'IN_APP') {
    // Lock-screen safe (T-09): no amounts, no entity names. The subject is the user's own category
    // name, which is why it may stay — it is not a third party and it discloses nothing about who
    // they paid.
    return {
      title: titleFor(kind, categoryPath, locale),
      body:
        categoryPath === null
          ? tr(locale, LOCK_SCREEN_BODY, { app: appName })
          : tr(locale, LOCK_SCREEN_BODY_SUBJECT, { app: appName, subject: categoryPath }),
      full: false,
    };
  }

  return {
    title: inAppTitle(kind, categoryPath, description, payload, locale),
    body: inAppBody(kind, payload, locale),
    full: true,
  };
}

const LOCK_SCREEN_BODY = {
  en: 'Open {app} to see the details.',
  sr: 'Otvori {app} da vidiš detalje.',
};

const LOCK_SCREEN_BODY_SUBJECT = {
  en: '{subject}: open {app} to see the details.',
  sr: '{subject}: otvori {app} da vidiš detalje.',
};

/** The in-app title, which is the only place a rule's own (free-text) name may appear. */
function inAppTitle(
  kind: string,
  categoryPath: string | null,
  description: string | null,
  payload: Readonly<Record<string, unknown>>,
  locale: CopyLocale,
): string {
  if (kind === 'RECURRING_DUE') {
    const who = description ?? categoryPath ?? tr(locale, A_SCHEDULED_PAYMENT);
    const day = dueDay(payload);
    if (day === 'today') return tr(locale, BILL_DUE_TODAY, { who });
    if (day === 'tomorrow') return tr(locale, BILL_DUE_TOMORROW, { who });
    return tr(locale, BILL_DUE, { who });
  }
  return titleFor(kind, categoryPath, locale);
}

function titleFor(kind: string, subject: string | null, locale: CopyLocale): string {
  switch (kind) {
    case 'BUDGET_PACE':
      return subject === null
        ? tr(locale, { en: 'Budget overrun ahead', sr: 'Prekoračenje budžeta' })
        : tr(locale, { en: 'Budget overrun ahead: {subject}', sr: 'Prekoračenje budžeta: {subject}' }, { subject });
    case 'CATEGORY_SPIKE':
      return tr(
        locale,
        { en: 'Spending spike: {subject}', sr: 'Skok potrošnje: {subject}' },
        { subject: subject ?? tr(locale, A_CATEGORY) },
      );
    case 'UNUSUAL_SPEND':
      return tr(
        locale,
        { en: 'Unusual amount: {subject}', sr: 'Neobičan iznos: {subject}' },
        { subject: subject ?? tr(locale, A_CATEGORY) },
      );
    case 'POSITIVE_TREND':
      return subject === null
        ? tr(locale, { en: 'Good news', sr: 'Dobre vesti' })
        : tr(locale, { en: 'Good news: {subject}', sr: 'Dobre vesti: {subject}' }, { subject });
    case 'RECURRING_DUE':
      // Reached only for a non-in-app channel: the payee's name is deliberately not repeated there.
      return subject === null
        ? tr(locale, A_SCHEDULED_PAYMENT_DUE)
        : tr(locale, A_SCHEDULED_PAYMENT_DUE_SUBJECT, { subject });
    default:
      return tr(locale, { en: 'Insight: {kind}', sr: 'Uvid: {kind}' }, { kind });
  }
}

const A_SCHEDULED_PAYMENT = { en: 'a scheduled payment', sr: 'zakazano plaćanje' };
const A_SCHEDULED_PAYMENT_DUE = {
  en: 'A scheduled payment is due',
  sr: 'Dospeva zakazano plaćanje',
};
const A_SCHEDULED_PAYMENT_DUE_SUBJECT = {
  en: 'A scheduled payment is due: {subject}',
  sr: 'Dospeva zakazano plaćanje: {subject}',
};
const A_CATEGORY = { en: 'a category', sr: 'kategorija' };
const BILL_DUE = { en: 'Bill due: {who}', sr: 'Dospeva račun: {who}' };
const BILL_DUE_TODAY = { en: 'Bill due today: {who}', sr: 'Račun dospeva danas: {who}' };
const BILL_DUE_TOMORROW = { en: 'Bill due tomorrow: {who}', sr: 'Račun dospeva sutra: {who}' };

/**
 * `today` / `tomorrow`, and `null` for anything else.
 *
 * Words, never a figure: the in-app title must not be the reason a lock screen learns a date, and the
 * generator's horizon is one day so nothing further is expected. The function stays total anyway, so a
 * widened horizon can never smuggle a digit into a title.
 */
function dueDay(payload: Readonly<Record<string, unknown>>): 'today' | 'tomorrow' | null {
  const daysUntil = payload['daysUntil'];
  if (daysUntil === 0) return 'today';
  if (daysUntil === 1) return 'tomorrow';
  return null;
}

/** The in-app body: the figures, formatted in the ledger currency. */
function inAppBody(
  kind: string,
  payload: Readonly<Record<string, unknown>>,
  locale: CopyLocale,
): string {
  const currency = typeof payload['currency'] === 'string' ? payload['currency'] : 'RSD';
  const amount = (key: string): string => {
    const raw = payload[key];
    if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) return '—';
    return toMajorString(money(BigInt(raw), currency as CurrencyCode));
  };

  switch (kind) {
    case 'BUDGET_PACE':
      return tr(
        locale,
        {
          en: 'Projected {projected} against a {limit} limit — {over} over.',
          sr: 'Predviđeno {projected} uz limit {limit} — {over} više.',
        },
        {
          projected: amount('projectedTotalMinor'),
          limit: amount('limitMinor'),
          over: amount('projectedOverrunMinor'),
        },
      );
    case 'CATEGORY_SPIKE':
      return tr(
        locale,
        {
          en: '{current} so far, against a usual {usual} ({multiple}×).',
          sr: 'Do sada {current}, u odnosu na uobičajenih {usual} ({multiple}×).',
        },
        {
          current: amount('currentMinor'),
          usual: amount('baselineMeanMinor'),
          multiple: String(payload['multiple'] ?? '—'),
        },
      );
    case 'UNUSUAL_SPEND':
      return tr(
        locale,
        {
          en: '{amount} is {multiple}× the usual {median} here.',
          sr: '{amount} je {multiple}× uobičajenih {median} ovde.',
        },
        {
          amount: amount('amountMinor'),
          multiple: String(payload['multiple'] ?? '—'),
          median: amount('medianMinor'),
        },
      );
    case 'POSITIVE_TREND':
      return tr(
        locale,
        {
          en: '{saved} less than usual this month.',
          sr: '{saved} manje nego obično ovog meseca.',
        },
        { saved: amount('savedMinor') },
      );
    case 'RECURRING_DUE': {
      const day = dueDay(payload);
      // No day word means a horizon this build does not produce; "is scheduled" still reads honestly
      // rather than claiming "today".
      if (day === 'today') {
        return tr(locale, { en: '{amount} is charged today.', sr: '{amount} se naplaćuje danas.' }, { amount: amount('amountMinor') });
      }
      if (day === 'tomorrow') {
        return tr(locale, { en: '{amount} is charged tomorrow.', sr: '{amount} se naplaćuje sutra.' }, { amount: amount('amountMinor') });
      }
      return tr(locale, { en: '{amount} is scheduled.', sr: '{amount} je zakazano.' }, { amount: amount('amountMinor') });
    }
    default:
      // A kind added to the vocabulary but not to this switch still produces a usable row rather than
      // an empty notification body.
      return tr(locale, { en: '{kind}: {current}', sr: '{kind}: {current}' }, { kind, current: amount('currentMinor') });
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
