import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { AuthStore } from './core/auth/auth.store';
import { I18nService } from './core/i18n/i18n.service';
import type { TranslationKey } from './core/i18n/translations';
import { LanguageSwitcherComponent } from './shared/ui/language-switcher/language-switcher.component';

interface NavItem {
  readonly path: string;
  /** A translation key, not a label: the nav re-renders when the language changes. */
  readonly labelKey: TranslationKey;
  readonly icon: string;
  /**
   * Whether the item sits in the bottom bar. Non-primary items live behind "More" on compact
   * screens (docs/02 §2 puts the library there) and are listed in full in the sidebar, so the
   * sidebar is never a reduced view of the app.
   */
  readonly primary: boolean;
}

/**
 * The application shell: navigation plus a content outlet.
 *
 * **One component, two layouts** (docs/07 §3). The navigation is the same data rendered differently
 * by size class — a bottom bar in the thumb zone on compact screens, a sidebar once there is room.
 * It is CSS that decides which, using container/media queries, so there is no JavaScript breakpoint
 * listener to desynchronise from the stylesheet.
 *
 * The nav is a `<nav>` with real links rather than buttons: keyboard navigation, middle-click and
 * "open in new tab" all work for free, and the active route is announced via `aria-current`.
 */
@Component({
  selector: 'fm-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, LanguageSwitcherComponent],
  template: `
    <a class="skip-link" href="#main">{{ i18n.t('app.skipToContent') }}</a>

    <div class="shell" [class.shell--authenticated]="isAuthenticated()">
      @if (isAuthenticated()) {
        <nav class="nav" [attr.aria-label]="i18n.t('app.primaryNav')">
          @if (moreOpen()) {
            <!-- Compact only: on wide screens the overflow items are in the sidebar already, and
                 CSS hides this panel so the same two lists never both render. -->
            <ul class="nav__more-panel">
              @for (item of overflowItems(); track item.path) {
                <li>
                  <a
                    class="nav__more-link"
                    [routerLink]="item.path"
                    routerLinkActive="nav__link--active"
                    (click)="moreOpen.set(false)"
                  >
                    <span class="nav__icon" aria-hidden="true">{{ item.icon }}</span>
                    <span>{{ i18n.t(item.labelKey) }}</span>
                  </a>
                </li>
              }
            </ul>
          }

          <ul class="nav__list">
            @for (item of items; track item.path) {
              <li class="nav__item" [class.nav__item--overflow]="!item.primary">
                <a
                  class="nav__link"
                  [routerLink]="item.path"
                  routerLinkActive="nav__link--active"
                  #rla="routerLinkActive"
                  [attr.aria-current]="rla.isActive ? 'page' : null"
                >
                  <span class="nav__icon" aria-hidden="true">{{ item.icon }}</span>
                  <span class="nav__label">{{ i18n.t(item.labelKey) }}</span>
                </a>
              </li>
            }

            @if (overflowItems().length > 0) {
              <li class="nav__item nav__item--more">
                <button
                  class="nav__link nav__link--button"
                  type="button"
                  [attr.aria-expanded]="moreOpen()"
                  (click)="moreOpen.set(!moreOpen())"
                >
                  <span class="nav__icon" aria-hidden="true">⋯</span>
                  <span class="nav__label">{{ i18n.t('nav.more') }}</span>
                </button>
              </li>
            }
          </ul>
        </nav>
      }

      <main id="main" class="content" tabindex="-1">
        <router-outlet />
      </main>

      @if (isAuthenticated()) {
        <footer class="session">
          <fm-language-switcher />
          <span class="session__role">{{ roleLabel() }}</span>
          <button type="button" class="session__signout" (click)="signOut()" [disabled]="signingOut()">
            {{ signingOut() ? i18n.t('session.signingOut') : i18n.t('session.signOut') }}
          </button>
        </footer>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        min-block-size: 100dvh;
      }

      /* Skip link: hidden until focused. Without it a keyboard user tabs the whole nav on every
         page before reaching content (WCAG 2.4.1). */
      .skip-link {
        position: absolute;
        inset-block-start: -100%;
        inset-inline-start: var(--space-4);
        z-index: 10;
        padding: var(--space-2) var(--space-4);
        background: var(--color-primary);
        color: var(--color-primary-contrast);
        border-radius: var(--radius-sm);
        text-decoration: none;
      }
      .skip-link:focus {
        inset-block-start: var(--space-4);
      }

      .shell {
        display: grid;
        grid-template-rows: 1fr;
        min-block-size: 100dvh;
      }

      /* ---- authenticated layout: bottom nav on compact, sidebar from 1024px ---- */
      .shell--authenticated {
        grid-template-rows: 1fr auto;
      }

      .content {
        padding: var(--space-4);
        /* Safe areas: the notch and the home indicator must not eat content (docs/07 §3). */
        padding-block-end: calc(var(--space-4) + env(safe-area-inset-bottom));
        outline: none;
      }

      .nav {
        order: 2;
        background: var(--color-surface);
        border-block-start: 1px solid var(--color-border);
        padding-block-end: env(safe-area-inset-bottom);
      }
      .nav__list {
        display: flex;
        justify-content: space-around;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .nav__link {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--space-1);
        padding: var(--space-2) var(--space-3);
        color: var(--color-text-muted);
        font-size: var(--text-xs);
        text-decoration: none;
      }
      .nav__link--active {
        color: var(--color-primary);
      }
      .nav__icon {
        font-size: 1.25rem;
        line-height: 1;
      }
      .nav__link--button {
        font: inherit;
        font-size: var(--text-xs);
        background: none;
        border: none;
        cursor: pointer;
      }
      /* Overflow items are in the sidebar on wide screens and behind "More" on compact ones. */
      .nav__item--overflow,
      .nav__more-panel {
        display: none;
      }
      .nav__more-panel {
        position: absolute;
        inset-block-end: 100%;
        inset-inline-end: var(--space-2);
        min-inline-size: 12rem;
        margin: 0 0 var(--space-2);
        padding: var(--space-2);
        list-style: none;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
      }
      .nav__more-panel {
        display: grid;
        gap: var(--space-1);
      }
      .nav__more-link {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        padding: var(--space-2);
        color: var(--color-text);
        font-size: var(--text-sm);
        text-decoration: none;
        border-radius: var(--radius-sm);
      }
      .nav {
        position: relative;
      }

      .session {
        order: 3;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        padding: var(--space-2) var(--space-4);
        background: var(--color-surface);
        border-block-start: 1px solid var(--color-border);
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
      }
      .session__signout {
        background: none;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        color: var(--color-text-muted);
        padding: var(--space-1) var(--space-3);
        font: inherit;
        cursor: pointer;
      }
      .session__signout:hover:not(:disabled) {
        color: var(--color-text);
        border-color: var(--color-text-muted);
      }
      .session__signout:disabled {
        opacity: 0.6;
        cursor: default;
      }

      /* ---- expanded: sidebar, vertical nav, sign-out at the bottom ---- */
      @media (min-width: 1024px) {
        .shell--authenticated {
          grid-template-columns: 240px 1fr;
          grid-template-rows: 1fr auto;
          grid-template-areas:
            'nav content'
            'nav session';
        }
        .nav {
          grid-area: nav;
          order: initial;
          border-block-start: none;
          border-inline-end: 1px solid var(--color-border);
          padding-block: var(--space-5);
        }
        .nav__item--overflow {
          display: block;
        }
        .nav__item--more,
        .nav__more-panel {
          display: none;
        }
        .nav__list {
          flex-direction: column;
          gap: var(--space-1);
          padding-inline: var(--space-3);
        }
        .nav__link {
          flex-direction: row;
          justify-content: flex-start;
          gap: var(--space-3);
          font-size: var(--text-sm);
          padding: var(--space-3);
          border-radius: var(--radius-md);
        }
        .nav__link--active {
          background: color-mix(in srgb, var(--color-primary) 14%, transparent);
        }
        .content {
          grid-area: content;
          padding: var(--space-6);
          max-inline-size: 1200px;
        }
        .session {
          grid-area: session;
          border-block-start: none;
          padding-inline: var(--space-6);
        }
      }
    `,
  ],
})
export class AppComponent {
  private readonly auth = inject(AuthStore);
  readonly i18n = inject(I18nService);

