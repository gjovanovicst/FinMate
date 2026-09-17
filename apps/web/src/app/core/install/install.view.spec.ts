import { describe, expect, it } from 'vitest';

import {
  EMPTY_INSTALL_STATE,
  INSTALL_STORAGE_KEY,
  INSTALL_SUPPRESSION_DAYS,
  INSTALL_TRIGGER_CAPTURES,
  installPromptKind,
  isSuppressed,
  parseInstallState,
  platformOf,
  serialiseInstallState,
  type InstallOfferFacts,
  type InstallState,
} from './install.view';

/**
 * The install funnel's gates (docs/07 §4.7, task 4.3.2b).
 *
 * This is the part of the feature that cannot be checked by looking at a phone: whether the sheet is
 * offered on the second capture and not the first, never during onboarding, never to an installed app,
 * never again after an unanswered offer, and not for thirty days after a dismissal. Each row of §4.7's
 * table is one assertion below.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-17T10:00:00.000Z');

function facts(overrides: Partial<InstallOfferFacts> = {}): InstallOfferFacts {
  return {
    standalone: false,
    ios: false,
    hasNativePrompt: false,
    onboarding: false,
    state: { ...EMPTY_INSTALL_STATE, captures: INSTALL_TRIGGER_CAPTURES },
    now: NOW,
    ...overrides,
  };
}

function state(overrides: Partial<InstallState> = {}): InstallState {
  return { ...EMPTY_INSTALL_STATE, captures: INSTALL_TRIGGER_CAPTURES, ...overrides };
}

describe('installPromptKind', () => {
  it('offers nothing on the first capture, and the native sheet on the second', () => {
    // §4.7: "After the **2nd** confirmed capture, never on first load".
    expect(installPromptKind(facts({ hasNativePrompt: true }))).toBe('NATIVE');
    expect(installPromptKind(facts({ hasNativePrompt: true, state: state({ captures: 1 }) }))).toBeNull();
    expect(installPromptKind(facts({ hasNativePrompt: true, state: state({ captures: 0 }) }))).toBeNull();
  });

  it('gives iOS the instructional sheet when there is no API to call', () => {
    // Safari has no `beforeinstallprompt`, so the platform is the whole signal.
    expect(installPromptKind(facts({ ios: true }))).toBe('IOS_INSTRUCTIONS');
    // …but a native prompt wins where both are true, because it can actually install the app.
    expect(installPromptKind(facts({ ios: true, hasNativePrompt: true }))).toBe('NATIVE');
  });

  it('asks nothing where it has neither an API nor instructions that would work', () => {
    // Firefox and desktop Safari: no prompt, no iOS menu. Instructions for a menu that does not exist
    // would be worse than silence.
    expect(installPromptKind(facts())).toBeNull();
  });

  it('never offers to an app that is already installed or running standalone', () => {
    // §4.7's third row, and it beats every other gate: there is nothing left to offer.
    expect(installPromptKind(facts({ hasNativePrompt: true, standalone: true }))).toBeNull();
    expect(installPromptKind(facts({ hasNativePrompt: true, state: state({ installed: true }) }))).toBeNull();
  });

  it('never prompts during onboarding', () => {
    // §4.7's prose: "never prompt during onboarding (F-13)".
    expect(installPromptKind(facts({ hasNativePrompt: true, onboarding: true }))).toBeNull();
  });

  it('does not repeat an offer that was never answered', () => {
    // Offered once and left alone: asking again on every capture is nagging, and it is exactly what a
    // boolean `shown` would have produced. Not even thirty days later — unanswered is unanswered.
    const offeredAt = new Date(NOW - 90 * DAY).toISOString();
    expect(installPromptKind(facts({ hasNativePrompt: true, state: state({ offeredAt }) }))).toBeNull();
  });

  it('stays quiet for 30 days after a dismissal and comes back after that', () => {
    const dismissedAt = new Date(NOW - 5 * DAY).toISOString();
    expect(installPromptKind(facts({ ios: true, state: state({ dismissedAt } ) }))).toBeNull();
    // Dismissed while a previous offer was on screen: the dismissal is the rule, not `offeredAt`.
    expect(
      installPromptKind(facts({ ios: true, state: state({ dismissedAt, offeredAt: new Date(NOW - 5 * DAY).toISOString() }) })),
    ).toBeNull();

    const old = new Date(NOW - (INSTALL_SUPPRESSION_DAYS + 1) * DAY).toISOString();
    expect(
      installPromptKind(facts({ ios: true, state: state({ dismissedAt: old, offeredAt: old }) })),
    ).toBe('IOS_INSTRUCTIONS');
  });
});

describe('isSuppressed', () => {
  it('suppresses inside the window and not on the boundary', () => {
    expect(isSuppressed(new Date(NOW).toISOString(), NOW)).toBe(true);
    expect(isSuppressed(new Date(NOW - (INSTALL_SUPPRESSION_DAYS * DAY - 1)).toISOString(), NOW)).toBe(true);
    expect(isSuppressed(new Date(NOW - INSTALL_SUPPRESSION_DAYS * DAY).toISOString(), NOW)).toBe(false);
  });

  it('does not suppress on a timestamp it cannot read', () => {
    // One corrupt write must not silence the funnel for ever: the cost of asking again is one
    // dismissal, which rewrites a valid timestamp.
    expect(isSuppressed(null, NOW)).toBe(false);
    expect(isSuppressed('not a date', NOW)).toBe(false);
  });
});

describe('platformOf', () => {
  it('reports which platform the offer was shown to, which is what T3 measures', () => {
    expect(platformOf('IOS_INSTRUCTIONS')).toBe('IOS');
    expect(platformOf('NATIVE')).toBe('CHROMIUM');
  });
});

describe('parseInstallState', () => {
  it('treats an absent or unreadable record as "never asked, nothing captured"', () => {
    expect(parseInstallState(null)).toEqual(EMPTY_INSTALL_STATE);
    expect(parseInstallState('')).toEqual(EMPTY_INSTALL_STATE);
    expect(parseInstallState('{oh no')).toEqual(EMPTY_INSTALL_STATE);
    expect(parseInstallState('"a string"')).toEqual(EMPTY_INSTALL_STATE);
    expect(parseInstallState('null')).toEqual(EMPTY_INSTALL_STATE);
  });

  it('validates every field rather than trusting the JSON', () => {
    // `captures: "two"` would make the threshold comparison silently false for ever, and a garbage
    // `dismissedAt` would either suppress for ever or crash the offer — both are user-visible.
    const parsed = parseInstallState(
      JSON.stringify({
        captures: 'two',
        offeredAt: 'once',
        installed: 1,
        dismissedAt: 'yesterday',
      }),
    );
    expect(parsed).toEqual(EMPTY_INSTALL_STATE);

    expect(parseInstallState(JSON.stringify({ captures: -3 })).captures).toBe(0);
    expect(parseInstallState(JSON.stringify({ captures: 1.5 })).captures).toBe(0);
  });

  it('keeps a well-formed record, and round-trips through the serialiser', () => {
    const record = state({
      captures: 3,
      offeredAt: '2026-08-20T00:00:00.000Z',
      installed: false,
      dismissedAt: '2026-09-01T00:00:00.000Z',
    });
    expect(parseInstallState(serialiseInstallState(record))).toEqual(record);
  });

  it('stores under a versioned key, so a shape change is a rename rather than a migration', () => {
    expect(INSTALL_STORAGE_KEY).toBe('finmate.install.v1');
  });
});
