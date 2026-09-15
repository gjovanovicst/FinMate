import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  effectiveChannels,
  effectiveQuietHours,
  parseNotificationPreferences,
  serialiseNotificationPreferences,
} from './notification-preferences';

/**
 * Preferences decide whether a user is interrupted, and they are parsed out of a JSONB column anyone
 * could have written. Every malformed shape must land on the documented default — never on a throw,
 * and never on a *different* default than the one the product claims.
 */
describe('parseNotificationPreferences', () => {
  it('returns the defaults for anything that is not an object', () => {
    for (const raw of [null, undefined, 42, 'nonsense', []]) {
      expect(parseNotificationPreferences(raw)).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    }
    expect(DEFAULT_NOTIFICATION_PREFERENCES).toEqual({
      channels: ['IN_APP'],
      quietHours: null,
      positiveFeedback: true,
      locale: null,
    });
  });

  it('keeps well-formed fields and defaults the rest, field by field', () => {
    const parsed = parseNotificationPreferences({
      channels: ['IN_APP', 'EMAIL'],
      quietHours: { start: '21:00', end: '08:00' },
      positiveFeedback: false,
      locale: 'sr-Latn',
    });
    expect(parsed).toEqual({
      channels: ['IN_APP', 'EMAIL'],
      quietHours: { start: '21:00', end: '08:00' },
      positiveFeedback: false,
      locale: 'sr-Latn',
    });

    const partial = parseNotificationPreferences({ positiveFeedback: false });
    expect(partial.channels).toEqual(['IN_APP']);
    expect(partial.positiveFeedback).toBe(false);
  });

  it('drops unknown channels rather than passing them to a dispatcher', () => {
    const parsed = parseNotificationPreferences({ channels: ['IN_APP', 'CARRIER_PIGEON'] });
    expect(parsed.channels).toEqual(['IN_APP']);
    // And a list that is entirely unknown falls back to the default rather than to silence.
    expect(parseNotificationPreferences({ channels: ['CARRIER_PIGEON'] }).channels).toEqual(['IN_APP']);
    expect(parseNotificationPreferences({ channels: [] }).channels).toEqual(['IN_APP']);
  });

  it('ignores a malformed quiet-hours window instead of muting the user', () => {
    // An unparseable window must mean "no quiet hours": the alternative reading silently suppresses.
    expect(parseNotificationPreferences({ quietHours: { start: '9:00', end: '08:00' } }).quietHours).toBeNull();
    expect(parseNotificationPreferences({ quietHours: { start: 21, end: '08:00' } }).quietHours).toBeNull();
    expect(parseNotificationPreferences({ quietHours: 'always' }).quietHours).toBeNull();
  });
});

describe('serialiseNotificationPreferences', () => {
  it('normalises the stored document so a reader never guesses a shape', () => {
    expect(serialiseNotificationPreferences({})).toEqual({
      channels: ['IN_APP'],
      quietHours: null,
      positiveFeedback: true,
      locale: null,
    });
    expect(
      serialiseNotificationPreferences({ channels: ['EMAIL'], quietHours: { start: '22:00', end: '07:00' } }),
    ).toEqual({
      channels: ['EMAIL'],
      quietHours: { start: '22:00', end: '07:00' },
      positiveFeedback: true,
      locale: null,
    });
  });

  it('round-trips', () => {
    const input = {
      channels: ['IN_APP', 'WEB_PUSH'] as const,
      quietHours: { start: '21:00', end: '08:00' },
      positiveFeedback: false,
      locale: 'sr-Cyrl',
    };
    expect(parseNotificationPreferences(serialiseNotificationPreferences(input))).toEqual(input);
  });
});

describe('effectiveQuietHours', () => {
  it('lets a rule state its own window, and falls back to the Household preference', () => {
    const prefs = parseNotificationPreferences({ quietHours: { start: '21:00', end: '08:00' } });
    expect(effectiveQuietHours({ start: '12:00', end: '13:00' }, prefs)).toEqual({
      start: '12:00',
      end: '13:00',
    });
    expect(effectiveQuietHours(null, prefs)).toEqual({ start: '21:00', end: '08:00' });
    expect(effectiveQuietHours(null, DEFAULT_NOTIFICATION_PREFERENCES)).toBeNull();
  });
});

describe('effectiveChannels', () => {
  it('intersects and never widens', () => {
    const prefs = parseNotificationPreferences({ channels: ['IN_APP'] });
    expect(effectiveChannels(['IN_APP', 'EMAIL'], prefs)).toEqual(['IN_APP']);
    expect(effectiveChannels(['EMAIL'], prefs)).toEqual([]);
    expect(
      effectiveChannels(['IN_APP', 'EMAIL'], parseNotificationPreferences({ channels: ['IN_APP', 'EMAIL', 'PUSH'] })),
    ).toEqual(['IN_APP', 'EMAIL']);
  });
});
