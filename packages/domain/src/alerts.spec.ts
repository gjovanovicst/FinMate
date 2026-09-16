import { describe, expect, it } from 'vitest';

import {
  alertKindForInsight,
  evaluateAlerts,
  isQuietHour,
  notificationDedupeKey,
  MAX_NOTIFICATIONS_PER_DAY,
  type AlertCandidate,
  type AlertEvaluationInput,
  type AlertRuleFact,
} from './alerts';

/**
 * The evaluator decides whether the product speaks, so every veto is asserted on both sides of its
 * boundary — including the one that is invisible when wrong (an inverted quiet-hours window mutes the
 * app during the day and alerts at 3 a.m.).
 */

function candidate(overrides: Partial<AlertCandidate> = {}): AlertCandidate {
  return {
    insightId: 'insight-1',
    dedupeKey: 'BUDGET_PACE:2026-09-01:budget-1',
    kind: 'BUDGET_PACE',
    severity: 'WARNING',
    periodStart: '2026-09-01',
    alertKind: 'PACE_OVERRUN',
    ...overrides,
  };
}

function rule(overrides: Partial<AlertRuleFact> = {}): AlertRuleFact {
  return {
    id: 'rule-1',
    kind: 'PACE_OVERRUN',
    channels: ['IN_APP'],
    quietHours: null,
    isActive: true,
    ...overrides,
  };
}

function input(overrides: Partial<AlertEvaluationInput> = {}): AlertEvaluationInput {
  return {
    candidates: [candidate()],
    rules: [rule()],
    localTime: '12:00',
    sentDedupeKeys: new Set<string>(),
    sentInLastDay: 0,
    positiveFeedback: true,
    ...overrides,
  };
}

describe('notificationDedupeKey', () => {
  it('names the condition and the channel, not just the insight', () => {
    expect(notificationDedupeKey('BUDGET_PACE:2026-09-01:budget-1', 'IN_APP')).toBe(
      'BUDGET_PACE:2026-09-01:budget-1:IN_APP',
    );
    // Two channels are two deliveries: an in-app row does not mean the email was sent.
    expect(notificationDedupeKey('k', 'IN_APP')).not.toBe(notificationDedupeKey('k', 'EMAIL'));
  });
});

describe('isQuietHour', () => {
  it('handles a window that crosses midnight', () => {
    const night = { start: '21:00', end: '08:00' };
    expect(isQuietHour('22:30', night)).toBe(true);
    expect(isQuietHour('03:00', night)).toBe(true);
    expect(isQuietHour('07:59', night)).toBe(true);
    // The failure an inverted comparison produces: daytime would be muted instead.
    expect(isQuietHour('08:00', night)).toBe(false);
    expect(isQuietHour('12:00', night)).toBe(false);
    expect(isQuietHour('20:59', night)).toBe(false);
    expect(isQuietHour('21:00', night)).toBe(true);
  });

  it('handles a same-day window', () => {
    const lunch = { start: '12:00', end: '13:00' };
    expect(isQuietHour('12:30', lunch)).toBe(true);
    expect(isQuietHour('11:59', lunch)).toBe(false);
    expect(isQuietHour('13:00', lunch)).toBe(false);
  });

  it('treats an empty window as no quiet hours, not as all day', () => {
    // A user who sets both ends to 00:00 means "never quiet"; reading it as "always" would silently
    // switch every alert off, which is the worst possible failure of this function.
    expect(isQuietHour('00:00', { start: '00:00', end: '00:00' })).toBe(false);
    expect(isQuietHour('13:37', { start: '00:00', end: '00:00' })).toBe(false);
  });
});

describe('alertKindForInsight', () => {
  it('maps the insight kinds that have a producer', () => {
    expect(alertKindForInsight('BUDGET_PACE')).toBe('PACE_OVERRUN');
    expect(alertKindForInsight('CATEGORY_SPIKE')).toBe('UNUSUAL_SPEND');
    expect(alertKindForInsight('UNUSUAL_SPEND')).toBe('UNUSUAL_SPEND');
    // A bill due soon is its own intention, so it gets its own switch rather than riding on UNUSUAL_SPEND.
    expect(alertKindForInsight('RECURRING_DUE')).toBe('RECURRING_DUE');
  });

  it('returns null for a kind no rule governs, rather than guessing one', () => {
    expect(alertKindForInsight('POSITIVE_TREND')).toBeNull();
    expect(alertKindForInsight('SOMETHING_NEW')).toBeNull();
  });
});

