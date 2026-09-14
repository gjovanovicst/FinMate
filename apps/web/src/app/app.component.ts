import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { AuthStore } from './core/auth/auth.store';

interface NavItem {
  readonly path: string;
  readonly label: string;
  readonly icon: string;
  /** Compact nav shows at most this many items before the rest move under "Više". */
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
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <a class="skip-link" href="#main">Preskoči na sadržaj</a>

    <div class="shell" [class.shell--authenticated]="isAuthenticated()">
      @if (isAuthenticated()) {
        <nav class="nav" aria-label="Glavna navigacija">
          <ul class="nav__list">
            @for (item of visibleItems(); track item.path) {
              <li class="nav__item">
                <a
                  class="nav__link"
                  [routerLink]="item.path"
                  routerLinkActive="nav__link--active"
                  #rla="routerLinkActive"
                  [attr.aria-current]="rla.isActive ? 'page' : null"
                >
                  <span class="nav__icon" aria-hidden="true">{{ item.icon }}</span>
                  <span class="nav__label">{{ item.label }}</span>
                </a>
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
          <span class="session__role">{{ role() }}</span>
          <button type="button" class="session__signout" (click)="signOut()" [disabled]="signingOut()">
            {{ signingOut() ? 'Odjavljivanje…' : 'Odjavi se' }}
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

  readonly isAuthenticated = this.auth.isAuthenticated;
  readonly role = computed(() => this.auth.role() ?? '');
  readonly signingOut = signal(false);

  /**
   * Phase 0 ships two destinations. The full set from docs/02 §2 (Capture, Review, Budgets…) lands
   * with the features themselves — an empty nav item that leads to "coming soon" is worse than no
   * item, because it teaches the user that the app is incomplete.
   */
  private readonly items: readonly NavItem[] = [
    { path: '/', label: 'Pregled', icon: '📊', primary: true },
    { path: '/accounts', label: 'Računi', icon: '🏦', primary: true },
  ];

  readonly visibleItems = computed(() => this.items.filter((item) => item.primary));

  async signOut(): Promise<void> {
    this.signingOut.set(true);
    try {
      await this.auth.signOut();
    } finally {
      this.signingOut.set(false);
    }
  }
}
