// @vitest-environment jsdom
// FIRST import, deliberately: it loads `@angular/compiler`, and `@angular/router` is a partially
// compiled package whose module body needs the JIT compiler already present (docs/15 §9).
import { initAngularTesting } from '@web-test/angular-testing';

import { CUSTOM_ELEMENTS_SCHEMA, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthStore } from '../../core/auth/auth.store';
import { GraphqlClient } from '../../core/graphql/graphql.client';
import { OfflineStoreHolder } from '../../core/offline/offline-store-holder';
import {
  DASHBOARD_SNAPSHOT_KEY,
  SnapshotService,
  type DashboardFigures,
  type DashboardSnapshot,
  type SnapshotMoney,
} from '../../core/offline/snapshot.service';
import { MoneyComponent } from '../../shared/ui/money/money.component';
import { DashboardComponent } from './dashboard.component';

initAngularTesting();

/**
 * The dashboard, mounted: the live read, and the snapshot-served one (ADR-027).
 *
 * docs/02 §4.2 puts the `podaci od <time>` disclosure in the hero, and docs/10 §8.3 turns "every figure
 * carries it" into a test. The rule the assertions below encode is structural: the screen has exactly
 * two figure-rendering modes — live (unlabelled) and stale (labelled) — and a failure with no snapshot
 * renders **no** figure at all, because a zero that looks like advice is worse than an honest error
 * (ADR-027 decision 3).
 *
 * `fm-money` is a custom element here, as everywhere in this suite: its `amount` input is
 * `input.required` and a JIT-rendered child throws NG0950 before the binding lands. Amounts are read
 * off the element's own property, which is what the production template binds.
 */
const LIVE: DashboardFigures = {
  today: '2026-09-14',
  daysElapsed: 14,
  daysInMonth: 30,
  safeToSpendToday: { amountMinor: '235000', currency: 'RSD' },
  available: { amountMinor: '1455000', currency: 'RSD' },
  isOverspent: false,
  spentThisMonth: { amountMinor: '6845000', currency: 'RSD' },
  incomeThisMonth: { amountMinor: '12000000', currency: 'RSD' },
  monthlyBudget: { amountMinor: '12000000', currency: 'RSD' },
  projectedTotal: { amountMinor: '14400000', currency: 'RSD' },
  projectedOverrun: null,
  paceIsReliable: true,
  needsReviewCount: 2,
};

/** The figures the last successful read cached: deliberately different from {@link LIVE}. */
const CACHED: DashboardFigures = {
  today: '2026-09-13',
  daysElapsed: 13,
  daysInMonth: 30,
  safeToSpendToday: { amountMinor: '310000', currency: 'RSD' },
  available: { amountMinor: '920000', currency: 'RSD' },
  isOverspent: false,
  spentThisMonth: { amountMinor: '5210000', currency: 'RSD' },
  incomeThisMonth: { amountMinor: '12000000', currency: 'RSD' },
  monthlyBudget: { amountMinor: '12000000', currency: 'RSD' },
  projectedTotal: { amountMinor: '13100000', currency: 'RSD' },
  projectedOverrun: null,
  // The server's own refusal to forecast: rendered exactly as cached, never overridden (decision 3).
  paceIsReliable: false,
  needsReviewCount: 0,
};

/** The cached payload with no budget: the hero must show the server's no-budget arm, not a figure. */
const CACHED_WITHOUT_BUDGET: DashboardFigures = {
  ...CACHED,
  monthlyBudget: null,
};

interface Mounted {
  readonly fixture: ReturnType<typeof TestBed.createComponent<DashboardComponent>>;
  readonly query: ReturnType<typeof vi.fn>;
  /** The instance, so a spec can drive `load()` again — the path a refresh will take. */
  readonly component: DashboardComponent;
}

async function mount(
  query: (document: string) => Promise<unknown>,
  cached?: DashboardFigures,
): Promise<Mounted> {
  const queryMock = vi.fn(query) as ReturnType<typeof vi.fn>;

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: GraphqlClient, useValue: { query: queryMock } },
      { provide: AuthStore, useValue: { role: signal<'OWNER'>('OWNER') } },
    ],
  });

  // `fm-money` is a custom element here; see the file header.
  TestBed.overrideComponent(DashboardComponent, {
    remove: { imports: [MoneyComponent] },
    add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
  });

  // Seeded through the *same* root service the component injects, before it is created.
  if (cached !== undefined) {
    await TestBed.inject(SnapshotService).writeDashboard(cached);
  }

  const fixture = TestBed.createComponent(DashboardComponent);
  fixture.detectChanges();
  // A macrotask lets the read, the fallback and the cache write all settle; `whenStable` does not
  // track an awaited promise inside a component method.
  await new Promise((resolve) => setTimeout(resolve, 0));
  fixture.detectChanges();
  return { fixture, query: queryMock, component: fixture.componentInstance };
}

function host(fixture: Mounted['fixture']): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

function text(fixture: Mounted['fixture']): string {
  return host(fixture).textContent ?? '';
}

