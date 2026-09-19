/**
 * Theme preference: the pure half.
 *
 * The app shipped a `:root[data-theme='light']` token block from task 0.8 and **nothing ever wrote the
 * attribute**, so every screen was dark in every context — including the light-theme audits, which had
 * to set it by hand in a browser. ADR-039 makes the light theme a real, user-reachable state and this
 * module is the rule half of it: what a stored value may be, what a preference resolves to, and what
 * the toggle does next. No Angular, so it is testable without a DOM.
 *
 * @module apps/web/src/app/core/theme
 */

/** What the person chose. `system` is the default and follows `prefers-color-scheme`. */
export type ThemePreference = 'system' | 'light' | 'dark';

/** What is actually painted. Only two values, because a browser has no third one. */
export type ResolvedTheme = 'light' | 'dark';

/** One key, one value: `'system' | 'light' | 'dark'`. Shared with the pre-paint script in index.html. */
export const THEME_STORAGE_KEY = 'fm.theme';

/** The default when nothing is stored — see {@link resolveTheme} for what it means with no OS signal. */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';

/**
 * The browser chrome colour per theme.
 *
 * These are `--color-bg` values, duplicated here because `<meta name="theme-color">` is read by the
 * browser before any stylesheet is applied and cannot reference a custom property. `styles.tokens.spec.ts`
 * asserts that the two dark/light values still equal the token they mirror, so this pair cannot drift.
 */
export const THEME_COLOR: Readonly<Record<ResolvedTheme, string>> = {
  dark: '#0a0e18',
  light: '#f4f6fb',
};

/**
 * A stored value, or the default.
 *
 * Anything unrecognised — a value from a future version, a hand-edited string, `"null"` — falls back to
 * the default rather than throwing. The theme is not worth a broken boot, and the fallback is the same
 * thing a first-time visitor gets.
 */
export function parseThemePreference(raw: string | null | undefined): ThemePreference {
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : DEFAULT_THEME_PREFERENCE;
}

/**
 * What a preference paints.
 *
 * `system` follows the OS. With **no** OS signal (`no-preference`, which a desktop browser only reports
 * when it genuinely has nothing to say) it resolves to **dark**, because this is a money app used in the
 * evening and dark-first is the house default (docs/07 §3).
 */
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean | null): ResolvedTheme {
  if (preference !== 'system') return preference;
  return systemPrefersDark === false ? 'light' : 'dark';
}

/**
 * The other theme.
 *
 * The topbar control is one button, so it can only mean "the other one" — which is also the only
 * reading a sun/moon icon supports. Choosing `system` explicitly is `/settings`' job, where three
 * options can be labelled.
 */
export function nextTheme(current: ResolvedTheme): ResolvedTheme {
  return current === 'dark' ? 'light' : 'dark';
}

/**
 * Whether the OS light/dark preference applies, given a stored preference.
 *
 * Exposed because the service has to attach and detach its `matchMedia` listener: a listener that stays
 * attached while the preference is `light` is how a person who chose light gets flipped to dark at
 * sunset.
 */
export function followsSystem(preference: ThemePreference): boolean {
  return preference === 'system';
}
