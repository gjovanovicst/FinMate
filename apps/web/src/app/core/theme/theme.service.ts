import { DestroyRef, DOCUMENT, Injectable, computed, effect, inject, signal } from '@angular/core';

import {
  DEFAULT_THEME_PREFERENCE,
  THEME_COLOR,
  THEME_STORAGE_KEY,
  followsSystem,
  nextTheme,
  parseThemePreference,
  resolveTheme,
  type ThemePreference,
} from './theme.view';

/**
 * The theme, as a signal.
 *
 * Two values are tracked, and the distinction is the whole design:
 *
 *  - **`preference`** is what the person chose — `system`, `light` or `dark` — and it is what is stored.
 *  - **`resolved`** is what is painted. `system` resolves against `prefers-color-scheme`, so the same
 *    preference can paint either theme and must be re-resolved when the OS flips at sunset.
 *
 * Only this service writes `data-theme`. Nothing else in the app may set it, because the tokens in
 * `styles.css` are the only thing that knows what a theme *is*, and a second writer is how one screen
 * ends up permanently light (ADR-039).
 *
 * The attribute is also set **before first paint** by a small script in `index.html`, so a dark-theme
 * user does not get a white flash while the bundle boots. That script and this service read the same
 * key and the same three values; `theme.view.spec.ts` pins the shape they share.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);

  private readonly stored = signal<ThemePreference>(this.read());
  /** `null` when the browser cannot answer, which {@link resolveTheme} treats as "dark". */
  private readonly systemPrefersDark = signal<boolean | null>(this.readSystem());

  readonly preference = this.stored.asReadonly();
  readonly resolved = computed(() =>
    resolveTheme(this.stored(), followsSystem(this.stored()) ? this.systemPrefersDark() : null),
  );
  /** True while the OS is in charge — `/settings` says so next to the three options. */
  readonly isSystem = computed(() => followsSystem(this.stored()));

  constructor() {
    // Attach the media listener only while it can matter, and follow it when it fires.
    this.watchSystemPreference();

    effect(() => {
      const theme = this.resolved();
      this.document.documentElement.setAttribute('data-theme', theme);
      // `color-scheme` is what makes scrollbars, form controls and the canvas behind the page follow
      // the theme. Without it a light theme still draws dark scrollbars and dark autofill.
      this.document.documentElement.style.colorScheme = theme;

      // The browser chrome (a phone's status bar, a desktop tab strip) is painted from this meta tag,
      // which cannot read a custom property: it needs the literal colour.
      this.document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', THEME_COLOR[theme]);
    });
  }

  /** Choose explicitly — `/settings`' three options. */
  set(preference: ThemePreference): void {
    this.stored.set(preference);
    this.write(preference);
  }

  /**
   * The one-button control in the topbar: flip to the other theme and remember it.
   *
   * It stores the **resolved** theme rather than `system`, because a person who taps a sun icon is
   * asking for light — leaving them on `system` would flip them back at sunset and make the button
   * look broken.
   */
  toggle(): void {
    this.set(nextTheme(this.resolved()));
  }

  private read(): ThemePreference {
    try {
      return parseThemePreference(this.document.defaultView?.localStorage.getItem(THEME_STORAGE_KEY));
    } catch {
      // A blocked storage (private mode, a locked-down profile) is not an error worth surfacing: the
      // theme simply does not persist, and the default applies on every load.
      return DEFAULT_THEME_PREFERENCE;
    }
  }

  private write(preference: ThemePreference): void {
    try {
      this.document.defaultView?.localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // Same as above: an unpersisted choice still applies for this visit.
    }
  }

  private readSystem(): boolean | null {
    const view = this.document.defaultView;
    if (view === null || typeof view.matchMedia !== 'function') return null;

    const dark = view.matchMedia('(prefers-color-scheme: dark)');
    // `no-preference` matches **neither** query, and that is the case `resolveTheme` answers with dark
    // rather than with a coin flip.
    if (!dark.matches && !view.matchMedia('(prefers-color-scheme: light)').matches) return null;
    return dark.matches;
  }

  private watchSystemPreference(): void {
    const view = this.document.defaultView;
    if (view === null || typeof view.matchMedia !== 'function') return;

    const query = view.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent): void => {
      // Recorded even while the preference is `light`: the value is only consulted when `system` is in
      // charge, and keeping it current is what makes switching back to `system` correct immediately.
      this.systemPrefersDark.set(event.matches);
    };

    // `addEventListener` rather than the deprecated `addListener`; a browser without it (older Safari)
    // simply keeps the value read at construction, which is correct until the OS changes mid-session.
    query.addEventListener?.('change', onChange);
    inject(DestroyRef).onDestroy(() => query.removeEventListener?.('change', onChange));
  }
}