  readonly isAuthenticated = this.auth.isAuthenticated;

  /**
   * Roles are shown as words, not enum values. The role itself comes from the server (never a token
   * claim), and only the label is localised.
   */
  readonly roleLabel = computed(() => {
    const role = this.auth.role();
    return role ? this.i18n.t(`role.${role}` as TranslationKey) : this.i18n.t('role.unknown');
  });
  readonly signingOut = signal(false);

  /**
   * Every destination here is a working screen. The rest of docs/02 §2 (Capture, Review, Insights)
   * lands with the features themselves — an empty nav item that leads to "coming soon" is worse
   * than no item, because it teaches the user that the app is incomplete.
   *
   * Budgets sits before Accounts because it is the screen that produces the product's headline
   * number; Accounts is setup the user visits once.
   */
  readonly items: readonly NavItem[] = [
    { path: '/', labelKey: 'nav.dashboard', icon: '📊', primary: true },
    { path: '/transactions', labelKey: 'nav.transactions', icon: '🧾', primary: true },
    { path: '/budgets', labelKey: 'nav.budgets', icon: '🎯', primary: true },
    { path: '/accounts', labelKey: 'nav.accounts', icon: '🏦', primary: true },
    { path: '/categories', labelKey: 'nav.categories', icon: '🗂️', primary: false },
  ];

  /**
   * Five destinations do not fit a 320 px bottom bar with readable labels, and the spec's own
   * information architecture puts the library behind "Više" (docs/02 §2). The overflow set grows
   * here rather than by shrinking every label into an abbreviation.
   */
  readonly overflowItems = computed(() => this.items.filter((item) => !item.primary));
  readonly moreOpen = signal(false);

  async signOut(): Promise<void> {
    this.signingOut.set(true);
    try {
      await this.auth.signOut();
    } finally {
      this.signingOut.set(false);
    }
  }
}
