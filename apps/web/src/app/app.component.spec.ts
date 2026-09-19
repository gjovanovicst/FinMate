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
}> {
  const query = vi.fn((document: string) => {
    if (document.includes('ReviewQueueCount')) return Promise.resolve({ reviewQueueCount: count });
    return Promise.reject(new Error(`unexpected document: ${document.slice(0, 60)}`));
  });

  TestBed.configureTestingModule({
    imports: [AppComponent],
    providers: [
      provideZonelessChangeDetection(),
      // The offline shell navigates to `/pending` (ADR-033); these two paths exist so that navigation
      // resolves in the spec instead of rejecting as an unmatched URL. The empty path stands in for the
      // dashboard, so the active-state spec can sit on `/` as well as on a child destination.
      provideRouter([
        { path: '', children: [] },
        { path: 'pending', children: [] },
        { path: 'transactions', children: [] },
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
          isAuthenticated: signal(restoreFailure === null),
          role: signal(SESSION.role),
          session: signal(restoreFailure === null ? SESSION : null),
          restoreFailure: signal(restoreFailure),
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
  return { fixture };
}

function navLinks(fixture: { nativeElement: unknown }, selector: string): HTMLAnchorElement[] {
  return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLAnchorElement>(selector));
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
   * ADR-033's third shell state, and the risk it closes (R-27(b)).
   *
   * An offline reload leaves the lock screen in front of a page load whose session could not be
   * restored. Before this, the unlock dropped the user on `/sign-in` with a durable queue on disk and no
   * way to reach it. The shell now renders a sentence and the two routes that read only what is local.
   */
  it('renders the offline shell, not the navigation, when an unlocked install could not reach the server', async () => {
    const { fixture } = await mount(0, 0, 'UNLOCKED', 'UNREACHABLE');
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('The server is not reachable, so you are still signed out');
    // No *navigation list*: only the two destinations that work are offered (docs/02 §2), and the
    // ledger one is what makes the cached rows reachable without typing a URL.
    expect(host.querySelectorAll('.nav__link').length).toBe(0);
    const links = Array.from(host.querySelectorAll<HTMLAnchorElement>('.offline__links a')).map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/pending', '/transactions', '/sign-in']);
    // And the router is moved to the screen that does work, rather than sitting on `/sign-in`.
    expect(TestBed.inject(Router).url).toBe('/pending');
  });

  it('keeps the ordinary shell when the server refused the session rather than being unreachable', async () => {
    const { fixture } = await mount(0, 0, 'UNLOCKED', 'REFUSED');
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    // A `401`/refusal is an answer and must be respected: no offline shell, no local data.
    expect(host.querySelector('.offline')).toBeNull();
    expect(host.textContent).not.toContain('still signed out');
    // The ordinary shell is what renders — the sign-in page inside it, with no nav because there is
    // no session (which is the state this app has always had for a refused restore).
    expect(host.querySelector('.shell')).not.toBeNull();
  });

});
