import { describe, expect, it } from 'vitest';

import { composeNotification, isLockScreenSafe } from './notification-copy';

/**
 * T-09 is a **disclosure** threat, so the tests are written to fail loudly if a body that can reach a
 * lock screen ever contains a figure — including one added by a generator nobody has written yet.
 */

const pacePayload = {
  currency: 'RSD',
  categoryPath: 'Hrana / Supermarket',
  limitMinor: '10000',
  spentMinor: '30000',
  projectedTotalMinor: '60000',
  projectedOverrunMinor: '50000',
};

const spikePayload = {
  currency: 'RSD',
  categoryPath: 'Hrana / Supermarket',
  currentMinor: '30000',
  baselineMeanMinor: '10000',
  multiple: 3,
};

const duePayload = {
  currency: 'RSD',
  description: 'Netflix',
  categoryPath: null,
  amountMinor: '129900',
  daysUntil: 1,
};

describe('composeNotification', () => {
  it('gives the in-app row the figures, formatted in the ledger currency', () => {
    const copy = composeNotification('BUDGET_PACE', pacePayload, 'IN_APP', 'Ostava');
    expect(copy.full).toBe(true);
    expect(copy.title).toBe('Budget overrun ahead: Hrana / Supermarket');
    expect(copy.body).toContain('600.00');
    expect(copy.body).toContain('100.00');
    expect(copy.body).toContain('500.00');
  });

  it('keeps every non-in-app channel free of digits (T-09)', () => {
    for (const channel of ['EMAIL', 'PUSH', 'WEB_PUSH'] as const) {
      const copy = composeNotification('BUDGET_PACE', pacePayload, channel, 'Ostava');
      expect(copy.full).toBe(false);
      expect(isLockScreenSafe(copy.title)).toBe(true);
      expect(isLockScreenSafe(copy.body)).toBe(true);
      // The subject is the user's own category, which discloses nothing about who they paid.
      expect(copy.body).toContain('Hrana / Supermarket');
      expect(copy.body).toContain('Ostava');
    }
  });

  it('holds for every kind the generators produce, not just the one with a test', () => {
    const payloads = [pacePayload, spikePayload, duePayload, { currency: 'RSD' }];
    for (const kind of [
      'BUDGET_PACE',
      'CATEGORY_SPIKE',
      'UNUSUAL_SPEND',
      'POSITIVE_TREND',
      'RECURRING_DUE',
      'SOMETHING_NEW',
    ]) {
      for (const payload of payloads) {
        const copy = composeNotification(kind, payload, 'WEB_PUSH', 'Ostava');
        expect(isLockScreenSafe(copy.body), `${kind} on WEB_PUSH: ${copy.body}`).toBe(true);
        expect(isLockScreenSafe(copy.title), `${kind} on WEB_PUSH: ${copy.title}`).toBe(true);
      }
    }
  });

  it('names a due bill in-app and never repeats the payee on a lock screen (T-09)', () => {
    const inApp = composeNotification('RECURRING_DUE', duePayload, 'IN_APP', 'Ostava');
    expect(inApp.full).toBe(true);
    expect(inApp.title).toBe('Bill due tomorrow: Netflix');
    expect(inApp.body).toBe('1299.00 is charged tomorrow.');

    // The rule's description is free text and is usually the payee, so it is the one subject T-09
    // forbids outside the app — even though the amount is what actually makes the row useful.
    for (const channel of ['EMAIL', 'PUSH', 'WEB_PUSH'] as const) {
      const copy = composeNotification('RECURRING_DUE', duePayload, channel, 'Ostava');
      expect(copy.title).toBe('A scheduled payment is due');
      expect(copy.body).toBe('Open Ostava to see the details.');
      expect(isLockScreenSafe(copy.title)).toBe(true);
      expect(isLockScreenSafe(copy.body)).toBe(true);
      expect(copy.body).not.toContain('Netflix');
    }
  });

  it('says "today" for a charge due today, and stays honest past the day words', () => {
    const today = composeNotification('RECURRING_DUE', { ...duePayload, daysUntil: 0 }, 'IN_APP', 'Ostava');
    expect(today.title).toBe('Bill due today: Netflix');
    expect(today.body).toBe('1299.00 is charged today.');

    // The generator's horizon is one day, so this is only reachable if the horizon widens; the point is
    // that neither branch invents a date or a figure, and neither leaks a digit to a lock screen.
    const later = composeNotification('RECURRING_DUE', { ...duePayload, daysUntil: 5 }, 'IN_APP', 'Ostava');
    expect(later.title).toBe('Bill due: Netflix');
    expect(later.body).toBe('1299.00 is scheduled.');
  });

  it('falls back to the Category for an in-app due bill, and to a generic title without one', () => {
    const withCategory = composeNotification(
      'RECURRING_DUE',
      { ...duePayload, description: null, categoryPath: 'Zabava / Pretplate' },
      'IN_APP',
      'Ostava',
    );
    expect(withCategory.title).toBe('Bill due tomorrow: Zabava / Pretplate');

    const withoutAnything = composeNotification(
      'RECURRING_DUE',
      { currency: 'RSD', amountMinor: '129900', daysUntil: 1 },
      'IN_APP',
      'Ostava',
    );
    expect(withoutAnything.title).toBe('Bill due tomorrow: a scheduled payment');
  });

  it('names the app from the caller, never a hardcoded brand', () => {
    const copy = composeNotification('BUDGET_PACE', pacePayload, 'EMAIL', 'Ostava');
    expect(copy.body).toContain('Ostava');
    expect(copy.body).not.toContain('FinMate');
  });

  it('degrades to a usable body when a payload field is missing or malformed', () => {
    const copy = composeNotification('BUDGET_PACE', {}, 'IN_APP', 'Ostava');
    expect(copy.body).toContain('—');
    expect(copy.title).toBe('Budget overrun ahead');

    // A non-numeric amount string is not coerced into a number (ADR-003).
    const malformed = composeNotification(
      'BUDGET_PACE',
      { ...pacePayload, limitMinor: '1.5' },
      'IN_APP',
      'Ostava',
    );
    expect(malformed.body).toContain('—');
  });

  it('states the amount saved for a positive trend, in-app', () => {
    const copy = composeNotification(
      'POSITIVE_TREND',
      { currency: 'RSD', categoryPath: 'Hrana', savedMinor: '4200' },
      'IN_APP',
      'Ostava',
    );
    expect(copy.body).toBe('42.00 less than usual this month.');
    expect(copy.title).toBe('Good news: Hrana');
  });

  it('has a body for an unknown kind rather than an empty notification', () => {
    const copy = composeNotification('SOMETHING_NEW', { currency: 'RSD' }, 'IN_APP', 'Ostava');
    expect(copy.body.length).toBeGreaterThan(0);
    expect(copy.title).toContain('SOMETHING_NEW');
  });
});

