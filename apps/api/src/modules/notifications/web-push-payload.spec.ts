import { describe, expect, it } from 'vitest';

import {
  buildWebPushPayload,
  GENERIC_PUSH_KIND,
  pushDeepLink,
  type WebPushPayloadSource,
} from './web-push-payload';

/**
 * The payload builder against T-09 (docs/08 §2.3, ADR-028 decision 4 as amended in 4.2.5).
 *
 * The shape test pins the contract — including the `notification` block, without which
 * `ngsw-worker.js` shows nothing at all. The second test is the one that matters: it hands the builder
 * a row whose own copy is full of amounts and Merchant names and asserts that **every string in the
 * serialised payload** is one of the things this file itself decided. It is written against the values
 * the builder may emit rather than against a list of payload keys, so a field added later still has to
 * be innocuous.
 */
describe('the web-push payload (T-09, ADR-028 decision 4)', () => {
  const APP_NAME = 'Ostava';
  const base: WebPushPayloadSource = {
    id: '01920000-0000-7000-8000-000000000001',
    title: 'ignored',
    body: 'ignored',
    insightKind: 'BUDGET_PACE',
  };

  /** Every string anywhere in a JSON value, so a nested field cannot hide from the assertions. */
  function stringsIn(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(stringsIn);
    if (typeof value === 'object' && value !== null) {
      return Object.values(value).flatMap(stringsIn);
    }
    return [];
  }

  it('carries the minimal block plus the ngsw notification block', () => {
    const payload = JSON.parse(buildWebPushPayload(base, APP_NAME)) as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual([
      'deepLink',
      'kind',
      'notification',
      'notificationId',
    ]);
    expect(payload).toEqual({
      notificationId: base.id,
      kind: 'BUDGET_PACE',
      deepLink: '/budgets',
      // `ngsw-worker.js`'s `Driver.handlePush` returns before `showNotification` unless
      // `data.notification.title` exists, so this block is the difference between a push and nothing.
      notification: {
        title: APP_NAME,
        data: {
          onActionClick: {
            default: { operation: 'navigateLastFocusedOrOpen', url: '/budgets' },
          },
        },
      },
    });
  });

  it('carries no amount and no name, however loud the row is', () => {
    const row: WebPushPayloadSource = {
      id: '01920000-0000-7000-8000-000000000002',
      title: 'Budget overrun ahead: Supermarket',
      body: 'Projected 45,000.00 RSD against a 10,000.00 limit — 35,000.00 over at Lidl.',
      insightKind: 'BUDGET_PACE',
    };

    const serialised = buildWebPushPayload(row, APP_NAME);
    const payload = JSON.parse(serialised) as Record<string, unknown>;

    // The whole point: the id, the kind, the deep link, the brand and the ngsw click literal are the
    // only strings that may exist. `row.title`/`row.body` are not among the allowed values, so no
    // future field can carry them either.
    const allowed = new Set([
      row.id,
      'BUDGET_PACE',
      '/budgets',
      APP_NAME,
      'navigateLastFocusedOrOpen',
    ]);
    for (const value of stringsIn(payload)) {
      expect(allowed.has(value), `unexpected string in the payload: ${value}`).toBe(true);
    }

    for (const secret of ['Supermarket', 'Lidl', 'RSD', '45,000', '10000']) {
      expect(serialised).not.toContain(secret);
    }
    // Nothing numeric at all once the row's own id is set aside, which is T-09's own test shape.
    expect(/\d/.test(serialised.replaceAll(row.id, ''))).toBe(false);
  });

  it('falls back to the client\'s generic sentence when there is no insight behind the row', () => {
    const payload = JSON.parse(
      buildWebPushPayload({ ...base, insightKind: null }, APP_NAME),
    ) as Record<string, unknown>;
    expect(payload['kind']).toBe(GENERIC_PUSH_KIND);
    expect(payload['deepLink']).toBe('/notifications');
  });

  it('routes every kind exactly as the client\'s own deepLinkFor does, plus the no-insight case', () => {
    expect(pushDeepLink('BUDGET_PACE')).toBe('/budgets');
    expect(pushDeepLink('CATEGORY_SPIKE')).toBe('/transactions');
    expect(pushDeepLink('UNUSUAL_SPEND')).toBe('/transactions');
    expect(pushDeepLink('RECURRING_DUE')).toBe('/recurring');
    // The client's own fallback for a kind it has no screen for (notifications.view.ts). Two mappings
    // for one navigation is a divergence waiting to happen, so this asserts the server agrees with the
    // shipped one rather than inventing a second answer.
    expect(pushDeepLink('POSITIVE_TREND')).toBe('/transactions');
    // The one case the client cannot express: no insight at all, where a service worker must still open
    // something and the centre is where that row lives.
    expect(pushDeepLink(GENERIC_PUSH_KIND)).toBe('/notifications');
  });

  it('sends the click to the same place it sends the payload', () => {
    for (const kind of ['BUDGET_PACE', 'CATEGORY_SPIKE', 'RECURRING_DUE'] as const) {
      const payload = JSON.parse(
        buildWebPushPayload({ ...base, insightKind: kind }, APP_NAME),
      ) as {
        deepLink: string;
        notification: { data: { onActionClick: { default: { url: string } } } };
      };
      expect(payload.notification.data.onActionClick.default.url).toBe(payload.deepLink);
    }
  });
});
