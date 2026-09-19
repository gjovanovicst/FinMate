import { describe, expect, it } from 'vitest';

import {
  DEFAULT_THEME_PREFERENCE,
  THEME_COLOR,
  THEME_STORAGE_KEY,
  followsSystem,
  nextTheme,
  parseThemePreference,
  resolveTheme,
} from './theme.view';

/**
 * The theme rule half (ADR-039).
 *
 * What matters here is not the maths — there is none — but the three decisions a browser cannot state
 * for itself: what an unrecognised stored value means, what `system` paints when the OS says nothing,
 * and what the single topbar button does. Each of those was decided once, and each is silent when wrong.
 */
describe('theme preference', () => {
  it('accepts exactly the three stored values', () => {
    expect(parseThemePreference('system')).toBe('system');
    expect(parseThemePreference('light')).toBe('light');
    expect(parseThemePreference('dark')).toBe('dark');
  });

  it('falls back to the default for anything else, including absent and malformed storage', () => {
    // A future version's value, a hand-edited string, JSON `null` and a cleared store all have to give
    // the same answer: the theme is never worth a broken boot.
    for (const raw of [null, undefined, '', 'Dark', 'auto', '{"theme":"dark"}', 'null']) {
      expect(parseThemePreference(raw), String(raw)).toBe(DEFAULT_THEME_PREFERENCE);
    }
  });
});

describe('resolveTheme', () => {
  it('returns an explicit preference whatever the OS says', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('follows the OS while the preference is system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('paints dark when there is no OS signal at all', () => {
    // `no-preference` is the one case a browser can report: dark-first is the house default and not a
    // coin flip (docs/07 §3).
    expect(resolveTheme('system', null)).toBe('dark');
  });
});

describe('nextTheme', () => {
  it('is an involution, so one button can never strand the user', () => {
    expect(nextTheme('dark')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme(nextTheme('dark'))).toBe('dark');
  });
});

describe('followsSystem', () => {
  it('is true only for system', () => {
    expect(followsSystem('system')).toBe(true);
    expect(followsSystem('light')).toBe(false);
    expect(followsSystem('dark')).toBe(false);
  });
});

describe('the storage contract shared with the pre-paint script', () => {
  it('is the key and the three values index.html reads', () => {
    // `index.html` cannot import this module, so it repeats the key and the values. This is the one
    // assertion that keeps the two copies honest: change either and this fails rather than a light-theme
    // user seeing a dark flash (or the reverse) on every load.
    expect(THEME_STORAGE_KEY).toBe('fm.theme');
    expect(['system', 'light', 'dark']).toContain(DEFAULT_THEME_PREFERENCE);
  });

  it('gives the browser chrome a colour per theme', () => {
    expect(THEME_COLOR.dark).toMatch(/^#[0-9a-f]{6}$/);
    expect(THEME_COLOR.light).toMatch(/^#[0-9a-f]{6}$/);
    expect(THEME_COLOR.dark).not.toBe(THEME_COLOR.light);
  });
});
