// @vitest-environment jsdom
// FIRST import, deliberately: it loads `@angular/compiler`, and `@angular/router` is a partially
// compiled package whose module body needs the JIT compiler to already be present (see
// `capture.component.spec.ts` for the full reasoning).
import { initAngularTesting } from '@web-test/angular-testing';

import { CUSTOM_ELEMENTS_SCHEMA, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { SwUpdate } from '@angular/service-worker';
import { EMPTY } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthStore } from './core/auth/auth.store';
import { GraphqlClient } from './core/graphql/graphql.client';
import { InstallService } from './core/install/install.service';
import type { InstallPromptKind } from './core/install/install.view';
import { SyncService } from './core/offline/sync.service';
import { AppLockService } from './core/app-lock/app-lock.service';
import { PushService } from './core/push/push.service';
import { AppLockScreenComponent } from './shared/ui/app-lock/app-lock-screen.component';
import { AppUpdateComponent } from './shared/ui/app-update/app-update.component';
import { AvatarComponent } from './shared/ui/avatar/avatar.component';
import { IconComponent } from './shared/ui/icon/icon.component';
import { InstallSheetComponent } from './shared/ui/install-sheet/install-sheet.component';
import { LanguageSwitcherComponent } from './shared/ui/language-switcher/language-switcher.component';
import { ThemeToggleComponent } from './shared/ui/theme-toggle/theme-toggle.component';
import { AppComponent } from './app.component';

initAngularTesting();

/**
 * The shell's navigation, mounted.
 *
 * Two things are asserted here and both are docs/02 §2 rather than styling:
 *
 *  - **the badged slot.** docs/02 §2.2 makes Provera "the only badged one", and §2.3 makes the count
 *    spoken as well as drawn (*"Provera, 3 stavke čekaju"*). Until this screen existed the blocking
 *    lane was invisible, so the badge is the half of F-08 that a queued row cannot be missing.
 *  - **the nav move.** Four primary links plus **More** is §2.2's five destinations. CSS decides
 *    what is drawn at which width, so what is asserted is the *structure* — which links are primary
 *    and which are behind More — because that is what a future edit can silently change.
 *
 * `AuthStore` is a stub: it fetches a session over `HttpClient` on boot, which is not what this test
 * is about. `GraphqlClient` answers only the badge's scoped COUNT.
 */

const SESSION = {
  userId: 'u-1',
  householdId: 'h-1',
  role: 'OWNER' as const,
  sessionId: 's-1',
  email: 'owner@example.com',
  displayName: 'Owner',
  locale: 'en',
  emailVerified: true,
  pendingEmail: null,
  emailVerificationRequired: false,
};

