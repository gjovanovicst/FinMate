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
import { InstallService } from './core/install/install.service';
import { NAV_ITEMS, OVERFLOW_ITEMS, badgeAccessibleName, badgeText } from './core/navigation';
import { NotificationStore } from './core/notifications/notification.store';
import { PushService } from './core/push/push.service';
import { SnapshotService } from './core/offline/snapshot.service';
import { SyncService } from './core/offline/sync.service';
import { ReviewQueueStore } from './core/review/review-queue.store';
import { AppLockScreenComponent } from './shared/ui/app-lock/app-lock-screen.component';
import { AppUpdateComponent } from './shared/ui/app-update/app-update.component';
import { AvatarComponent } from './shared/ui/avatar/avatar.component';
import { IconComponent } from './shared/ui/icon/icon.component';
import { InstallSheetComponent } from './shared/ui/install-sheet/install-sheet.component';
import { LanguageSwitcherComponent } from './shared/ui/language-switcher/language-switcher.component';
import { SyncChipComponent } from './shared/ui/sync-chip/sync-chip.component';
import { ThemeToggleComponent } from './shared/ui/theme-toggle/theme-toggle.component';

/**
 * The application shell: brand, navigation, search, account and a content outlet.
 *
 * **One component, two layouts** (docs/07 §3). The navigation is the same data rendered differently by
 * size class — a bottom bar in the thumb zone on compact screens, a sidebar once there is room. It is CSS
 * that decides which, using media queries, so there is no JavaScript breakpoint listener to desynchronise
 * from the stylesheet.
 *
 * The nav is a <nav> with real links rather than buttons: keyboard navigation, middle-click and "open
 * in new tab" all work for free, and the active route is announced via aria-current.
 *
 * The destinations and their primary/overflow split live in core/navigation.ts, because that split is
 * docs/02 §2's information architecture rather than styling — see the module header there.
 *
 * ## What ADR-039 changed, and what it deliberately did not
 *
 * The chrome was rebuilt around the mockup: a brand block, a grouped destination list, a real search
 * field, a theme toggle and an account block. Three things the reference draws are **absent on purpose**:
 *
 *  - the **global search** performs a real search (it routes to /transactions with the query, where the
 *    filter already exists) rather than looking like one and doing nothing — docs/02 §2 is explicit that a
 *    control which cannot work is not shown;
 *  - the **user's name** is nowhere in the API — the session carries an id, a household and a role, and no
 *    display name — so the account block names the **role** and the greeting has no name;
 *  - the sidebar's marketing card is replaced by the sync chip and sign-out, which are controls the shell
 *    actually owes the user. Copy nobody asked for is not a design improvement.
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
    InstallSheetComponent,
    IconComponent,
    ThemeToggleComponent,
    AvatarComponent,
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
            <!-- The brand block. The mark is inline SVG rather than an asset: it has to scale from 28 px
                 in the compact bar to 36 px in the sidebar and inherit the brand gradient, which a raster
                 favicon cannot do. -->
            <a class="brand" routerLink="/" [attr.aria-label]="i18n.t('nav.dashboard')">
              <span class="brand__mark" aria-hidden="true">
                <svg viewBox="0 0 32 32" fill="none">
                  <path
                    d="M9 22.5c0-6.4 4.6-11 11.4-11.6M9 22.5c5.9 1.2 11.4-1.6 13.6-6.6"
                    stroke="currentColor"
                    stroke-width="2.4"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </span>
              <span class="brand__text">
                <span class="brand__name">{{ i18n.t('app.name') }}</span>
                <span class="brand__tagline">{{ i18n.t('app.tagline') }}</span>
              </span>
            </a>

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
                      <fm-icon [name]="item.icon" [size]="18" />
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
                    <span class="nav__icon">
                      <fm-icon [name]="item.icon" [size]="20" />
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
                    <span class="nav__icon"><fm-icon name="more" [size]="20" /></span>
                    <span class="nav__label">{{ i18n.t('nav.more') }}</span>
                  </button>
                </li>
              }
            </ul>

            @if (isAuthenticated()) {
              <!-- The sidebar footer. The mockup puts marketing copy here; a control that works is
                   worth more than a sentence that does not, and on a wide screen this is the largest
                   target in the chrome for the one screen that is not a destination. -->
              <div class="nav__footer">
                <a class="nav__footer-link" routerLink="/settings">
                  <fm-icon name="settings" [size]="18" />
                  <span>{{ i18n.t('settings.title') }}</span>
                </a>
              </div>
            }
          </nav>
        }

        @if (isAuthenticated()) {
          <!-- docs/02 §2.2: the header carries search, the theme control, the notification bell, the
               language switcher and the account block on both layouts. It is the *only* entry to the
               notification centre — a second one in the nav put "Obaveštenja" in the sidebar twice. -->
          <header class="topbar">
            <!-- The compact bar has no room for a field, so the brand mark stands in and the search
                 field is hidden by CSS rather than duplicated. -->
            <a class="topbar__brand" routerLink="/" [attr.aria-label]="i18n.t('nav.dashboard')">
              <span class="brand__mark brand__mark--small" aria-hidden="true">
                <svg viewBox="0 0 32 32" fill="none">
                  <path
                    d="M9 22.5c0-6.4 4.6-11 11.4-11.6M9 22.5c5.9 1.2 11.4-1.6 13.6-6.6"
                    stroke="currentColor"
                    stroke-width="2.4"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </span>
            </a>

            <form class="search" role="search" (submit)="submitSearch($event)">
              <span class="search__icon" aria-hidden="true"><fm-icon name="search" [size]="18" /></span>
              <input
                class="search__input"
                type="search"
                name="q"
                [value]="query()"
                (input)="onQuery($event)"
                [attr.placeholder]="i18n.t('app.searchPlaceholder')"
                [attr.aria-label]="i18n.t('app.searchLabel')"
              />
            </form>

            <div class="topbar__actions">
              <fm-theme-toggle />

              <fm-language-switcher />

              <!-- ADR-026 decision 1: the pending queue's count lives beside the bell, at every size
                   class, and the nav keeps its one badged destination (docs/02 §2.3). It renders nothing
                   while the queue is empty, and there is exactly one of it: a second copy in the
                   sidebar made the nav a place a control could be, which is what §2.2 forbids. -->
              <fm-sync-chip />

              <a
                class="fm-icon-btn topbar__bell"
                routerLink="/notifications"
                routerLinkActive="fm-icon-btn--active"
                [attr.aria-label]="bellName() ?? i18n.t('notifications.bell')"
              >
                <span class="topbar__icon">
                  <fm-icon name="bell" [size]="20" />
                  @if (bellBadge() !== '') {
                    <span class="topbar__badge">{{ bellBadge() }}</span>
                  }
                </span>
              </a>

              <!-- The account block. The API exposes no display name (see the component header), so it
                   names the **role**, which is real, server-resolved data. -->
              <a class="account" routerLink="/settings">
                <fm-avatar [name]="roleLabel()" [size]="34" />
                <span class="account__text">
                  <span class="account__name">{{ roleLabel() }}</span>
                  <span class="account__meta">{{ i18n.t('session.account') }}</span>
                </span>
                <fm-icon name="chevronDown" [size]="16" />
              </a>

              <button
                type="button"
                class="fm-btn topbar__signout"
                (click)="signOut()"
                [disabled]="signingOut()"
              >
                <fm-icon name="logout" [size]="18" />
                <span class="topbar__signout-text">
                  {{ signingOut() ? i18n.t('session.signingOut') : i18n.t('session.signOut') }}
                </span>
              </button>
            </div>
          </header>
        }

        <main id="main" class="content" tabindex="-1">
          <!-- ADR-024: a newly installed build is waiting, or the shell's own cache is broken. Rendered
               inside the main region rather than as a fourth grid area, because the layout is named areas
               and a banner that appears only sometimes must not push the nav out of its row. -->
          <fm-app-update />
          <!-- docs/07 §4.7's Add-to-Home-Screen sheet (task 4.3.2b). Chrome rather than a screen: it
               opens on its own after the second confirmed capture, wherever the person happens to be,
               and it is deliberately non-modal — §4.7 forbids blocking the app behind an install. -->
          @if (install.promptKind(); as kind) {
            <fm-install-sheet
              [kind]="kind"
              [busy]="install.busy()"
              [failed]="install.failed()"
              (install)="installApp()"
              (dismiss)="install.dismiss()"
            />
          }
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

      /* ---- the brand mark ---- */
      .brand__mark {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        inline-size: 2.25rem;
        block-size: 2.25rem;
        flex: none;
        border-radius: var(--radius-md);
        background: var(--gradient-brand);
        color: #ffffff;
        box-shadow: var(--shadow-glow);
      }
      .brand__mark svg {
        inline-size: 1.6rem;
        block-size: 1.6rem;
      }
      .brand__mark--small {
        inline-size: 2rem;
        block-size: 2rem;
      }
      .brand__mark--small svg {
        inline-size: 1.4rem;
        block-size: 1.4rem;
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
        border-radius: var(--radius-pill);
        color: var(--color-text);
        text-decoration: none;
        min-block-size: 2.25rem;
        display: inline-flex;
        align-items: center;
      }
      .offline__link--active {
        border-color: var(--color-primary);
        color: var(--color-primary-text);
      }
      .offline__signIn {
        border-color: var(--color-primary);
        color: var(--color-primary-text);
        font-weight: 600;
      }
      .offline__content {
        display: block;
      }

      /* Skip link: hidden until focused. Without it a keyboard user tabs the whole nav on every page
         before reaching content (WCAG 2.4.1). */
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

      /* The authenticated shell is three rows: the bar, the content, the navigation. These two
         declarations are load-bearing — the grid-area on the three children resolves against them, and without them every child auto-places into the same cell and paints over the
         others. The compact capture of this redesign caught exactly that: a search field floating in the
         middle of the monthly chart, with no bar above the content at all. */
      .shell--authenticated {
        grid-template-areas:
          'topbar'
          'content'
          'nav';
        grid-template-rows: auto 1fr auto;
      }

      /* ---- the navigation ----
         One element, two renderings. On compact screens it is the bottom bar in the thumb zone; from
         1024 px the media query below turns the same list into the sidebar. It is deliberately **not**
         an off-canvas drawer, which would need a trigger, a focus trap and an Escape handler.

         Pinned, not the last row of the flow. docs/02 §2 calls this a **thumb zone**, and the audit
         captures showed what the flow version actually did: on a screen longer than the viewport the bar
         sat below the fold, so a person had to scroll to the end of a ledger to change destination. That
         was true before this redesign too (the old 320 px capture has the same shape) — it is fixed here
         because the bar is now the only navigation on a phone and a bar nobody can reach is not one. */
      .nav {
        grid-area: nav;
        position: fixed;
        inset-block-end: 0;
        inset-inline: 0;
        z-index: 20;
        background: var(--color-chrome);
        border-block-start: 1px solid var(--color-border);
        /* The home indicator must not sit on the last row of links (docs/07 §4.3). */
        padding-block-end: env(safe-area-inset-bottom);
      }
      /* The brand block, the footer and the overflow items belong to the sidebar only. */
      .brand,
      .nav__footer,
      .nav__item--overflow {
        display: none;
      }
      .nav__list {
        justify-content: space-around;
      }
      .nav__item {
        /* flex: 1 1 0 with min-inline-size: 0 is what stops five items overflowing a 320 px bar: flex
           items refuse to shrink below their content width by default, so one long word
           ("Transactions") would push the whole page into horizontal scroll. */
        flex: 1 1 0;
        min-inline-size: 0;
      }
      .brand {
        /* No display here: the base rule above hides it and the sidebar breakpoint shows it. Setting it
           twice is how the wordmark ended up rendered on a 320 px screen, in the middle of the page,
           because this rule came later in the file and won. */
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-5) var(--space-4) var(--space-6);
        color: var(--color-text);
        text-decoration: none;
      }
      .brand__text {
        display: grid;
        gap: 2px;
        min-inline-size: 0;
      }
      .brand__name {
        font-size: var(--text-lg);
        font-weight: var(--weight-bold);
        letter-spacing: var(--tracking-tight);
      }
      .brand__tagline {
        color: var(--color-text-subtle);
        font-size: var(--text-xs);
        /* The one string on the shell that is decoration; it must never widen the sidebar. */
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .nav__list {
        display: flex;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .nav__link {
        position: relative;
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
        border-radius: var(--radius-md);
        transition:
          background var(--motion-fast) ease,
          color var(--motion-fast) ease;
      }
      .nav__link:hover {
        background: var(--color-surface-raised);
        color: var(--color-text);
      }
      .nav__label {
        text-align: center;
        /* anywhere rather than break-word: only anywhere reduces the element's min-content width, which
           is the number the flex algorithm actually respects. */
        overflow-wrap: anywhere;
        line-height: 1.15;
      }
      .nav__link--active {
        /* 4.3.4b: the active item also carries the brand tint below, so the brand colour as *text* is
           3.85:1 there. --color-primary-text is 6.47:1 on it (axe, every route; asserted for both themes
           now by styles.tokens.spec.ts). */
        color: var(--color-primary-text);
        background: var(--color-primary-soft);
      }
      .nav__icon {
        position: relative;
        display: inline-flex;
        line-height: 1;
      }
      /* docs/02 section 2.3: hidden at 0 (the span is not rendered), the literal count up to nine, then
         "9+" above. Positioned against the glyph so the label underneath never shifts. */
      .nav__badge {
        position: absolute;
        inset-block-start: -0.35rem;
        inset-inline-start: 0.8rem;
        min-inline-size: 1.1rem;
        padding: 0 0.25rem;
        font-size: 0.65rem;
        line-height: 1.1rem;
        text-align: center;
        color: var(--color-on-danger);
        background: var(--color-danger);
        border-radius: var(--radius-pill);
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
        box-shadow: var(--shadow-2);
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
      /* There is deliberately no plain position: relative on .nav here. That rule existed so the More
         panel (absolute) had a positioned ancestor, and it sat **after** the pinned-bar rule above —
         which is how the pinned bar silently did nothing: the computed style was relative and the bar
         measured 3 750 px down a long screen. A fixed element is a positioned ancestor too, so the panel
         still resolves against it and the rule is gone. */
      /* ---- the topbar ---- */
      .topbar {
        grid-area: topbar;
        display: flex;
        align-items: center;
        /* Wrapping, never a fixed width: at 320 px the controls would otherwise push the bar into
           horizontal scroll (docs/02 §9). */
        flex-wrap: wrap;
        justify-content: space-between;
        gap: var(--space-2) var(--space-3);
        padding: var(--space-2) var(--space-4);
        /* docs/07 §4.3: an installed app draws under the status bar, so the topmost element owes the
           inset. The viewport meta already sets viewport-fit=cover; in a normal browser tab the inset is
           0 and this changes nothing. */
        padding-block-start: calc(var(--space-2) + env(safe-area-inset-top));
        background: var(--color-chrome);
        border-block-end: 1px solid var(--color-border);
      }
      .topbar__brand {
        display: inline-flex;
        text-decoration: none;
      }
      .search {
        position: relative;
        display: flex;
        align-items: center;
        gap: var(--space-2);
        /* The mockup's search field is wide and quiet: it takes the free space and stops at 34rem, so a
           very wide window does not stretch it into a banner. */
        flex: 1 1 12rem;
        max-inline-size: 34rem;
        padding-inline: var(--space-3);
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-pill);
        min-block-size: var(--control-size-comfortable);
        transition: border-color var(--motion-fast) ease;
      }
      .search:focus-within {
        border-color: var(--color-primary);
        box-shadow: var(--focus-ring);
      }
      .search__icon {
        display: inline-flex;
        color: var(--color-text-subtle);
      }
      .search__input {
        flex: 1 1 auto;
        min-inline-size: 0;
        padding: 0;
        border: none;
        background: none;
        color: var(--color-text);
        font: inherit;
        font-size: var(--text-sm);
        outline: none;
      }
      .search__input::placeholder {
        color: var(--color-text-subtle);
      }
      /* The UA's own clear button is a second, unstyled control inside the field. */
      .search__input::-webkit-search-cancel-button {
        appearance: none;
      }
      .topbar__actions {
        display: flex;
        align-items: center;
        /* Wrapping again, for the same reason as the bar above: the controls are more min-content than a
           320 px row holds, so at that width the row pushes the page into horizontal scroll once the
           shell's grid track stops absorbing it (4.3.1). flex-end keeps the wrapped line aligned with the
           first rather than drifting left. */
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: var(--space-1);
        margin-inline-start: auto;
        min-inline-size: 0;
      }
      .topbar__icon {
        position: relative;
        display: inline-flex;
        line-height: 1;
      }
      /* Same rule as the nav badge (docs/02 §2.3): the span is not rendered at zero, so the glyph never
         shifts when the count appears. */
      .topbar__badge {
        position: absolute;
        inset-block-start: -0.3rem;
        inset-inline-start: 0.75rem;
        min-inline-size: 1.1rem;
        padding: 0 0.25rem;
        font-size: 0.65rem;
        line-height: 1.1rem;
        text-align: center;
        color: var(--color-on-danger);
        background: var(--color-danger);
        border-radius: var(--radius-pill);
      }
      .account {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        padding: var(--space-1) var(--space-2);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-pill);
        color: var(--color-text);
        text-decoration: none;
      }
      .account:hover {
        border-color: var(--color-border-strong);
      }
      .account__text {
        display: grid;
        min-inline-size: 0;
      }
      /* The role is server truth: the API exposes no display name, so this block names the role. */
      .account__name {
        font-size: var(--text-sm);
        font-weight: var(--weight-semibold);
        line-height: 1.2;
      }
      .account__meta {
        color: var(--color-text-subtle);
        font-size: var(--text-xs);
        line-height: 1.2;
      }
      .content {
        grid-area: content;
        padding: var(--space-4);
        /* Safe areas and the pinned bar: the notch and the home indicator must not eat content
           (docs/07 §3), and neither may the navigation that floats above it — without this reserve the
           end of every long screen is unreachable. */
        padding-block-end: calc(
          var(--space-4) + var(--nav-bottom-h) + env(safe-area-inset-bottom)
        );
        outline: none;
      }

      /* ---- expanded: sidebar, vertical nav, account block ---- */
      @media (min-width: 1024px) {
        .shell--authenticated {
          grid-template-columns: 264px minmax(0, 1fr);
          grid-template-rows: auto 1fr;
          grid-template-areas:
            'nav topbar'
            'nav content';
        }
        .nav {
          /* Back into the flow: on a wide screen the navigation is a sidebar column, and a pinned bar
             would float over the content it is supposed to sit beside. */
          position: static;
          inset-block-end: auto;
          display: flex;
          flex-direction: column;
          padding-block: var(--space-5) var(--space-4);
          padding-block-end: var(--space-4);
          border-block-start: none;
          border-inline-end: 1px solid var(--color-border);
          overflow-y: auto;
        }
        .brand {
          display: flex;
        }
        .nav__footer {
          display: grid;
        }
        .nav__item--overflow {
          display: block;
        }
        .nav__item--more,
        .nav__more-panel,
        .topbar__brand {
          display: none;
        }
        .nav__list {
          flex-direction: column;
          gap: var(--space-1);
          padding-inline: var(--space-3);
        }
        .nav__item {
          /* The growth exists for the compact bar; in the sidebar the items stack, so it is given back. */
          flex: 0 0 auto;
        }
        .nav__link {
          flex-direction: row;
          justify-content: flex-start;
          gap: var(--space-3);
          font-size: var(--text-sm);
          padding: var(--space-3);
        }
        .nav__link--active::before {
          /* The mockup's active marker: a rounded bar on the leading edge, which reads at a glance in a
             list of sixteen rows where a background tint alone is easy to lose. */
          content: '';
          position: absolute;
          inset-block: 0.5rem;
          inset-inline-start: 0;
          inline-size: 3px;
          border-radius: var(--radius-pill);
          background: var(--color-primary);
        }
        .nav__label {
          text-align: start;
        }
        .nav__footer {
          display: grid;
          gap: var(--space-2);
          margin-block-start: auto;
          padding: var(--space-4) var(--space-3) 0;
          border-block-start: 1px solid var(--color-border);
        }
        .nav__footer-link {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          padding: var(--space-3);
          border-radius: var(--radius-md);
          color: var(--color-text-muted);
          font-size: var(--text-sm);
          text-decoration: none;
        }
        .nav__footer-link:hover {
          background: var(--color-surface-raised);
          color: var(--color-text);
        }
        .content {
          padding: var(--space-6);
          /* No pinned bar at this width, so nothing to reserve. */
          padding-block-end: var(--space-6);
          /* The reading measure, **centred**. docs/07 §4.3's 1200 px was measured against a
             sidebar-less shell; at 264 px of chrome the content box is the same at 1440 px and narrower
             below it. Without margin-inline: auto the cap did not centre anything — it left the whole
             page against the sidebar and pushed 216 px of empty background onto the right edge at
             1920 px (measured), which reads as a layout that failed to fill rather than as a measure. */
          max-inline-size: 1440px;
          inline-size: 100%;
          margin-inline: auto;
        }
      }

      /* A window this wide can carry more than 1440 px of cards without the rows becoming hard to follow:
         the cap is a reading measure, not a limit (docs/07 §4.3). Placed **after** the 1024 px block on
         purpose — the first attempt sat above it, so the narrower cap won and the extra room never
         arrived. */
      @media (min-width: 1600px) {
        .content {
          max-inline-size: 1600px;
        }
      }

      /* The account block needs room for a name and a role, so it arrives with the sidebar and the
         search field is the thing that shrinks first. */
      @media (max-width: 767.98px) {
        .account__text {
          display: none;
        }
        .topbar__signout-text {
          display: none;
        }
      }
      @media (max-width: 1023.98px) {
        /* The account block carries the way into settings at every width, so the labelled sign-out is
           the control that goes when the bar runs out of room. */
        .topbar__signout {
          display: none;
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
  /** Public because the template renders the sheet from it (docs/07 §4.7, task 4.3.2b). */
  readonly install = inject(InstallService);
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
   * because a list of destinations next to "pick your starting categories" invites the user to leave the
   * one flow that decides whether the product is useful. Every step still has its own Skip and the last
   * has Finish, so hiding the nav is not a trap.
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
   * docs/02 §2.2's five slots: four primary destinations plus **More**. The full list is rendered in one
   * <ul> and CSS decides — the overflow items are hidden on compact screens and appear in the sidebar
   * from 1024 px, so the sidebar stays a complete view of the app rather than a reduced one. Budgets and
   * Accounts are behind More here even though they were primary before the queue landed: a sixth item is
   * what pushed the 320 px bottom bar into horizontal scroll, and docs/02 §2.1 files both under Više.
   */
  readonly items = NAV_ITEMS;
  readonly overflowItems = OVERFLOW_ITEMS;

  readonly moreOpen = signal(false);

  /**
   * The search field's text.
   *
   * The field is a **real** search: submitting it navigates to the ledger with the query already applied,
   * where transactions(search:) runs it. docs/02 §2 forbids a control that only looks like one, and a
   * global search that silently searched nothing would be exactly that.
   */
  readonly query = signal('');

  /** The unread-notification badge, by the same rule as the review badge (docs/02 §2.3). */
  readonly bellBadge = computed(() => badgeText(this.notificationsStore.count()));

  readonly bellName = computed(() =>
    badgeAccessibleName(
      this.notificationsStore.count(),
      this.i18n.t('notifications.bellOne', { count: this.notificationsStore.count() }),
      this.i18n.t('notifications.bellMany', { count: this.notificationsStore.count() }),
    ),
  );

  /** docs/02 §2.3: hidden at 0, 1–9 literal, 9+ above. */
  readonly badge = computed(() => badgeText(this.reviewQueue.count()));

  /**
   * The badged link's accessible name — *"Provera, 3 stavke čekaju"*, so the count is spoken and not only
   * drawn. null when the badge is hidden, which leaves the link's own text as its name.
   *
   * Both wordings are interpolated here: the catalogue has no plural machinery (ADR-019), so Serbian needs
   * two forms and the count goes into the one that fits.
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
    // documents reviewQueueCount as the shell's call on every screen, and there is no realtime layer to
    // push it. See ReviewQueueStore for why this replaces the spec's subscription.
    effect(() => {
      if (this.isAuthenticated()) {
        void this.reviewQueue.refresh();
        void this.notificationsStore.refresh();
        // docs/07 §4.8: pushsubscriptionchange is unreliable, so the subscription is re-registered on
        // every app start — which is also what revives a row the server retired after a 404/410.
        // syncOnStart guards itself to one attempt per page load and does nothing unless permission was
        // already granted, so this is not a request per navigation.
        void this.push.syncOnStart();
      }
    });

    // docs/07 §4.7: never prompt for an install during onboarding. The service enforces it as a fact
    // rather than the template gating a chrome element, so the rule is asserted in install.view.spec
    // instead of being visible only in the markup.
    effect(() => this.install.setOnboarding(this.url().startsWith('/onboarding')));

    // Entering the offline shell (ADR-033) is a *navigation* the router has already decided the other way:
    // at boot it sent an unauthenticated visitor to /sign-in before the lock was unlocked, so the unlock
    // has to move it to the one screen that works. Only when the current route is not offline-capable — a
    // deep link to /transactions stays where the user asked to be.
    effect(() => {
      if (!this.offlineOnly()) return;
      const path = this.url();
      if (path.startsWith('/pending') || path.startsWith('/transactions')) return;
      void this.router.navigateByUrl('/pending');
    });

    // Idle tracking (docs/08 §3.9's five minutes). Activity is noted on the events a person actually
    // produces — a tap, a key, scrolling back to the tab — and the clock is checked on an interval plus on
    // every return to visibility, which is the case that matters most: a phone asleep in a pocket for ten
    // minutes must be locked the moment it is picked up, not up to a minute later. Only the events, not
    // the state: noteActivity ignores everything while the lock is OFF or LOCKED, so this costs a signal
    // read and never a write.
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
    // 30 s: fine enough that the 5-minute window is honoured within half a minute, coarse enough to be
    // invisible next to everything else the page does.
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

  /** The sheet's *Install*: a promise-returning call from a template handler, so the void is explicit. */
  installApp(): void {
    void this.install.accept();
  }

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  /**
   * Run the search.
   *
   * It navigates to the ledger with the query string rather than filtering in place, because the ledger is
   * the screen that owns searching: it has the paging, the date filters and the empty state for "nothing
   * matched". A second, chrome-level search implementation would be a second set of those. search is a
   * transactions argument (docs/06 §4.4) and filtersFromQuery reads it, so the URL contract is the
   * same one the assistant's drill-throughs use.
   */
  protected submitSearch(event: Event): void {
    event.preventDefault();
    const query = this.query().trim();
    void this.router.navigate(['/transactions'], query === '' ? {} : { queryParams: { search: query } });
  }

  async signOut(): Promise<void> {
    this.signingOut.set(true);
    try {
      await this.auth.signOut();
    } finally {
      // ADR-025 decision 6: a sign-out wipes the offline store — the wrapped key first, then every record
      // — and the app lock goes with it, because a wrapped key is what the lock *is*. The snapshot's
      // provenance is a signal, so it is cleared explicitly or the header chip would keep labelling figures
      // that no longer exist, and the queue is re-read so the chip drops to zero instead of advertising
      // work that was just discarded.
      await this.appLock.purge();
      this.snapshot.reset();
      await this.sync.refresh();
      this.signingOut.set(false);
    }
  }
}
