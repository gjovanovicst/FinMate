// @vitest-environment jsdom
// FIRST import, deliberately: it loads `@angular/compiler`, and `@angular/router` is a partially
// compiled package whose module body needs the JIT compiler to already be present (see
// `capture.component.spec.ts` for the full reasoning).
import { initAngularTesting } from '@web-test/angular-testing';

import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthStore } from './core/auth/auth.store';
import { GraphqlClient } from './core/graphql/graphql.client';
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

async function mount(count: number): Promise<{
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
      provideRouter([]),
      { provide: GraphqlClient, useValue: { query } as unknown as GraphqlClient },
      {
        provide: AuthStore,
        useValue: {
          isAuthenticated: signal(true),
          role: signal(SESSION.role),
          session: signal(SESSION),
          signOut: vi.fn(),
        },
      },
    ],
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

describe('AppComponent nav (mounted)', () => {
  it('links to the notification centre exactly once', async () => {
    // The regression this exists for: adding `/notifications` to `NAV_ITEMS` *and* the header bell put
    // two "Obaveštenja" entries in the sidebar. One entry per layout, at any width.
    const { fixture } = await mount(0);
    const links = navLinks(fixture, 'a[href="/notifications"]');
    expect(links).toHaveLength(1);
    // …and it is the bell, not a destination in the five-slot bar.
    expect(links[0]?.classList.contains('nav__bell')).toBe(true);
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
      '/accounts',
      '/categories',
      '/merchants',
      '/counterparties',
      '/tags',
      '/rules',
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
      '/accounts',
      '/categories',
      '/merchants',
      '/counterparties',
      '/tags',
      '/rules',
    ]);
  });
});
