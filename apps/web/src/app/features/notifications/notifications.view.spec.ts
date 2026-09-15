import { describe, expect, it } from 'vitest';

import {
  CONFIGURABLE_KINDS,
  channelLabelKey,
  deepLinkFor,
  isUnread,
  kindLabelKey,
  notificationBadge,
  notificationBadgeName,
  preferencesInput,
  quietHoursProblem,
  ruleUpdateInput,
  severityLabelKey,
  statusLabelKey,
  toneFor,
  unreadCount,
  visibleRows,
  type NotificationRow,
} from './notifications.view';

/**
 * The screen's decisions. Two of them are silent when wrong: a deep link that goes nowhere (the row
 * looks clickable and does nothing) and a quiet-hours window the API stores as "never quiet" while the
 * user believes the opposite.
 */

function row(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: 'n1',
    insightId: 'i1',
    insightKind: 'BUDGET_PACE',
    insightSeverity: 'WARNING',
    channel: 'IN_APP',
    title: 'Budget overrun ahead: Hrana',
    body: 'Projected 600.00 against a 100.00 limit — 500.00 over.',
    status: 'SENT',
    sentAt: '2026-09-20T08:00:00.000Z',
    readAt: null,
    createdAt: '2026-09-20T08:00:00.000Z',
    ...overrides,
  };
}

describe('unread', () => {
  it('counts a row as unread until it is marked read', () => {
    expect(isUnread(row())).toBe(true);
    expect(isUnread(row({ readAt: '2026-09-20T09:00:00.000Z' }))).toBe(false);
    expect(unreadCount([row(), row({ id: 'n2', readAt: '2026-09-20T09:00:00.000Z' })])).toBe(1);
    expect(unreadCount([])).toBe(0);
  });

  it('filters to unread only when asked', () => {
    const rows = [row(), row({ id: 'n2', readAt: '2026-09-20T09:00:00.000Z' })];
    expect(visibleRows(rows, { unreadOnly: false })).toHaveLength(2);
    expect(visibleRows(rows, { unreadOnly: true }).map((entry) => entry.id)).toEqual(['n1']);
  });
});

describe('notificationBadge', () => {
  it('follows the shell rule: hidden at 0, literal to 9, 9+ above', () => {
    expect(notificationBadge(0)).toBe('');
    expect(notificationBadge(3)).toBe('3');
    expect(notificationBadge(9)).toBe('9');
    expect(notificationBadge(10)).toBe('9+');
    expect(notificationBadgeName(0, 'one', 'many')).toBeNull();
    expect(notificationBadgeName(3, 'one', 'many')).toBe('many');
    expect(notificationBadgeName(1, 'one', 'many')).toBe('one');
  });
});

describe('deepLinkFor', () => {
  it('sends a budget insight to the budgets screen and a spend insight to the ledger', () => {
    expect(deepLinkFor('BUDGET_PACE')).toBe('/budgets');
    expect(deepLinkFor('CATEGORY_SPIKE')).toBe('/transactions');
    expect(deepLinkFor('UNUSUAL_SPEND')).toBe('/transactions');
  });

  it('returns null rather than a link to nowhere when the kind is unknown', () => {
    expect(deepLinkFor(null)).toBeNull();
  });
});

describe('toneFor', () => {
  it('gives POSITIVE its own tone, never a shade of INFO', () => {
    expect(toneFor('POSITIVE')).toBe('positive');
    expect(toneFor('INFO')).toBe('info');
    expect(toneFor('WARNING')).toBe('warning');
    expect(toneFor('CRITICAL')).toBe('critical');
  });
});

describe('label keys', () => {
  it('maps every value to a translation key rather than a literal', () => {
    expect(severityLabelKey('CRITICAL')).toBe('notifications.severity.CRITICAL');
    expect(statusLabelKey('QUEUED')).toBe('notifications.status.QUEUED');
    expect(channelLabelKey('WEB_PUSH')).toBe('notifications.channel.WEB_PUSH');
    expect(kindLabelKey('PACE_OVERRUN')).toBe('notifications.kind.PACE_OVERRUN');
    // An unknown kind still gets a label, so the list cannot render a raw enum.
    expect(kindLabelKey('GOAL_REACHED')).toBe('notifications.kind.unknown');
    expect(CONFIGURABLE_KINDS).not.toContain('GOAL_REACHED');
  });
});

describe('quietHoursProblem', () => {
  it('accepts a valid window, including one that crosses midnight', () => {
    expect(quietHoursProblem({ enabled: true, start: '21:00', end: '08:00' })).toBeNull();
    expect(quietHoursProblem({ enabled: false, start: '', end: '' })).toBeNull();
  });

  it('flags a malformed time on the field it belongs to', () => {
    expect(quietHoursProblem({ enabled: true, start: '9:00', end: '08:00' })).toBe('start');
    expect(quietHoursProblem({ enabled: true, start: '21:00', end: '24:00' })).toBe('end');
  });

  it('refuses equal ends, because the API stores that as "never quiet"', () => {
    // Silently unprotected is the worst outcome: the user believes they set quiet hours.
    expect(quietHoursProblem({ enabled: true, start: '22:00', end: '22:00' })).toBe('same');
  });
});

describe('preferencesInput', () => {
  const base = {
    channels: ['IN_APP', 'EMAIL'] as const,
    quietHours: { enabled: true, start: '21:00', end: '08:00' },
    positiveFeedback: true,
    locale: 'sr-Latn',
  };

  it('builds the mutation input from a valid form', () => {
    expect(preferencesInput(base)).toEqual({
      channels: ['IN_APP', 'EMAIL'],
      quietHours: { start: '21:00', end: '08:00' },
      positiveFeedback: true,
      locale: 'sr-Latn',
    });
  });

  it('refuses to save an invalid window instead of storing a window that does nothing', () => {
    expect(preferencesInput({ ...base, quietHours: { enabled: true, start: '21:00', end: '21:00' } })).toBeNull();
  });

  it('keeps IN_APP as the floor when the user unticks every channel', () => {
    const input = preferencesInput({ ...base, channels: [] });
    expect(input?.channels).toEqual(['IN_APP']);
  });

  it('sends null quiet hours when the switch is off', () => {
    const input = preferencesInput({ ...base, quietHours: { enabled: false, start: '21:00', end: '08:00' } });
    expect(input?.quietHours).toBeNull();
  });
});

describe('ruleUpdateInput', () => {
  it('sends only the fields that changed', () => {
    const rule = {
      id: 'r1',
      kind: 'PACE_OVERRUN',
      channels: ['IN_APP'] as const,
      quietHours: null,
      isActive: true,
    };
    expect(ruleUpdateInput(rule, { isActive: false })).toEqual({ id: 'r1', isActive: false });
    expect(ruleUpdateInput(rule, { channels: ['IN_APP', 'EMAIL'] })).toEqual({
      id: 'r1',
      channels: ['IN_APP', 'EMAIL'],
    });
  });
});