/**
 * ADR-040: the row is composed in the recipient's language, and T-09 holds in every one of them.
 *
 * The lock-screen sweep is the part worth having: a translation is exactly where somebody spells a
 * number out ("dva dana"), so the digit test has to run over the Serbian copy too and not only over the
 * English it was written against.
 */
describe('composeNotification in the reader’s language', () => {
  it('renders the whole row in Serbian Latin and derives the Cyrillic one', () => {
    const latin = composeNotification('RECURRING_DUE', duePayload, 'IN_APP', 'Ostava', 'sr-Latn');
    expect(latin.title).toBe('Račun dospeva sutra: Netflix');
    expect(latin.body).toBe('1299.00 se naplaćuje sutra.');

    const cyrillic = composeNotification('RECURRING_DUE', duePayload, 'IN_APP', 'Ostava', 'sr-Cyrl');
    expect(cyrillic.title).toBe('Рачун доспева сутра: Netflix');
    expect(cyrillic.body).toBe('1299.00 се наплаћује сутра.');
  });

  it('keeps a lock screen free of digits in every locale', () => {
    for (const locale of ['en', 'sr-Latn', 'sr-Cyrl'] as const) {
      for (const channel of ['EMAIL', 'PUSH', 'WEB_PUSH'] as const) {
        for (const payload of [pacePayload, spikePayload, duePayload, { currency: 'RSD' }]) {
          const copy = composeNotification('BUDGET_PACE', payload, channel, 'Ostava', locale);
          expect(isLockScreenSafe(copy.title), `${locale} title: ${copy.title}`).toBe(true);
          expect(isLockScreenSafe(copy.body), `${locale} body: ${copy.body}`).toBe(true);
        }
      }
    }
  });

  it('translates the template but never the reader’s own Category name', () => {
    // The category path is interpolated **after** transliteration, so a Household's own words survive
    // exactly as they typed them. Transliterating the rendered string would rewrite their data.
    const copy = composeNotification('BUDGET_PACE', pacePayload, 'WEB_PUSH', 'Ostava', 'sr-Cyrl');
    expect(copy.body).toContain('отвори');
    expect(copy.body).toContain('Hrana / Supermarket');
  });
});

describe('isLockScreenSafe', () => {
  it('rejects anything with a digit, whatever the digit means', () => {
    expect(isLockScreenSafe('Budget overrun ahead')).toBe(true);
    expect(isLockScreenSafe('600.00 over')).toBe(false);
    expect(isLockScreenSafe('3× the usual')).toBe(false);
    expect(isLockScreenSafe('Due on the 14th')).toBe(false);
  });
});
