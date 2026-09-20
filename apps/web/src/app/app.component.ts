import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  DOCUMENT,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';

import { AppLockService } from './core/app-lock/app-lock.service';
import { AuthStore } from './core/auth/auth.store';
import { ConnectivityService } from './core/connectivity/connectivity.service';
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
import { BrandComponent } from './shared/ui/brand/brand.component';
import { IconComponent } from './shared/ui/icon/icon.component';
import { InstallSheetComponent } from './shared/ui/install-sheet/install-sheet.component';
import { LanguageSwitcherComponent } from './shared/ui/language-switcher/language-switcher.component';
import { SyncChipComponent } from './shared/ui/sync-chip/sync-chip.component';
import { ThemeToggleComponent } from './shared/ui/theme-toggle/theme-toggle.component';
import { VerifyBannerComponent } from './shared/ui/verify-banner/verify-banner.component';

/**
 * The routes a signed-out visitor belongs on (docs/02 §2), as paths.
 *
 * Read by the shell's sign-out redirect: a session the user ended moves to `/sign-in`, but only when it
 * is not already on one of these. `/reset-password` and `/verify-email` are in the list because they are
 * deliberately reachable while signed in — a person who clicks the emailed link is exactly who is signed
 * in — so a reset that clears the session must not have its own screen navigated out from under it.
 */
const AUTH_PATHS: readonly string[] = ['/sign-in', '/sign-up', '/reset-password', '/verify-email'];

/**
 * What the offline banner says on this page load, or `null` when there is a network.
 *
 * One sentence and at most one action. The sentence is deliberately different per install state, because
 * the honest claim about a queued entry depends on whether anything was persisted at all: with the app
 * lock armed it is on this device and survives a reload (ADR-025 decision 3), and without it the queue
 * lives in memory and a reload loses it — which is what the app-lock card's own copy says, and the banner
 * must not contradict it.
 */