describe('evaluateAlerts', () => {
  it('delivers an eligible candidate on its configured channels', () => {
    const decisions = evaluateAlerts(input({ rules: [rule({ channels: ['IN_APP', 'EMAIL'] })] }));
    expect(decisions.map((decision) => [decision.channel, decision.status])).toEqual([
      ['IN_APP', 'SENT'],
      ['EMAIL', 'SENT'],
    ]);
    expect(decisions.every((decision) => decision.reason === 'DELIVER')).toBe(true);
  });

  it('queues during quiet hours instead of dropping', () => {
    const decisions = evaluateAlerts(
      input({ rules: [rule({ quietHours: { start: '21:00', end: '08:00' } })], localTime: '23:15' }),
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.status).toBe('QUEUED');
    expect(decisions[0]?.reason).toBe('QUIET_HOURS');
  });

  it('suppresses a condition it has already sent, and does not spend the day allowance on it', () => {
    const decisions = evaluateAlerts(
      input({
        sentDedupeKeys: new Set(['BUDGET_PACE:2026-09-01:budget-1:IN_APP']),
        sentInLastDay: MAX_NOTIFICATIONS_PER_DAY,
      }),
    );
    expect(decisions[0]?.reason).toBe('DUPLICATE');
    expect(decisions[0]?.status).toBe('SUPPRESSED');

    // The second candidate in the same run is still rate-limited by the pre-existing count, which
    // proves the duplicate did not increment it.
    const two = evaluateAlerts(
      input({
        candidates: [candidate(), candidate({ insightId: 'insight-2', dedupeKey: 'OTHER:2026-09-01:x' })],
        sentDedupeKeys: new Set(['BUDGET_PACE:2026-09-01:budget-1:IN_APP']),
        sentInLastDay: MAX_NOTIFICATIONS_PER_DAY,
      }),
    );
    expect(two.map((decision) => decision.reason)).toEqual(['DUPLICATE', 'RATE_LIMITED']);
  });

  it('rate-limits at the cap, but never a CRITICAL', () => {
    const atCap = evaluateAlerts(input({ sentInLastDay: MAX_NOTIFICATIONS_PER_DAY }));
    expect(atCap[0]?.reason).toBe('RATE_LIMITED');
    expect(atCap[0]?.status).toBe('SUPPRESSED');

    const oneBelow = evaluateAlerts(input({ sentInLastDay: MAX_NOTIFICATIONS_PER_DAY - 1 }));
    expect(oneBelow[0]?.reason).toBe('DELIVER');

    const critical = evaluateAlerts(
      input({ candidates: [candidate({ severity: 'CRITICAL' })], sentInLastDay: 99 }),
    );
    expect(critical[0]?.reason).toBe('DELIVER');
  });

  it('stops counting once the cap is reached within a single run', () => {
    const candidates = Array.from({ length: MAX_NOTIFICATIONS_PER_DAY + 3 }, (_, index) =>
      candidate({ insightId: `insight-${index}`, dedupeKey: `BUDGET_PACE:2026-09-01:budget-${index}` }),
    );
    const decisions = evaluateAlerts(input({ candidates }));
    const delivered = decisions.filter((decision) => decision.status === 'SENT');
    const limited = decisions.filter((decision) => decision.reason === 'RATE_LIMITED');
    expect(delivered).toHaveLength(MAX_NOTIFICATIONS_PER_DAY);
    expect(limited).toHaveLength(3);
  });

  it('respects a switched-off rule and a missing one', () => {
    expect(evaluateAlerts(input({ rules: [rule({ isActive: false })] }))[0]?.reason).toBe('RULE_INACTIVE');
    expect(evaluateAlerts(input({ rules: [] }))[0]?.reason).toBe('RULE_INACTIVE');
  });

  it('keeps a positive insight in-app only, and honours the preference', () => {
    const positive = candidate({ severity: 'POSITIVE', kind: 'POSITIVE_TREND', alertKind: 'PACE_OVERRUN' });
    const decisions = evaluateAlerts(
      input({ candidates: [positive], rules: [rule({ channels: ['IN_APP', 'EMAIL', 'WEB_PUSH'] })] }),
    );
    expect(decisions.map((decision) => decision.channel)).toEqual(['IN_APP']);
    expect(decisions[0]?.reason).toBe('DELIVER');

    const off = evaluateAlerts(input({ candidates: [positive], positiveFeedback: false }));
    expect(off[0]?.reason).toBe('POSITIVE_DISABLED');
    expect(off[0]?.status).toBe('SUPPRESSED');
  });

  it('collapses a duplicated channel in a rule instead of colliding with itself', () => {
    const decisions = evaluateAlerts(input({ rules: [rule({ channels: ['IN_APP', 'IN_APP'] })] }));
    expect(decisions).toHaveLength(1);
  });

  it('is deterministic: the same input gives the same decisions in the same order', () => {
    const candidates = [
      candidate({ insightId: 'b', dedupeKey: 'B:2026-09-01:2' }),
      candidate({ insightId: 'a', dedupeKey: 'A:2026-09-01:1' }),
    ];
    const first = evaluateAlerts(input({ candidates }));
    const second = evaluateAlerts(input({ candidates }));
    expect(first.map((decision) => decision.insightId)).toEqual(['a', 'b']);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('is silent on no candidates rather than throwing', () => {
    expect(evaluateAlerts(input({ candidates: [] }))).toEqual([]);
  });
});