async function mount(
  count: number,
  pendingSync = 0,
  lockState: 'OFF' | 'LOCKED' | 'UNLOCKED' = 'OFF',
  /** ADR-033's third shell state: an unlocked lock whose session could not be restored. */
  restoreFailure: 'UNREACHABLE' | 'REFUSED' | 'SIGNED_OUT' | null = null,
  /** docs/07 §4.7: what the install service is offering right now, or `null` for nothing. */
  installKind: InstallPromptKind | null = null,
): Promise<{
  fixture: ReturnType<typeof TestBed.createComponent<AppComponent>>;
  /**
   * The stub store's own signals, writable so a test can end a session **in place** — which is what
   * sign-out does, and what the shell's redirect reacts to.
   */
  sessionFailure: ReturnType<typeof signal<'UNREACHABLE' | 'REFUSED' | 'SIGNED_OUT' | null>>;
  authenticated: ReturnType<typeof signal<boolean>>;
}> {
  const query = vi.fn((document: string) => {
    if (document.includes('ReviewQueueCount')) return Promise.resolve({ reviewQueueCount: count });
    return Promise.reject(new Error(`unexpected document: ${document.slice(0, 60)}`));
  });

  // The stub's session state lives in signals a test can move: `restoreFailure` is how the shell learns
  // that the *user* ended the session, and it has to be settable after mount to reproduce that.
  const sessionFailure = signal<'UNREACHABLE' | 'REFUSED' | 'SIGNED_OUT' | null>(restoreFailure);
  const authenticated = signal(restoreFailure === null);

  TestBed.configureTestingModule({
    imports: [AppComponent],
    providers: [
      provideZonelessChangeDetection(),
      // The offline app moves a page load off `/sign-in` once the lock is through (ADR-033), and
      // sign-out navigates to `/sign-in`; these paths exist so that navigation resolves in the spec
      // instead of rejecting as an unmatched URL. The empty path is the dashboard — where an offline
      // unlock lands — so the active-state specs can sit on `/` as well as on a child destination.
      provideRouter([
        { path: '', children: [] },
        { path: 'pending', children: [] },
        { path: 'settings', children: [] },
        { path: 'sign-in', children: [] },
        { path: 'transactions', children: [] },
        // The one route that hides the navigation (docs/02 §4.1), so the spec can mount the bare shell.
        { path: 'onboarding', children: [] },
      ]),
      // The shell renders `fm-app-update` (ADR-024), which injects `SwUpdate`. A stub keeps this spec
      // about navigation: there is no service worker in jsdom, and an update banner is not part of
      // what it asserts.
      {
        provide: SwUpdate,
        useValue: {
          versionUpdates: EMPTY,
          unrecoverable: EMPTY,
          activateUpdate: () => Promise.resolve(true),
        },
      },
      { provide: GraphqlClient, useValue: { query } as unknown as GraphqlClient },
      // The header's sync chip (ADR-026) injects the sync service. Stubbing it keeps this spec about
      // the shell rather than mounting the whole offline stack — the real service's own behaviour is
      // `sync.service.spec.ts`'s subject.
      { provide: SyncService, useValue: { pendingCount: signal(pendingSync) } },
      // The shell re-registers the push subscription on every app start (docs/07 §4.8, task 4.2.5).
      // The real service injects `SwPush`, which does not exist in jsdom; its own behaviour is
      // `core/push/push.service.spec.ts`'s subject.
      { provide: PushService, useValue: { syncOnStart: vi.fn(() => Promise.resolve()) } },
      // The app lock gates the whole shell (task 4.2.6b). The real one reads IndexedDB and is OFF in a
      // fresh spec, so the locked case states the state explicitly.
      {
        provide: AppLockService,
        useValue: {
          state: signal(lockState),
          ready: () => Promise.resolve(),
          method: signal(null),
          busy: signal(false),
          failure: signal(null),
          purge: vi.fn(() => Promise.resolve()),
          noteActivity: vi.fn(),
          isIdle: () => false,
          lock: vi.fn(),
        },
      },
      {
        // The funnel's own decisions are `install.view.spec.ts`'s and `install.service.spec.ts`'s
        // subject; here it is only the question of whether the shell draws the chrome.
        provide: InstallService,
        useValue: {
          promptKind: signal(installKind),
          busy: signal(false),
          failed: signal(false),
          accept: vi.fn(),
          dismiss: vi.fn(),
          setOnboarding: vi.fn(),
        },
      },
      {
        provide: AuthStore,
        useValue: {
          isAuthenticated: authenticated,
          role: signal(SESSION.role),
          session: signal(restoreFailure === null ? SESSION : null),
          restoreFailure: sessionFailure,
          signOut: vi.fn(),
        },
      },
    ],
  });

  // Every child component is removed, for the reason `setSignalInput`'s doc records: the JIT renderer
  // cannot bind a signal input inside a parent template, so any mounted child that has one throws NG0950
  // before the shell's own markup is reachable. Their copy and behaviour are their own specs' subjects;
  // what *this* spec owns is where the chrome goes and what the navigation is.
  //
  // `SyncChipComponent` stays, because the header assertions are about what it renders (a link to the
  // tray, and nothing at all at zero), and it has no inputs to bind.
  TestBed.overrideComponent(AppComponent, {
    remove: {
      imports: [
        InstallSheetComponent,
        IconComponent,
        AvatarComponent,
        ThemeToggleComponent,
        LanguageSwitcherComponent,
        AppUpdateComponent,
        AppLockScreenComponent,
      ],
    },
    add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
  });

  const fixture = TestBed.createComponent(AppComponent);
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, sessionFailure, authenticated };
}

