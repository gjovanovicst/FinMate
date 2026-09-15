import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';

import { AuthStore } from './core/auth/auth.store';
import { I18nService } from './core/i18n/i18n.service';
import type { TranslationKey } from './core/i18n/translations';
import { NAV_ITEMS, OVERFLOW_ITEMS, badgeAccessibleName, badgeText } from './core/navigation';
import { ReviewQueueStore } from './core/review/review-queue.store';
import { LanguageSwitcherComponent } from './shared/ui/language-switcher/language-switcher.component';

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
 *
 * The destinations and their primary/overflow split live in `core/navigation.ts`, because that split
 * is docs/02 §2's information architecture rather than styling — see the module header there.
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
              @for (item of overflowItems; track item.path) {
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
                  [attr.aria-label]="item.badged ? badgeName() : null"
                >
                  <span class="nav__icon" aria-hidden="true">
                    {{ item.icon }}
                    <!-- docs/02 §2.3: hidden at 0. The badge is decoration for a sighted reader; the
                         aria-label above carries the count to a screen reader. -->
                    @if (item.badged && badge() !== '') {
                      <span class="nav__badge">{{ badge() }}</span>
                    }
                  </span>
                  <span class="nav__label">{{ i18n.t(item.labelKey) }}</span>
                </a>
              </li>
            }

            @if (overflowItems.length > 0) {
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
      /* flex: 1 1 0 with min-inline-size: 0 is what stops five items overflowing a 320 px bar:
         flex items refuse to shrink below their content width by default, so one long word
         ("Transactions") would push the whole page into horizontal scroll. */
      .nav__item {
        flex: 1 1 0;
        min-inline-size: 0;
      }
      .nav__link {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--space-1);
        padding: var(--space-2) var(--space-1);
        color: var(--color-text-muted);
        font-size: var(--text-xs);
        text-decoration: none;
        min-inline-size: 0;
        inline-size: 100%;
      }
      .nav__label {
        text-align: center;
        /* anywhere rather than break-word: only anywhere reduces the element's min-content
           width, which is the number the flex algorithm actually respects. */
        overflow-wrap: anywhere;
        line-height: 1.15;
      }
      .nav__link--active {
        color: var(--color-primary);
      }
      .nav__icon {
        position: relative;
        font-size: 1.25rem;
        line-height: 1;
      }
      /* docs/02 section 2.3: hidden at 0 (the span is not rendered), the literal count up to nine,
         then "9+" above. Positioned against the glyph so the label underneath never shifts when the
         count appears. */
      .nav__badge {
        position: absolute;
        inset-block-start: -0.35rem;
        inset-inline-start: 0.85rem;
        min-inline-size: 1.1rem;
        padding: 0 0.25rem;
        font-size: 0.65rem;
        line-height: 1.1rem;
        text-align: center;
        color: var(--color-primary-contrast);
        background: var(--color-danger);
        border-radius: var(--radius-lg);
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
  private readonly router = inject(Router);
  private readonly reviewQueue = inject(ReviewQueueStore);
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
   * docs/02 §2.2's five slots: four primary destinations plus **More**. The full list is rendered in
   * one `<ul>` and CSS decides — the overflow items are hidden on compact screens and appear in the
   * sidebar from 1024 px, so the sidebar stays a complete view of the app rather than a reduced one.
   * Budgets and Accounts are behind More here even though they were primary before the queue landed:
   * a sixth item is what pushed the 320 px bottom bar into horizontal scroll, and docs/02 §2.1 files
   * both of them under `Više` anyway.
   */
  readonly items = NAV_ITEMS;
  readonly overflowItems = OVERFLOW_ITEMS;

  readonly moreOpen = signal(false);

  /** docs/02 §2.3: hidden at 0, `1`–`9` literal, `9+` above. */
  readonly badge = computed(() => badgeText(this.reviewQueue.count()));

  /**
   * The badged link's accessible name — *"Provera, 3 stavke čekaju"*, so the count is spoken and not
   * only drawn. `null` when the badge is hidden, which leaves the link's own text as its name.
   *
   * Both wordings are interpolated here: the catalogue has no plural machinery (ADR-019), so Serbian
   * needs two forms and the count goes into the one that fits.
   */
  readonly badgeName = computed(() =>
    badgeAccessibleName(
      this.reviewQueue.count(),
      this.i18n.t('nav.reviewBadgeOne'),
      this.i18n.t('nav.reviewBadgeMany', { count: this.reviewQueue.count() }),
    ),
  );

  constructor() {
    // Ask the scoped COUNT as soon as there is a session, and again on every navigation: the API
    // documents `reviewQueueCount` as the shell's call on every screen, and there is no realtime
    // layer to push it. See `ReviewQueueStore` for why this replaces the spec's subscription.
    effect(() => {
      if (this.isAuthenticated()) void this.reviewQueue.refresh();
    });

    this.router.events
      .pipe(filter((event) => event instanceof NavigationEnd))
      .subscribe(() => {
        if (this.isAuthenticated()) void this.reviewQueue.refresh();
      });
  }

  async signOut(): Promise<void> {
    this.signingOut.set(true);
    try {
      await this.auth.signOut();
    } finally {
      this.signingOut.set(false);
    }
  }
}
