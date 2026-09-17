import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  DOCUMENT,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';

import { AppLockService } from './core/app-lock/app-lock.service';
import { AuthStore } from './core/auth/auth.store';
import { I18nService } from './core/i18n/i18n.service';
import type { TranslationKey } from './core/i18n/translations';
import { NAV_ITEMS, OVERFLOW_ITEMS, badgeAccessibleName, badgeText } from './core/navigation';
import { NotificationStore } from './core/notifications/notification.store';
import { PushService } from './core/push/push.service';
import { SnapshotService } from './core/offline/snapshot.service';
import { SyncService } from './core/offline/sync.service';
import { ReviewQueueStore } from './core/review/review-queue.store';
import { AppLockScreenComponent } from './shared/ui/app-lock/app-lock-screen.component';
import { AppUpdateComponent } from './shared/ui/app-update/app-update.component';
import { LanguageSwitcherComponent } from './shared/ui/language-switcher/language-switcher.component';
import { SyncChipComponent } from './shared/ui/sync-chip/sync-chip.component';

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
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    LanguageSwitcherComponent,
    AppUpdateComponent,
    AppLockScreenComponent,
    SyncChipComponent,
  ],
  template: `
    <a class="skip-link" href="#main">{{ i18n.t('app.skipToContent') }}</a>

    @if (appLock.state() === 'LOCKED') {
      <!-- The gate (ADR-029 decision 5): no nav, no header, no outlet. There is nothing to navigate
           to, because the data key is not in memory and every offline read is empty by construction. -->
      <fm-app-lock-screen />
    } @else if (offlineOnly()) {
      <!-- ADR-033: the lock is unlocked, so the data key is in memory and what it protects is readable,
           but there is no session and nothing answered. No nav, because only the two offline-capable
           routes can work; the outlet renders one of them. -->
      <div class="offline">
        <p class="offline__note">{{ i18n.t('offline.sessionNote') }}</p>
        <!-- Two links, not a navigation: these are the only destinations that work without a session
             (ADR-033 decision 2). Without them the cached ledger would be reachable by URL only. -->
        <nav class="offline__links" [attr.aria-label]="i18n.t('app.primaryNav')">
          <a class="offline__link" routerLink="/pending" routerLinkActive="offline__link--active">
            {{ i18n.t('pending.title') }}
          </a>
          <a class="offline__link" routerLink="/transactions" routerLinkActive="offline__link--active">
            {{ i18n.t('nav.transactions') }}
          </a>
          <a class="offline__signIn" routerLink="/sign-in">{{ i18n.t('offline.signIn') }}</a>
        </nav>
        <main id="main" class="offline__content" tabindex="-1">
          <router-outlet />
        </main>
      </div>
    } @else {
    <div class="shell" [class.shell--authenticated]="isAuthenticated()">
      @if (showNav()) {
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

      @if (isAuthenticated()) {
        <!-- docs/02 §2.2: the header carries the notification bell, the settings entry and the
             account menu on both layouts. It is the *only* entry to the notification centre — a
             second one in the nav put "Obaveštenja" in the sidebar twice. The nav below is
             destinations only. -->
        <header class="topbar">
          <span class="topbar__role">{{ roleLabel() }}</span>

          <div class="topbar__actions">
            <fm-language-switcher />

            <!-- ADR-026 decision 1: the pending queue's count lives beside the bell, at every size
                 class, so the nav keeps its one badged destination (docs/02 section 2.3). It renders
                 nothing while the queue is empty. -->
            <fm-sync-chip />

            <a
              class="topbar__button"
              routerLink="/notifications"
              routerLinkActive="topbar__button--active"
              [attr.aria-label]="bellName() ?? i18n.t('notifications.bell')"
            >
              <span class="topbar__icon" aria-hidden="true">
                🔔
                @if (bellBadge() !== '') {
                  <span class="topbar__badge">{{ bellBadge() }}</span>
                }
              </span>
            </a>

            <!-- docs/02 §2.2's settings entry. It was the one header control with no route behind
                 it; the settings route now exists (task 4.2.6b) and hosts the app lock. -->
            <a
              class="topbar__button"
              routerLink="/settings"
              routerLinkActive="topbar__button--active"
              [attr.aria-label]="i18n.t('settings.title')"
            >
              <span class="topbar__icon" aria-hidden="true">⚙</span>
            </a>

            <button
              type="button"
              class="topbar__signout"
              (click)="signOut()"
              [disabled]="signingOut()"
            >
              {{ signingOut() ? i18n.t('session.signingOut') : i18n.t('session.signOut') }}
            </button>
          </div>
        </header>
      }

      <main id="main" class="content" tabindex="-1">
        <!-- ADR-024: a newly installed build is waiting, or the shell's own cache is broken. Rendered
             inside the main region rather than as a fourth grid area, because the layout is named areas
             and a banner that appears only sometimes must not push the nav out of its row. -->
        <fm-app-update />
        <router-outlet />
      </main>
    </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        min-block-size: 100dvh;
      }

      /* The offline shell (ADR-033): a sentence, one action, and the outlet. It deliberately has no
         nav and no header — every destination it cannot serve is a control that cannot work. */
      .offline {
        display: grid;
        gap: var(--space-4);
        max-inline-size: 48rem;
        margin-inline: auto;
        padding: calc(var(--space-4) + env(safe-area-inset-top)) var(--space-4)
          calc(var(--space-6) + env(safe-area-inset-bottom));
      }
      .offline__note {
        margin: 0;
        color: var(--color-text-muted);
      }
      .offline__links {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-3);
        align-items: center;
      }
      .offline__link,
      .offline__signIn {
        padding: var(--space-2) var(--space-3);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        color: var(--color-text);
        text-decoration: none;
        min-block-size: 2.25rem;
        display: inline-flex;
        align-items: center;
      }
      .offline__link--active {
        border-color: var(--color-primary);
        color: var(--color-primary);
      }
      .offline__signIn {
        border-color: var(--color-primary);
        color: var(--color-primary);
        font-weight: 600;
      }
      .offline__content {
        display: block;
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
        /* minmax(0, 1fr), not an implicit auto track. An auto track is sized to its items' MIN-CONTENT,
           and min-inline-size: 0 on the nav's flex items does not change that: a flex item's min-content
           contribution is still its content, so five items measured 368 px and pushed the whole page into
           a 48 px horizontal scroll at 320 px (measured on all 18 authenticated routes, task 4.3.1). This
           is the one declaration that stops it — do not remove it. */
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: 1fr;
        min-block-size: 100dvh;
      }

      /* ---- authenticated layout ---- */
      .shell--authenticated {
        grid-template-areas:
          'topbar'
          'content'
          'nav';
        grid-template-rows: auto 1fr auto;
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
        /* 4.3.4b: the active item also carries the 14 %-tinted background below, so the brand colour
           as text is 3.85:1 there. --color-primary-text is 6.43:1 on it (axe, every route). */
        color: var(--color-primary-text);
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

      .topbar {
        grid-area: topbar;
        display: flex;
        align-items: center;
        /* Wrapping, never a fixed width: at 320 px the three controls would otherwise push the bar
           into horizontal scroll (docs/02 §9). */
        flex-wrap: wrap;
        justify-content: space-between;
        gap: var(--space-2) var(--space-3);
        padding: var(--space-2) var(--space-4);
        /* docs/07 §4.3: an installed app draws under the status bar, so the topmost element owes the
           inset. The viewport meta already sets viewport-fit=cover; in a normal browser tab the inset
           is 0 and this changes nothing. */
        padding-block-start: calc(var(--space-2) + env(safe-area-inset-top));
        background: var(--color-surface);
        border-block-end: 1px solid var(--color-border);
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
      }
      /* The role is a label, not a control: it goes first on a wide bar and is dropped on compact,
         where every pixel of the bar is one of the three things a thumb reaches for. */
      .topbar__role {
        display: none;
      }
      .topbar__actions {
        display: flex;
        align-items: center;
        /* Wrapping again, for the same reason as the bar above: five controls are 336 px of min-content
           (measured), so at 320 px the row pushed the page into a 32 px horizontal scroll once the shell's
           grid track stopped absorbing it (4.3.1). flex-end keeps the wrapped line aligned with the first
           rather than drifting left under the role label. */
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: var(--space-2);
        margin-inline-start: auto;
        min-inline-size: 0;
      }
      .topbar__button {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-inline-size: 2.25rem;
        min-block-size: 2.25rem;
        border-radius: var(--radius-sm);
        color: var(--color-text-muted);
        text-decoration: none;
      }
      .topbar__button:hover,
      .topbar__button--active {
        background: var(--color-surface-alt, rgba(0 0 0 / 0.04));
        color: var(--color-text);
      }
      .topbar__icon {
        position: relative;
        font-size: 1.15rem;
        line-height: 1;
      }
      /* Same rule as the nav badge (docs/02 §2.3): the span is not rendered at zero, so the glyph
         never shifts when the count appears. */
      .topbar__badge {
        position: absolute;
        inset-block-start: -0.3rem;
        inset-inline-start: 0.9rem;
        min-inline-size: 1.1rem;
        padding: 0 0.25rem;
        font-size: 0.65rem;
        line-height: 1.1rem;
        text-align: center;
        color: var(--color-primary-contrast);
        background: var(--color-danger);
        border-radius: var(--radius-lg);
      }
      .topbar__signout {
        background: none;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        color: var(--color-text-muted);
        padding: var(--space-1) var(--space-3);
        font: inherit;
        font-size: var(--text-xs);
        cursor: pointer;
      }
      .topbar__signout:hover:not(:disabled) {
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
          grid-template-rows: auto 1fr;
          grid-template-areas:
            'nav topbar'
            'nav content';
        }
        /* On a wide bar there is room for the role label, so it comes back. */
        .topbar__role {
          display: inline;
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
  private readonly notificationsStore = inject(NotificationStore);
  private readonly push = inject(PushService);
  /** Public because the template gates on it: while LOCKED the shell renders only the lock screen. */
  readonly appLock = inject(AppLockService);
  private readonly snapshot = inject(SnapshotService);
  private readonly sync = inject(SyncService);
  readonly i18n = inject(I18nService);

  readonly isAuthenticated = this.auth.isAuthenticated;

  /**
   * The offline shell (ADR-033): the lock is through, so the data key is in memory, but this page load
   * could not restore a session because nothing answered. The two offline-capable routes are reachable
   * and everything else redirects to the tray, so the shell renders a sentence and an outlet instead of
   * a navigation it cannot honour.
   */
  readonly offlineOnly = computed(
    () =>
      this.appLock.state() === 'UNLOCKED' &&
      this.auth.restoreFailure() === 'UNREACHABLE' &&
      !this.isAuthenticated(),
  );

  /**
   * Whether to draw the navigation.
   *
   * docs/02 §4.1 draws onboarding as a full-screen wizard with only *Back* and *Step 3 of 6* — no nav,
   * because a list of ten destinations next to "pick your starting categories" invites the user to
   * leave the one flow that decides whether the product is useful. Every step still has its own Skip
   * and the last has Finish, so hiding the nav is not a trap.
   */
  private readonly url = signal(this.router.url);
  readonly showNav = computed(() => this.isAuthenticated() && !this.url().startsWith('/onboarding'));

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

  /** The unread-notification badge, by the same rule as the review badge (docs/02 §2.3). */
  readonly bellBadge = computed(() => badgeText(this.notificationsStore.count()));

  readonly bellName = computed(() =>
    badgeAccessibleName(
      this.notificationsStore.count(),
      this.i18n.t('notifications.bellOne', { count: this.notificationsStore.count() }),
      this.i18n.t('notifications.bellMany', { count: this.notificationsStore.count() }),
    ),
  );

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
      if (this.isAuthenticated()) {
        void this.reviewQueue.refresh();
        void this.notificationsStore.refresh();
        // docs/07 §4.8: `pushsubscriptionchange` is unreliable, so the subscription is re-registered
        // on every app start — which is also what revives a row the server retired after a 404/410.
        // `syncOnStart` guards itself to one attempt per page load and does nothing unless permission
        // was already granted, so this is not a request per navigation.
        void this.push.syncOnStart();
      }
    });

    // Entering the offline shell (ADR-033) is a *navigation* the router has already decided the other
    // way: at boot it sent an unauthenticated visitor to `/sign-in` before the lock was unlocked, so
    // the unlock has to move it to the one screen that works. Only when the current route is not
    // offline-capable — a deep link to `/transactions` stays where the user asked to be.
    effect(() => {
      if (!this.offlineOnly()) return;
      const path = this.url();
      if (path.startsWith('/pending') || path.startsWith('/transactions')) return;
      void this.router.navigateByUrl('/pending');
    });

    // Idle tracking (docs/08 §3.9's five minutes). Activity is noted on the events a person actually
    // produces — a tap, a key, scrolling back to the tab — and the clock is checked on an interval
    // plus on every return to visibility, which is the case that matters most: a phone asleep in a
    // pocket for ten minutes must be locked the moment it is picked up, not up to a minute later.
    // Only the events, not the state: `noteActivity` ignores everything while the lock is OFF or
    // LOCKED, so this costs a signal read and never a write.
    const document = inject(DOCUMENT);
    const view = document.defaultView;
    const noteActivity = (): void => this.appLock.noteActivity();
    const lockIfIdle = (): void => {
      if (this.appLock.isIdle()) this.appLock.lock();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        noteActivity();
        lockIfIdle();
      }
    };
    if (view !== null && typeof view.addEventListener === 'function') {
      view.addEventListener('pointerdown', noteActivity);
      view.addEventListener('keydown', noteActivity);
      document.addEventListener('visibilitychange', onVisibility);
    }
    // 30 s: fine enough that the 5-minute window is honoured within half a minute, coarse enough to
    // be invisible next to everything else the page does.
    const idleTimer = view === null ? null : view.setInterval(lockIfIdle, 30_000);
    inject(DestroyRef).onDestroy(() => {
      if (view !== null && typeof view.removeEventListener === 'function') {
        view.removeEventListener('pointerdown', noteActivity);
        view.removeEventListener('keydown', noteActivity);
        document.removeEventListener('visibilitychange', onVisibility);
      }
      if (idleTimer !== null && view !== null) view.clearInterval(idleTimer);
    });

    this.router.events
      .pipe(filter((event) => event instanceof NavigationEnd))
      .subscribe((event) => {
        this.url.set((event as NavigationEnd).urlAfterRedirects);
        if (this.isAuthenticated()) {
          void this.reviewQueue.refresh();
          void this.notificationsStore.refresh();
        }
      });
  }

  async signOut(): Promise<void> {
    this.signingOut.set(true);
    try {
      await this.auth.signOut();
    } finally {
      // ADR-025 decision 6: a sign-out wipes the offline store — the wrapped key first, then every
      // record — and the app lock goes with it, because a wrapped key is what the lock *is*. The
      // snapshot's provenance is a signal, so it is cleared explicitly or the header chip would keep
      // labelling figures that no longer exist, and the queue is re-read so the chip drops to zero
      // instead of advertising work that was just discarded.
      await this.appLock.purge();
      this.snapshot.reset();
      await this.sync.refresh();
      this.signingOut.set(false);
    }
  }
}