interface OfflineNotice {
  readonly key: TranslationKey;
  readonly link?: {
    readonly path: string;
    readonly labelKey: TranslationKey;
    readonly queryParams?: Readonly<Record<string, string>>;
  };
}

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
 *  - the **user's name** is in the API since 0.6.4: `GET /auth/me` carries `displayName`, so the account
 *    block names the person and the role sits underneath it. It used to name the role alone, because the
 *    session carried only an id, a household and a role — and no display name — so the greeting had no
 *    name to use;
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
    BrandComponent,
    VerifyBannerComponent,
  ],
  template: `
    <a class="skip-link" href="#main">{{ i18n.t('app.skipToContent') }}</a>

    @if (appLock.state() === 'LOCKED') {
      <!-- The gate (ADR-029 decision 5): no nav, no header, no outlet. There is nothing to navigate
           to, because the data key is not in memory and every offline read is empty by construction. -->
      <fm-app-lock-screen />
    } @else {
      <div class="shell" [class.shell--authenticated]="chrome()" [class.shell--bare]="!showNav()">
        @if (showNav()) {
          <nav class="nav" [attr.aria-label]="i18n.t('app.primaryNav')">
            <!-- The brand block. The mark is inline SVG rather than an asset: it has to scale from 28 px
                 in the compact bar to 36 px in the sidebar and inherit the brand gradient, which a raster
                 favicon cannot do. -->
            <a class="brand" routerLink="/" [attr.aria-label]="i18n.t('nav.dashboard')">
              <fm-brand [tagline]="true" />
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
                      [routerLinkActiveOptions]="{ exact: item.exact === true }"
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
                    [routerLinkActiveOptions]="{ exact: item.exact === true }"
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
                <a
                  class="nav__footer-link"
                  routerLink="/settings"
                  routerLinkActive="nav__footer-link--active"
                  #settingsRla="routerLinkActive"
                  [attr.aria-current]="settingsRla.isActive ? 'page' : null"
                >
                  <fm-icon name="settings" [size]="18" />
                  <span>{{ i18n.t('settings.title') }}</span>
                </a>
              </div>
            }
          </nav>
        }

        @if (chrome()) {
          <!-- docs/02 §2.2: the header carries search, the theme control, the notification bell, the
               language switcher and the account block on both layouts. It is the *only* entry to the
               notification centre — a second one in the nav put "Obaveštenja" in the sidebar twice. -->
          <header class="topbar">
            <!-- The compact bar has no room for a field, so the brand mark stands in and the search
                 field is hidden by CSS rather than duplicated. -->
            <a class="topbar__brand" routerLink="/" [attr.aria-label]="i18n.t('nav.dashboard')">
              <fm-brand [tagline]="false" />
            </a>

            <!-- Hidden in the offline app (ADR-033 amended): it navigates to the ledger with a query,
                 and a *filtered* read is deliberately never cached, so it could only search nothing.
                 docs/02 §2: a control that cannot work is not shown. -->
            @if (isAuthenticated()) {
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
            }

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

              <!-- The account block and sign-out need a session, so the offline app shows neither
                   (ADR-033 amended): there is no name to render, and a sign-out with no session would
                   only be a way to wipe the queue the person came here to see. -->
              @if (isAuthenticated()) {
                <!-- The account block. Since 0.6.4 the API's /auth/me carries the display name, so it
                     names the person; the role stays underneath as the server-resolved fact it is. It
                     opens the settings shell's **Account** tab, which is where the name is edited. -->
                <a class="account" routerLink="/settings" [queryParams]="{ section: 'account' }">
                  <fm-avatar [name]="accountName()" [size]="34" />
                  <span class="account__text">
                    <span class="account__name">{{ accountName() }}</span>
                    <span class="account__meta">{{ roleLabel() }}</span>
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
              }
            </div>
          </header>
        }

        <main id="main" class="content" tabindex="-1">
          <!-- The one place the app says it has no network, and what that means for the work in hand.
               It is not dismissible: it is the only statement of the state, and a person who dismissed it
               would be left guessing why a control did nothing. What it claims differs by install —
               see offlineNotice() — because "your entries are saved on this device" is true of an armed
               lock and false of one that was never set up. -->
          @if (offlineNotice(); as notice) {
            <p class="offline-banner" role="status">
              <span class="offline-banner__text">{{ i18n.t(notice.key) }}</span>
              @if (notice.link; as link) {
                <a
                  class="offline-banner__link"
                  [routerLink]="link.path"
                  [queryParams]="link.queryParams ?? {}"
                >
                  {{ i18n.t(link.labelKey) }}
                </a>
              }
            </p>
          }
          <!-- ADR-024: a newly installed build is waiting, or the shell's own cache is broken. Rendered
               inside the main region rather than as a fourth grid area, because the layout is named areas
               and a banner that appears only sometimes must not push the nav out of its row. -->
          <fm-app-update />
          <!-- docs/06 §2: the blocking half of email verification. Renders only when this deployment
               requires a confirmed address and this one is not confirmed. -->
          <fm-verify-banner />
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

      /* The offline banner (ADR-033, amended). It sits inside the content region above the outlet, so
         the shell it belongs to is the real one — the sentence is the only thing that distinguishes an
         offline page load from a live one besides the figures' own provenance labels. */
      .offline-banner {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-2) var(--space-3);
        margin: 0 0 var(--space-4);
        padding: var(--space-3) var(--space-4);
        background: var(--color-surface-raised);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        color: var(--color-text-muted);
      }
      .offline-banner__text {
        flex: 1 1 16rem;
        min-inline-size: 0;
      }
      .offline-banner__link {
        padding: var(--space-2) var(--space-3);
        border: 1px solid var(--color-primary);
        border-radius: var(--radius-pill);
        color: var(--color-primary-text);
        font-weight: 600;
        text-decoration: none;
        min-block-size: var(--control-size);
        display: inline-flex;
        align-items: center;
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
        /* The **public** shell's one area. The main content element carries grid-area: content for the
           authenticated layout below, and a named area that does not exist makes the grid invent implicit
           named lines instead: measured on /sign-in, the sign-in form was placed in the third column of a
           3x3 implicit grid — 226 px wide, at the bottom right of an empty page. This one declaration is
           what stops it; the authenticated block overrides it. */
        grid-template-areas: 'content';
        min-block-size: 100dvh;
      }

      /* The authenticated shell is three rows: the bar, the content, the navigation. These two
         declarations are load-bearing — the grid-area on the three children resolves against them, and without them every child auto-places into the same cell and paints over the
         others. The compact capture of this redesign caught exactly that: a search field floating in the
         middle of the monthly chart, with no bar above the content at all.

         It is also a **frame exactly one viewport tall**, and the content row is the scroller inside
         it (see the .shell--authenticated .content rule below). That is what makes the bar and the
         navigation stay put while a long ledger moves: they are rows of a frame that never scrolls.
         The overflow: hidden is load-bearing with the fixed height — without it the frame's rows are
         simply overflowed and clipped, and the content loses its own scrollbar. */
      .shell--authenticated {
        grid-template-areas:
          'topbar'
          'content'
          'nav';
        grid-template-rows: auto 1fr auto;
        block-size: 100dvh;
        overflow: hidden;
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

      /* The one scrolling region of a signed-in page. min-block-size: 0 is the declaration that
         lets it be one: a grid item's automatic minimum is its content, so without it the 1fr row
         grows past the frame and the content is clipped instead of scrolled — the same
         automatic-minimum trap the minmax(0, 1fr) column above exists for. A screen's own sticky
         element therefore sticks to the top of *this* box, which begins below the bar, which is what
         docs/07 §7.4 asks for when it says focus is never obscured by sticky chrome. */
      .shell--authenticated .content {
        min-block-size: 0;
        overflow-y: auto;
      }

      /* The public screens are a single card on an empty page, so it is centred in the window rather than
         pinned to the top of a 900 px column. Only the auth screens reach this: a signed-in person always
         has the authenticated shell, including on the onboarding wizard. */
      .shell:not(.shell--authenticated) .content {
        display: grid;
        align-content: center;
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
        /* Onboarding hides the navigation (docs/02 §4.1), so the column it would occupy has to go with
           it: the wizard is drawn full-screen, and the reserved 264 px strip pushed both the bar and the
           card a quarter of a window to the right — measured live on /onboarding at 1280 px, where the
           content began at x = 264 with no sidebar in it. */
        .shell--authenticated.shell--bare {
          grid-template-columns: minmax(0, 1fr);
          grid-template-areas:
            'topbar'
            'content';
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
          /* The **list** scrolls, not the column (below): the footer has to stay at the bottom of the
             sidebar whatever the height of the window, and a column that scrolled as a whole took the
             way into settings off screen on a short one. */
          overflow: hidden;
        }
        .brand {
          display: flex;
          /* The wordmark keeps its height; the list below it is what gives way. */
          flex: 0 0 auto;
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
          /* The sixteen rows scroll on their own so the footer below them never does. */
          flex: 1 1 auto;
          min-block-size: 0;
          overflow-y: auto;
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
          flex: 0 0 auto;
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
        .nav__footer-link--active {
          /* The same active language as the nav list above: brand text on the brand tint, which is the
             contrast fix 4.3.4b landed (--color-primary-text, 6.47:1 on it). Settings is not a nav
             destination — docs/02 §2.1 files it under **Nalog** in the footer — so it was the one
             sidebar row that never said it was the current page. The leading marker bar is deliberately
             not repeated: it exists so a tint is not lost among sixteen rows, and the footer is a single
             row behind its own divider. */
          color: var(--color-primary-text);
          background: var(--color-primary-soft);
        }
        .content {
          padding: var(--space-6);
          /* No pinned bar at this width, so nothing to reserve. */
          padding-block-end: var(--space-6);
          /* The reading measure, **centred** — expressed as padding rather than as the
             max-inline-size plus auto margins this used to be, because this element is now the scroll
             container. A capped, auto-margined box puts its scrollbar at the edge of the measure,
             240 px inside a 1920 px window, where it reads as a stray bar floating over the page.
             Padding centres the same measure and leaves the scrollbar at the window's own edge. The
             percentage resolves against the grid column, so the result is unchanged: 1440 px of
             content at 1920 px, and the full column below that. */
          padding-inline: max(var(--space-6), calc((100% - 1440px) / 2));
        }
      }

      /* A window this wide can carry more than 1440 px of cards without the rows becoming hard to follow:
         the cap is a reading measure, not a limit (docs/07 §4.3). Placed **after** the 1024 px block on
         purpose — the first attempt sat above it, so the narrower cap won and the extra room never
         arrived. */
      @media (min-width: 1600px) {
        .content {
          padding-inline: max(var(--space-6), calc((100% - 1600px) / 2));
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
  private readonly connectivity = inject(ConnectivityService);
  readonly i18n = inject(I18nService);

  readonly isAuthenticated = this.auth.isAuthenticated;

  /**
   * The offline app (ADR-033, amended): the lock is through, so the data key is in memory, but this page
   * load could not restore a session because nothing answered.
   *
   * It is **not** an offline shell beside the app any more. The shell it renders is the real one, and the
   * claim on screen is the honest one: no session has been restored, so nothing will be sent, but every
   * screen opens and serves the record it has. What this flag still gates is the things a session is
   * genuinely required for — the account block, sign-out, and the search that can only read a cache a
   * filtered query never writes.
   */
  readonly offlineOnly = computed(
    () =>
      this.appLock.state() === 'UNLOCKED' &&
      this.auth.restoreFailure() === 'UNREACHABLE' &&
      !this.isAuthenticated(),
  );

  /**
   * Whether the shell's frame is drawn: its navigation, its header and the one-scrolling-pane layout.
   *
   * True for the offline app as well as a signed-in one, because the destinations it links to do open
   * (ADR-033 amended). `isAuthenticated()` stays the narrower question — what a *session* permits — and
   * the two are deliberately not the same signal.
   */
  readonly chrome = computed(() => this.isAuthenticated() || this.offlineOnly());

  /**
   * The offline banner's copy for this page load, or `null` when the browser has a network.
   *
   * Four states, and each one is a different truth rather than a different tone:
   *
   *  - **no session, but the lock is through** (ADR-033): nothing answered, so the session is not
   *    restored; what the key opens is on the device and the way back is signing in.
   *  - **signed in, lock armed**: the ordinary PWA case — entries are persisted and the queue will drain.
   *  - **signed in, no lock**: the queue is in memory, so a reload loses it. It says so, and offers the
   *    one control that changes it rather than pretending the entries are safe.
   *  - **neither**: the sign-in screen needs a connection, and this install was never set up to work
   *    without one. This is the case that used to be a silent dead end.
   *
   * It reads `isAuthenticated()` and not `chrome()`: the offline shell has a session-shaped hole, and the
   * two need different sentences.
   */
  readonly offlineNotice = computed<OfflineNotice | null>(() => {
    if (this.connectivity.online()) return null;

    if (this.offlineOnly()) {
      return {
        key: 'offline.sessionNote',
        link: { path: '/sign-in', labelKey: 'offline.signIn' },
      };
    }

    if (this.isAuthenticated()) {
      return this.appLock.state() === 'OFF'
        ? {
            key: 'offline.banner.ephemeral',
            link: {
              path: '/settings',
              labelKey: 'offline.banner.enable',
              queryParams: { section: 'security' },
            },
          }
        : { key: 'offline.banner.saved' };
    }

    return { key: 'offline.banner.signedOut' };
  });

  /**
   * Whether to draw the navigation.
   *
   * docs/02 §4.1 draws onboarding as a full-screen wizard with only *Back* and *Step 3 of 6* — no nav,
   * because a list of destinations next to "pick your starting categories" invites the user to leave the
   * one flow that decides whether the product is useful. Every step still has its own Skip and the last
   * has Finish, so hiding the nav is not a trap.
   */
  private readonly url = signal(this.router.url);
  readonly showNav = computed(() => this.chrome() && !this.url().startsWith('/onboarding'));

  /**
   * Roles are shown as words, not enum values. The role itself comes from the server (never a token
   * claim), and only the label is localised.
   */
  readonly roleLabel = computed(() => {
    const role = this.auth.role();
    return role ? this.i18n.t(`role.${role}` as TranslationKey) : this.i18n.t('role.unknown');
  });

  /**
   * What the account block calls the person.
   *
   * The display name since `/auth/me` carries it (0.6.4); the role remains the fallback for a
   * session restored before the field existed. Either way it is server data, never a client guess.
   */
  readonly accountName = computed(() => this.auth.session()?.displayName ?? this.roleLabel());
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

  /**
   * The shell's own element — how the content pane is reached for the scroll reset below.
   *
   * Through the host rather than a `viewChild` signal on purpose: a signal query is not populated when
   * the shell reads it under the test harness (the same finding `assistant.component.ts` records, and
   * docs/15), so the reset would be a no-op in exactly the suite that is meant to prove it works.
   */
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

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

    // The unlock is a *navigation* the router already decided the other way: at boot the guards ran while
    // the install was still LOCKED, so an unauthenticated visitor was sent to /sign-in before the PIN
    // could be asked for (ADR-033). Once the lock is through, that decision is stale — this page load is
    // the offline app, and the app's landing screen is the dashboard, which serves its snapshot. A deep
    // link is left exactly where the person asked to be.
    effect(() => {
      if (!this.offlineOnly()) return;
      const path = this.url();
      if (path.startsWith('/sign-in') || path.startsWith('/sign-up')) {
        void this.router.navigateByUrl('/');
      }
    });

    // A session the **user** ended must take the screen with it. The guards run on *navigation*, never on
    // a state change, so clearing the session in place left the last screen mounted with its chrome gone:
    // after Sign out the person was looking at the ledger they had just left, and the lock screen's own
    // Sign out did the same. `SIGNED_OUT` is the trigger rather than "no session", because it is set by
    // those two actions alone — a page load that never had a session is the guards' business (including
    // the "not found" route, which deliberately redirects nobody), and a 401 self-heals on the next
    // navigation, which is a different decision from this one.
    effect(() => {
      if (this.auth.restoreFailure() !== 'SIGNED_OUT') return;
      if (this.isAuthenticated()) return;
      if (AUTH_PATHS.some((path) => this.url().startsWith(path))) return;
      void this.router.navigateByUrl('/sign-in');
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
        // The content pane is the scroller, not the window, so `scrollPositionRestoration: 'top'`
        // cannot reach it. Assigned rather than `scrollTo(...)`: assigning `scrollTop` is the form
        // jsdom implements, and the shell's own specs navigate.
        const pane = this.host.nativeElement.querySelector<HTMLElement>('main.content');
        if (pane) pane.scrollTop = 0;
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