function navLinks(fixture: { nativeElement: unknown }, selector: string): HTMLAnchorElement[] {
  return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLAnchorElement>(selector));
}

/**
 * The component's own source text, for the assertions jsdom cannot make about its styles.
 *
 * Every declaration the frame below rests on fails as a *layout* defect rather than an error, and jsdom
 * applies no CSS — the same gap `styles.tokens.spec.ts` closes for the design tokens by reading
 * `styles.css`. Vite resolves the raw import; there is no `node:fs` in this project (see `test/raw.d.ts`).
 */
const SOURCE = (
  import.meta.glob('./app.component.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>
)['./app.component.ts']!;

/** Every declaration block for `selector`, comments stripped and whitespace flattened. */
function rules(styles: string, selector: string): string[] {
  const flat = styles.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const at = flat.indexOf(`${selector} {`, from);
    if (at === -1) return bodies;
    const open = at + selector.length + 2;
    const close = flat.indexOf('}', open);
    bodies.push(flat.slice(open, close));
    from = close;
  }
}

function styleRules(selector: string): string[] {
  const styles = SOURCE.slice(SOURCE.indexOf('styles: ['));
  return rules(styles, selector);
}

/** The primary links, excluding the overflow items and the More button. */
function primaryLinks(fixture: { nativeElement: unknown }): HTMLAnchorElement[] {
  return navLinks(fixture, 'a.nav__link').filter(
    (link) =>
      link.closest('.nav__item--overflow') === null && link.closest('.nav__item--more') === null,
  );
}

function reviewLink(fixture: { nativeElement: unknown }): HTMLAnchorElement {
  const link = navLinks(fixture, 'a[href="/review"]')[0];
  if (!link) throw new Error('no review nav link');
  return link;
}

/** One `nav__link` by its path, for the active-state assertions. */
function navLink(fixture: { nativeElement: unknown }, href: string): HTMLAnchorElement {
  const link = navLinks(fixture, `a.nav__link[href="${href}"]`)[0];
  if (!link) throw new Error(`no nav link for ${href}`);
  return link;
}