/** The minor units handed to every rendered `fm-money`, in DOM order. */
function moneyAmounts(fixture: Mounted['fixture']): readonly string[] {
  return Array.from(host(fixture).querySelectorAll<HTMLElement & { amount?: SnapshotMoney }>('fm-money')).map(
    (element) => element.amount?.amountMinor ?? '',
  );
}

describe('DashboardComponent (mounted)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders a live read unlabelled, and caches it for the next failed one', async () => {
    const { fixture } = await mount(() => Promise.resolve({ dashboard: LIVE }));

    expect(moneyAmounts(fixture)).toEqual([
      LIVE.safeToSpendToday.amountMinor,
      LIVE.spentThisMonth.amountMinor,
      LIVE.incomeThisMonth.amountMinor,
      LIVE.projectedTotal.amountMinor,
    ]);
    // A live figure carries no label: if everything were labelled, the label would mean nothing.
    expect(host(fixture).querySelector('.hero__asof')).toBeNull();

    const stores = TestBed.inject(OfflineStoreHolder);
    await vi.waitFor(async () => {
      const repository = await stores.repository();
      const record = await repository.get<DashboardSnapshot>('snapshot', DASHBOARD_SNAPSHOT_KEY);
      expect(record?.figures).toEqual(LIVE);
    });
  });

  it('serves the cached figures with the podaci od label when the read fails', async () => {
    const { fixture } = await mount(() => Promise.reject(new Error('No connection')), CACHED);

    expect(moneyAmounts(fixture)).toEqual([
      CACHED.safeToSpendToday.amountMinor,
      CACHED.spentThisMonth.amountMinor,
      CACHED.incomeThisMonth.amountMinor,
      CACHED.projectedTotal.amountMinor,
    ]);
    // The server's own `paceIsReliable: false` survives the cache unchanged (ADR-027 decision 3).
    expect(text(fixture)).toContain('Too early in the month to predict reliably.');
    expect(text(fixture)).toContain('as of');
    expect(host(fixture).querySelectorAll('.hero__asof')).toHaveLength(1);
  });

  it('keeps the honest error state and renders no figure when there is no snapshot', async () => {
    const { fixture } = await mount(() => Promise.reject(new Error('No connection')));

    expect(text(fixture)).toContain('No connection');
    expect(host(fixture).querySelectorAll('fm-money')).toHaveLength(0);
    expect(host(fixture).querySelector('.hero__asof')).toBeNull();
    // The anti-fabrication rule: not a zero, not a blank that reads as one (ADR-027 decision 3).
    expect(text(fixture)).not.toMatch(/0[,.]00/);
  });

  it('serves the labelled snapshot when a later read fails, never an unlabelled figure', async () => {
    let calls = 0;
    const { fixture, component } = await mount(() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve({ dashboard: LIVE })
        : Promise.reject(new Error('No connection'));
    });

    // The first read was live, so nothing is labelled yet.
    expect(host(fixture).querySelector('.hero__asof')).toBeNull();
    expect(moneyAmounts(fixture)[0]).toBe('235000');

    // The second read fails and falls back to the snapshot the first one wrote. `load()` is private
    // and the constructor is its only caller today, so this drives the path a refresh (or a
    // reconnect handler) will take — the one where an unlabelled stale figure could otherwise appear.
    await (component as unknown as { load: () => Promise<void> }).load();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(host(fixture).querySelector('.hero__asof')).not.toBeNull();
    expect(moneyAmounts(fixture)[0]).toBe('235000');
    // The read failed but the screen is honest about *why* the figures are on it: it says when.
    expect(text(fixture)).not.toContain('No connection');
  });

  it('renders the server’s own no-budget arm from the snapshot, not a figure', async () => {
    const { fixture } = await mount(
      () => Promise.reject(new Error('No connection')),
      CACHED_WITHOUT_BUDGET,
    );

    expect(text(fixture)).toContain('No monthly budget set');
    // No safe-to-spend figure is invented; the remaining tiles are the cached ones, still labelled.
    expect(moneyAmounts(fixture)).toEqual([
      CACHED_WITHOUT_BUDGET.spentThisMonth.amountMinor,
      CACHED_WITHOUT_BUDGET.incomeThisMonth.amountMinor,
      CACHED_WITHOUT_BUDGET.projectedTotal.amountMinor,
    ]);
    expect(text(fixture)).toContain('as of');
  });

  it('labels every figure it renders while serving a snapshot (docs/10 §8.3)', async () => {
    const { fixture } = await mount(() => Promise.reject(new Error('No connection')), CACHED);
    const rendered = moneyAmounts(fixture);
    const label = host(fixture).querySelector('.hero__asof');

    // Every money figure on screen is one the cached payload holds, and there is exactly one label
    // for the serving mode — so no offline figure can render without its provenance (decision 4).
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).toEqual([
      CACHED.safeToSpendToday.amountMinor,
      CACHED.spentThisMonth.amountMinor,
      CACHED.incomeThisMonth.amountMinor,
      CACHED.projectedTotal.amountMinor,
    ]);
    expect(label?.textContent).toContain('as of');
  });
});