describe('AppComponent nav (mounted)', () => {
  it('links to the notification centre exactly once, from the header', async () => {
    // The regression this exists for: adding `/notifications` to `NAV_ITEMS` *and* a bell put two
    // "Obaveštenja" entries in the sidebar. docs/02 §2.2 draws the bell in the **header**, so there is
    // one link, it is in `header.topbar`, and the nav is destinations only.
    const { fixture } = await mount(0);
    const links = navLinks(fixture, 'a[href="/notifications"]');
    expect(links).toHaveLength(1);
    expect(links[0]?.closest('header.topbar')).not.toBeNull();
    expect(links[0]?.closest('nav')).toBeNull();
  });

  it('keeps the account controls in the header, not in a second bottom row', async () => {
    // The bar carries the bell, the language switcher and Sign out; the old `.session` footer that put
    // them under the content is gone.
    const { fixture } = await mount(0);
    const header = (fixture.nativeElement as HTMLElement).querySelector('header.topbar');
    expect(header).not.toBeNull();
    // The spec mounts with the English catalogue, which is the product's primary language (ADR-019).
    expect(header?.textContent).toContain('Sign out');
    expect((fixture.nativeElement as HTMLElement).querySelector('.session')).toBeNull();
  });

  it('keeps the pending-sync chip in the header, beside the bell (ADR-026 decision 1)', async () => {
    // docs/02 §2.3 keeps the review slot as the only badged nav destination, so the queue's count is
    // chrome rather than a destination: a header chip that links to the tray at every size class.
    const { fixture } = await mount(0, 2);
    const host = fixture.nativeElement as HTMLElement;
    const chip = host.querySelector('header.topbar a[href="/pending"]');

    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('Waiting to send (2)');
    // Not a nav destination — the nav must not gain a pending slot.
    expect(host.querySelector('nav a[href="/pending"]')).toBeNull();
  });

  it('draws no sync chip while nothing is queued', async () => {
    const { fixture } = await mount(0, 0);
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('fm-sync-chip')).not.toBeNull();
    expect(host.querySelector('a[href="/pending"]')).toBeNull();
  });

  it('draws the install sheet when the funnel offers one (docs/07 §4.7)', async () => {
    // Chrome rather than a screen: it opens itself after the second confirmed capture, so it belongs
    // where the update line is — inside the content region, above the route.
    const { fixture } = await mount(0, 0, 'OFF', null, 'IOS_INSTRUCTIONS');
    const host = fixture.nativeElement as HTMLElement;
    const sheet = host.querySelector('fm-install-sheet');

    expect(sheet).not.toBeNull();
    expect(sheet?.closest('main')).not.toBeNull();
    // Above the route: the newest chrome is the first thing read.
    expect(host.querySelector('main > fm-install-sheet + router-outlet')).not.toBeNull();
  });

  it('draws nothing when the funnel is not offering', async () => {
    const { fixture } = await mount(0, 0);
    expect((fixture.nativeElement as HTMLElement).querySelector('fm-install-sheet')).toBeNull();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders the four primary destinations plus More', async () => {
    const { fixture } = await mount(0);

    expect(primaryLinks(fixture).map((link) => link.getAttribute('href'))).toEqual([
      '/',
      '/transactions',
      '/capture',
      '/review',
    ]);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.nav__item--more'),
    ).not.toBeNull();
  });

  it('moves Budgets and Accounts behind More', async () => {
    const { fixture } = await mount(0);

    const overflow = navLinks(fixture, '.nav__item--overflow .nav__link').map((link) =>
      link.getAttribute('href'),
    );
    expect(overflow).toContain('/budgets');
    expect(overflow).toContain('/accounts');
    expect(primaryLinks(fixture).map((link) => link.getAttribute('href'))).not.toContain('/budgets');
  });

  it('lists the overflow destinations in the More panel when it is open', async () => {
    const { fixture } = await mount(0);
    const more = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      '.nav__item--more .nav__link',
    )!;

    more.click();
    fixture.detectChanges();

    const panel = navLinks(fixture, '.nav__more-panel a').map((link) => link.getAttribute('href'));
    expect(panel).toEqual([
      '/budgets',
      '/goals',
      '/recurring',
      // The Uvid group follows Plan, in the document's own order.
      '/analytics',
      '/assistant',
      '/accounts',
      '/categories',
      '/merchants',
      '/counterparties',
      '/tags',
      '/rules',
      // The receipt library closes the Biblioteka group (docs/02 §2.2).
      '/receipts',
    ]);
  });

  it('draws nothing for a zero count', async () => {
    const { fixture } = await mount(0);

    expect((fixture.nativeElement as HTMLElement).querySelector('.nav__badge')).toBeNull();
    // No aria-label means the link's own text is its accessible name, which is right when there is
    // nothing to announce.
    expect(reviewLink(fixture).getAttribute('aria-label')).toBeNull();
  });

  it('draws the count and speaks it', async () => {
    const { fixture } = await mount(3);

    const badge = (fixture.nativeElement as HTMLElement).querySelector('.nav__badge');
    expect(badge?.textContent?.trim()).toBe('3');
    expect(reviewLink(fixture).getAttribute('aria-label')).toBe('Review, 3 items waiting');
  });

  it('caps the drawn badge at 9+ while still speaking the real count', async () => {
    // docs/02 §2.3: "Never 99+ — the queue is a to-do list, not a metric." The drawn cap is a
    // presentation choice, so the accessible name keeps the exact number.
    const { fixture } = await mount(12);

    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.nav__badge')?.textContent?.trim(),
    ).toBe('9+');
    expect(reviewLink(fixture).getAttribute('aria-label')).toBe('Review, 12 items waiting');
  });

  it('badges no other destination', async () => {
    const { fixture } = await mount(3);
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('.nav__badge')).toHaveLength(1);
  });

  it('keeps the sidebar a complete view, not a reduced one', async () => {
    // The overflow items live in the SAME list and are hidden by CSS on compact screens, so the
    // sidebar at 1024 px shows every destination. Rendering only the primary subset here would leave
    // the sidebar missing Budgets, Accounts and the whole library — and jsdom applies no CSS, which
    // is exactly why this is asserted on structure.
    const { fixture } = await mount(0);
    const all = navLinks(fixture, 'a.nav__link').map((link) => link.getAttribute('href'));

    expect(all).toEqual([
      '/',
      '/transactions',
      '/capture',
      '/review',
      '/budgets',
      '/goals',
      '/recurring',
      '/analytics',
      '/assistant',
      '/accounts',
      '/categories',
      '/merchants',
      '/counterparties',
      '/tags',
      '/rules',
      // The receipt library closes the Biblioteka group (docs/02 §2.2).
      '/receipts',
    ]);
  });

  it('highlights only the destination the URL is actually on', async () => {
    // The regression this exists for: the dashboard's path is `/`, and `routerLinkActive`
    // prefix-matches by default — so `/` was a prefix of every URL and the Overview entry stayed lit,
    // with `aria-current="page"`, on all 16 screens. Only the root asks for an exact match
    // (`NavItem.exact`), because `/transactions` must keep highlighting itself on `/transactions/:id`.
    const { fixture } = await mount(0);
    const router = TestBed.inject(Router);

    await router.navigateByUrl('/');
    fixture.detectChanges();
    expect(navLink(fixture, '/').classList).toContain('nav__link--active');
    expect(navLink(fixture, '/transactions').classList).not.toContain('nav__link--active');

    await router.navigateByUrl('/transactions');
    fixture.detectChanges();
    expect(navLink(fixture, '/transactions').classList).toContain('nav__link--active');
    // Overview is off, and it is not announced as the current page either.
    expect(navLink(fixture, '/').classList).not.toContain('nav__link--active');
    expect(navLink(fixture, '/').getAttribute('aria-current')).toBeNull();
    expect(navLink(fixture, '/transactions').getAttribute('aria-current')).toBe('page');
  });

  it('marks the sidebar footer Settings entry active on /settings', async () => {
    // Settings is the last sidebar row but **not** a nav destination — docs/02 §2.1 files it under
    // Nalog, which the shell renders in the footer. The footer link carried no `routerLinkActive` at
    // all, so the one row that was the current page was the one row that never said so.
    const { fixture } = await mount(0);
    const router = TestBed.inject(Router);
    const settings = (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>(
      'a.nav__footer-link',
    );

    expect(settings).not.toBeNull();
    expect(settings?.classList).not.toContain('nav__footer-link--active');
    expect(settings?.getAttribute('aria-current')).toBeNull();

    await router.navigateByUrl('/settings');
    fixture.detectChanges();

    expect(settings?.classList).toContain('nav__footer-link--active');
    expect(settings?.getAttribute('aria-current')).toBe('page');
    // The route is `/settings`, not a prefix of another destination, so no nav row lights up with it.
    expect(navLink(fixture, '/').classList).not.toContain('nav__link--active');
  });

  it('keeps Settings outside the sidebar scroller, after the destination list', async () => {
    // The sidebar is a flex column whose list owns the scroll, so the footer row is the one row that
    // never scrolls: on a short window sixteen destinations would otherwise push the way into settings
    // below the fold. Structure is what makes that true — the footer is a sibling *after* the list.
    const { fixture } = await mount(0);
    const host = fixture.nativeElement as HTMLElement;
    const list = host.querySelector('.nav__list');
    const footer = host.querySelector('.nav__footer');

    expect(list).not.toBeNull();
    expect(footer).not.toBeNull();
    expect(list?.contains(footer as Node)).toBe(false);
    expect(footer?.querySelector('a[href="/settings"]')).not.toBeNull();
  });

  it('frames the shell at one viewport and scrolls only the content region (styles)', () => {
    // jsdom applies no CSS, so these are read from the component's own bytes. Each is load-bearing and
    // each fails as a layout defect with nothing else to catch it: without `block-size: 100dvh` and
    // `overflow: hidden` the frame grows with the page and the bar and sidebar scroll away again;
    // without `min-block-size: 0` the content's 1fr row cannot shrink below its content, so it is
    // clipped rather than scrolled; and a `.nav__list` that does not scroll takes the footer with it.
    const frame = styleRules('.shell--authenticated').some(
      (body) => body.includes('block-size: 100dvh') && body.includes('overflow: hidden'),
    );
    const content = styleRules('.shell--authenticated .content').some(
      (body) => body.includes('min-block-size: 0') && body.includes('overflow-y: auto'),
    );
    const list = styleRules('.nav__list').some((body) => body.includes('overflow-y: auto'));

    expect(frame, 'the authenticated shell must be a fixed-height frame').toBe(true);
    expect(content, 'the content region must be the scroller').toBe(true);
    expect(list, 'the sidebar list must own the sidebar scroll').toBe(true);

    // Onboarding renders the same shell with no navigation, and a grid that still reserves the 264 px
    // column leaves the wizard with a quarter-window gutter on its left and the bar offset with it
    // (measured live on /onboarding at 1280 px).
    const bare = styleRules('.shell--authenticated.shell--bare').some((body) =>
      body.includes('grid-template-columns: minmax(0, 1fr)'),
    );
    expect(bare, 'the bare shell must give up the sidebar column').toBe(true);
  });

  it('drops the sidebar column when the navigation is hidden', async () => {
    // The class, not the stylesheet (which jsdom does not apply): `shell--bare` is what the wide-grid
    // rule keys on, so its presence on `/onboarding` and absence everywhere else is the contract.
    const { fixture } = await mount(0);
    const router = TestBed.inject(Router);
    const host = fixture.nativeElement as HTMLElement;

    await router.navigateByUrl('/transactions');
    fixture.detectChanges();
    expect(host.querySelector('.shell')?.classList).not.toContain('shell--bare');
    expect(host.querySelector('.nav')).not.toBeNull();

    await router.navigateByUrl('/onboarding');
    fixture.detectChanges();
    expect(host.querySelector('.nav')).toBeNull();
    expect(host.querySelector('.shell')?.classList).toContain('shell--bare');
  });

  it('returns the content pane to the top on navigation', async () => {
    // The shell's scroll container is `<main>`, not the window, so the router's
    // `scrollPositionRestoration: 'top'` cannot reach it. Without the shell's own reset, opening a
    // screen from halfway down a long ledger landed halfway down the new one — the regression this
    // test exists for. jsdom lays nothing out, so it is the write itself that is asserted.
    const { fixture } = await mount(0);
    const router = TestBed.inject(Router);
    const pane = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('main.content');
    expect(pane).not.toBeNull();

    let written: number | null = null;
    Object.defineProperty(pane, 'scrollTop', {
      configurable: true,
      get: () => 420,
      set: (value: number) => {
        written = value;
      },
    });

    await router.navigateByUrl('/transactions');
    expect(written).toBe(0);
  });

  it('moves to the login form when the session ends in place', async () => {
    // The regression this exists for: sign-out only cleared the session. The guards run on *navigation*,
    // so the route the person was on stayed mounted with its chrome gone — they were left looking at the
    // ledger (or whatever screen) they had just signed out of, instead of at the login form. `SIGNED_OUT`
    // is the trigger, which is what both Sign-out controls set and nothing else does.
    const { fixture, sessionFailure, authenticated } = await mount(0);
    const router = TestBed.inject(Router);

    await router.navigateByUrl('/transactions');
    fixture.detectChanges();
    expect(router.url).toBe('/transactions');

    // What `AuthStore.signOut()` does to the store, in the order it does it.
    authenticated.set(false);
    sessionFailure.set('SIGNED_OUT');
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(router.url).toBe('/sign-in');
  });

  it('leaves a page-load failure to the guards, not to the sign-out redirect', async () => {
    // A refused restore is not the user ending anything: the guards already own where a signed-out
    // visitor belongs, and the wildcard route deliberately redirects nobody (docs/02 §2). Starting at
    // `/` keeps this explicit — the redirect must come from the guard, not from the shell's effect.
    const { fixture, sessionFailure, authenticated } = await mount(0);
    const router = TestBed.inject(Router);

    await router.navigateByUrl('/');
    authenticated.set(false);
    sessionFailure.set('REFUSED');
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(router.url).toBe('/');
  });

  it('renders ONLY the lock screen while the app lock is locked', async () => {
    const { fixture } = await mount(3, 0, 'LOCKED');
    const host = fixture.nativeElement as HTMLElement;

    // The gate is structural: no navigation to leave by, no outlet to render a screen into, and no
    // header controls — the data key is not in memory, so every screen behind this would be empty.
    expect(host.querySelector('fm-app-lock-screen')).not.toBeNull();
    expect(host.querySelector('nav')).toBeNull();
    expect(host.querySelector('router-outlet')).toBeNull();
    expect(host.querySelector('.topbar')).toBeNull();
    // And it is not a dialog over the app: the shell itself is gone.
    expect(host.querySelector('.shell')).toBeNull();
  });

  it('renders the shell, not the lock screen, when no lock is armed', async () => {
    const { fixture } = await mount(3);
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('fm-app-lock-screen')).toBeNull();
    expect(host.querySelector('.shell')).not.toBeNull();
  });
  /**
   * ADR-033's third shell state, and the risk it closes (R-27(b)) — amended so that the offline app is
   * the app.
   *
   * An offline reload leaves the lock screen in front of a page load whose session could not be
   * restored. The unlock used to drop the person on `/sign-in`, and then on a two-link page beside the
   * app. It now renders the **real shell** — navigation, header and outlet — with one line saying no
   * session was restored, so every destination opens and each screen serves the record it has
   * (the dashboard snapshot, the ledger cache, the queue) or its own "needs a connection" state.
   */
  it('renders the app shell, with its navigation, when an unlocked install could not reach the server', async () => {
    const { fixture } = await mount(0, 0, 'UNLOCKED', 'UNREACHABLE');
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    // The one sentence that says what state this page load is in, and the way back to a session.
    expect(host.textContent).toContain('The server is not reachable, so you are still signed out');
    expect(host.querySelector('.offline-banner a')?.getAttribute('href')).toBe('/sign-in');
    // The app's own navigation, not an offline shell beside it: the destinations do open.
    expect(host.querySelectorAll('.nav__link').length).toBeGreaterThan(0);
    expect(host.querySelector('.shell--authenticated')).not.toBeNull();
    expect(host.querySelector('router-outlet')).not.toBeNull();
    // What a session is genuinely required for is absent: the account block has no name to render, and
    // a sign-out with no session would only be a way to wipe the queue the person came here to see.
    expect(host.querySelector('.account')).toBeNull();
    expect(host.querySelector('.topbar__signout')).toBeNull();
    // And the page load is not parked on the sign-in screen it was redirected to before the unlock.
    expect(TestBed.inject(Router).url).not.toContain('sign-in');
  });

  it('keeps the ordinary shell when the server refused the session rather than being unreachable', async () => {
    const { fixture } = await mount(0, 0, 'UNLOCKED', 'REFUSED');
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    // A `401`/refusal is an answer and must be respected: no offline banner, no local data.
    expect(host.querySelector('.offline-banner')).toBeNull();
    expect(host.textContent).not.toContain('still signed out');
    // The ordinary shell is what renders — the sign-in page inside it, with no nav because there is
    // no session (which is the state this app has always had for a refused restore).
    expect(host.querySelector('.shell')).not.toBeNull();
  });

});
