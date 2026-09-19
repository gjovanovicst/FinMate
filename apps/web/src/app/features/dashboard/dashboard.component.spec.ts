// @vitest-environment jsdom
// FIRST import, deliberately: it loads `@angular/compiler`, and `@angular/router` is a partially
// compiled package whose module body needs the JIT compiler already present (docs/15 §9).
import { initAngularTesting } from '@web-test/angular-testing';

import { CUSTOM_ELEMENTS_SCHEMA, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GraphqlClient } from '../../core/graphql/graphql.client';
import { OfflineStoreHolder } from '../../core/offline/offline-store-holder';
import {
  DASHBOARD_SNAPSHOT_KEY,
  SnapshotService,
  type DashboardFigures,
  type DashboardSnapshot,
  type SnapshotMoney,
} from '../../core/offline/snapshot.service';
import { AvatarComponent } from '../../shared/ui/avatar/avatar.component';
import { BarChartComponent } from '../../shared/ui/bar-chart/bar-chart.component';
import { DonutComponent } from '../../shared/ui/donut/donut.component';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { MoneyComponent } from '../../shared/ui/money/money.component';
import { ProgressComponent } from '../../shared/ui/progress/progress.component';
import { SparklineComponent } from '../../shared/ui/sparkline/sparkline.component';
import { DashboardComponent } from './dashboard.component';

initAngularTesting();

/**
 * The dashboard, mounted: the live read, the panel round trip, and the snapshot-served one (ADR-027).
 *
 * Three rules the assertions below encode, each of which is silent when it breaks:
 *
 * 1. **The screen has exactly two figure-rendering modes** — live (unlabelled) and stale (labelled) —
 *    and a failure with no snapshot renders **no** figure at all, because a zero that looks like advice
 *    is worse than an honest error (ADR-027 decision 3).
 * 2. **The panels fail separately from the figures.** The KPI row is the product's headline; a panel
 *    query that fails leaves it standing and says the breakdowns need a connection, rather than drawing
 *    an empty chart that reads as "you spent nothing" (ADR-029's 4.2.8b amendment).
 * 3. **The composer and the chips carry a question, not just a route** (ADR-039): a chip that lands on an
 *    empty assistant has not answered anything.
 *
 * Every child component is removed from the imports and rendered as a custom element, as everywhere in
 * this suite: a JIT-rendered child with an `input.required` throws NG0950 before the binding lands. The
 * bindings still land as DOM properties, which is what the assertions read.
 */
const LIVE: DashboardFigures = {
  today: '2026-09-14',
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
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
  ...LIVE,
  today: '2026-09-13',
  daysElapsed: 13,
  safeToSpendToday: { amountMinor: '310000', currency: 'RSD' },
  available: { amountMinor: '920000', currency: 'RSD' },
  spentThisMonth: { amountMinor: '5210000', currency: 'RSD' },
  projectedTotal: { amountMinor: '13100000', currency: 'RSD' },
  // The server's own refusal to forecast: rendered exactly as cached, never overridden (decision 3).
  paceIsReliable: false,
  needsReviewCount: 0,
};

/** The cached payload with no budget: the hero must show the server's no-budget arm, not a figure. */
const CACHED_WITHOUT_BUDGET: DashboardFigures = { ...CACHED, monthlyBudget: null };

/** One day of the panel payload. Shaped exactly as `PANELS_QUERY` asks, so a rename breaks this loudly. */
const PANELS = {
  spendByCategory: [
    {
      categoryId: 'c1',
      total: { amountMinor: '3806700', currency: 'RSD' },
      shareOfTotal: 0.32,
      category: { id: 'c1', name: 'Hrana', icon: '🍽', color: null },
    },
    {
      categoryId: 'c2',
      total: { amountMinor: '2512300', currency: 'RSD' },
      shareOfTotal: 0.21,
      category: { id: 'c2', name: 'Stanovanje', icon: '🏠', color: '#22c55e' },
    },
  ],
  spendOverTime: [
    {
      bucketStart: '2026-09-01',
      expenseTotal: { amountMinor: '120000', currency: 'RSD' },
      incomeTotal: { amountMinor: '0', currency: 'RSD' },
    },
    {
      bucketStart: '2026-09-10',
      expenseTotal: { amountMinor: '4875000', currency: 'RSD' },
      incomeTotal: { amountMinor: '2000000', currency: 'RSD' },
    },
  ],
  cashflow: [
    { bucketStart: '2026-08-01', income: { amountMinor: '10000000', currency: 'RSD' }, expense: { amountMinor: '8000000', currency: 'RSD' } },
    { bucketStart: '2026-09-01', income: { amountMinor: '12000000', currency: 'RSD' }, expense: { amountMinor: '6845000', currency: 'RSD' } },
  ],
  categories: [{ id: 'c1', name: 'Hrana', icon: '🍽' }],
  savingGoals: [
    {
      id: 'g1',
      name: 'Ušteda za odmor',
      target: { amountMinor: '120000000', currency: 'RSD' },
      contributed: { amountMinor: '48000000', currency: 'RSD' },
      progress: 0.4,
      requiredPerMonth: { amountMinor: '7250000', currency: 'RSD' },
      monthsRemaining: 10,
    },
  ],
  transactions: {
    edges: [
      {
        node: {
          id: 't1',
          description: 'Lidl',
          amount: { amountMinor: '200000', currency: 'RSD' },
          kind: 'EXPENSE',
          occurredLocalDate: '2026-09-14',
          categoryId: 'c1',
        },
      },
    ],
  },
  notifications: {
    edges: [
      {
        node: {
          id: 'n1',
          title: 'Hrana je dostigla 82% budžeta',
          body: 'Razmotri smanjenje troškova u ovoj kategoriji.',
          insightSeverity: 'WARNING',
          createdAt: '2026-09-14T18:00:00.000Z',
          readAt: null,
        },
      },
    ],
  },
  assistantSuggestions: ['Koliko sam potrošio na hranu ovog meseca?'],
};

interface Mounted {
  readonly fixture: ReturnType<typeof TestBed.createComponent<DashboardComponent>>;
  readonly query: ReturnType<typeof vi.fn>;
  /** The instance, so a spec can drive `load()` again — the path a refresh will take. */
  readonly component: DashboardComponent;
}

/**
 * Mount with a query stub that answers by **document**, so the two round trips this screen makes are
 * exercised the way the component makes them: figures first, panels second, keyed off the period the
 * figures carried.
 */
async function mount(
  options: { figures?: unknown; panels?: unknown; failFigures?: boolean; cached?: DashboardFigures } = {},
): Promise<Mounted> {
  const queryMock = vi.fn((document: string) => {
    if (document.includes('periodStart')) {
      return options.failFigures === true
        ? Promise.reject(new Error('No connection'))
        : Promise.resolve({ dashboard: options.figures ?? LIVE });
    }
    return options.panels === undefined
      ? Promise.resolve(PANELS)
      : Promise.resolve(options.panels);
  }) as ReturnType<typeof vi.fn>;

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: GraphqlClient, useValue: { query: queryMock } },
    ],
  });

  // The visual children are custom elements here; `RouterLink` stays, because the composer and the
  // chips are asserted by the href they produce.
  TestBed.overrideComponent(DashboardComponent, {
    remove: {
      imports: [
        MoneyComponent,
        IconComponent,
        ProgressComponent,
        SparklineComponent,
        DonutComponent,
        BarChartComponent,
        AvatarComponent,
      ],
    },
    add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
  });

  // Seeded through the *same* root service the component injects, before it is created.
  if (options.cached !== undefined) {
    await TestBed.inject(SnapshotService).writeDashboard(options.cached);
  }

  const fixture = TestBed.createComponent(DashboardComponent);
  fixture.detectChanges();
  // A macrotask lets the read, the fallback, the panel round trip and the cache write all settle;
  // `whenStable` does not track an awaited promise inside a component method.
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

/** The KPI row's four figures, in the order the mockup reads them. */
function kpiAmounts(fixture: Mounted['fixture']): readonly string[] {
  return Array.from(host(fixture).querySelectorAll<HTMLElement & { amount?: SnapshotMoney }>('.kpis fm-money')).map(
    (element) => element.amount?.amountMinor ?? '',
  );
}

describe('DashboardComponent (mounted)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders a live read unlabelled, and caches it for the next failed one', async () => {
    const { fixture } = await mount();

    expect(kpiAmounts(fixture)).toEqual([
      LIVE.available.amountMinor,
      LIVE.incomeThisMonth.amountMinor,
      LIVE.spentThisMonth.amountMinor,
      LIVE.projectedTotal.amountMinor,
    ]);
    // A live figure carries no label: if everything were labelled, the label would mean nothing.
    expect(host(fixture).querySelector('.asof')).toBeNull();

    const stores = TestBed.inject(OfflineStoreHolder);
    await vi.waitFor(async () => {
      const repository = await stores.repository();
      const record = await repository.get<DashboardSnapshot>('snapshot', DASHBOARD_SNAPSHOT_KEY);
      expect(record?.figures).toEqual(LIVE);
    });
  });

  it('asks for the panels over the period the server named, never the browser calendar', async () => {
    const { query } = await mount();

    // The second call's variables are the whole reason the screen makes two round trips: a month
    // boundary is the Household's local calendar (docs/03 §3.2).
    const panelCall = query.mock.calls.find((call) => String(call[0]).includes('spendByCategory'));
    expect(panelCall).toBeDefined();
    expect(panelCall?.[1]).toMatchObject({
      range: { start: LIVE.periodStart, end: LIVE.periodEnd },
    });
  });

  it('renders the panels from the payload: legend, chart, goals, rows and chips', async () => {
    const { fixture } = await mount();

    const donut = host(fixture).querySelector<HTMLElement & { segments?: readonly unknown[] }>('fm-donut');
    expect(donut?.segments).toHaveLength(2);

    const chart = host(fixture).querySelector<HTMLElement & { buckets?: readonly unknown[] }>('fm-bar-chart');
    expect(chart?.buckets).toHaveLength(2);

    // The legend's share is the server's own `shareOfTotal`, rounded for display.
    expect(text(fixture)).toContain('32%');
    expect(text(fixture)).toContain('Hrana');
    expect(text(fixture)).toContain('Ušteda za odmor');
    expect(text(fixture)).toContain('Lidl');
    expect(text(fixture)).toContain('Hrana je dostigla 82% budžeta');
  });

  it('sends a chip and the composer to the assistant carrying the question', async () => {
    const { fixture } = await mount();

    const chip = host(fixture).querySelector<HTMLAnchorElement>('.chips__item');
    expect(chip?.getAttribute('href')).toContain('/assistant');
    expect(chip?.getAttribute('href')).toContain(encodeURIComponent(PANELS.assistantSuggestions[0]!));

    // The composer asks the same way rather than opening an empty screen (ADR-039).
    expect(text(fixture)).toContain('AI financial assistant');
    expect(host(fixture).querySelector('.askbot__input')).not.toBeNull();
  });

  it('serves the cached figures with the podaci od label when the read fails', async () => {
    const { fixture } = await mount({ failFigures: true, cached: CACHED });

    expect(kpiAmounts(fixture)).toEqual([
      CACHED.available.amountMinor,
      CACHED.incomeThisMonth.amountMinor,
      CACHED.spentThisMonth.amountMinor,
      CACHED.projectedTotal.amountMinor,
    ]);
    // The server's own `paceIsReliable: false` survives the cache unchanged (ADR-027 decision 3).
    expect(text(fixture)).toContain('Too early in the month to predict reliably.');
    expect(text(fixture)).toContain('as of');
    expect(host(fixture).querySelectorAll('.asof')).toHaveLength(1);
  });

  it('keeps the honest error state and renders no figure when there is no snapshot', async () => {
    const { fixture } = await mount({ failFigures: true });

    expect(text(fixture)).toContain('No connection');
    expect(host(fixture).querySelectorAll('fm-money')).toHaveLength(0);
    expect(host(fixture).querySelector('.asof')).toBeNull();
    // The anti-fabrication rule: not a zero, not a blank that reads as one (ADR-027 decision 3).
    expect(text(fixture)).not.toMatch(/0[,.]00/);
  });

  it('serves the labelled snapshot when a later read fails, never an unlabelled figure', async () => {
    const { fixture, component } = await mount();

    // The first read was live, so nothing is labelled yet.
    expect(host(fixture).querySelector('.asof')).toBeNull();
    expect(kpiAmounts(fixture)[0]).toBe(LIVE.available.amountMinor);

    // The next read fails and falls back to the snapshot the first one wrote. `load()` is private and
    // the constructor is its only caller today, so this drives the path a refresh (or a reconnect
    // handler) will take — the one where an unlabelled stale figure could otherwise appear.
    const graphql = TestBed.inject(GraphqlClient) as unknown as { query: ReturnType<typeof vi.fn> };
    graphql.query.mockImplementation(() => Promise.reject(new Error('No connection')));

    await (component as unknown as { load: () => Promise<void> }).load();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(host(fixture).querySelector('.asof')).not.toBeNull();
    expect(kpiAmounts(fixture)[0]).toBe(LIVE.available.amountMinor);
    // The read failed but the screen is honest about *why* the figures are on it: it says when.
    expect(text(fixture)).not.toContain('No connection');
  });

  it('keeps the figures when only the panel query fails, and says so instead of drawing nothing', async () => {
    // The headline must survive a breakdown that did not arrive: an empty donut reads as "you spent
    // nothing", which is a fabricated figure (ADR-027's 4.2.8b amendment).
    const { fixture } = await mount({ panels: null });

    expect(kpiAmounts(fixture)).toHaveLength(4);
    expect(host(fixture).querySelector('fm-donut')).toBeNull();
    expect(host(fixture).querySelector('fm-bar-chart')).toBeNull();
  });

  it('renders the server’s own no-budget arm from the snapshot, not a figure', async () => {
    const { fixture } = await mount({ failFigures: true, cached: CACHED_WITHOUT_BUDGET });

    expect(text(fixture)).toContain('No monthly budget set');
    // No available-to-spend figure is invented; the remaining tiles are the cached ones, still labelled.
    expect(kpiAmounts(fixture)).toEqual([
      CACHED_WITHOUT_BUDGET.incomeThisMonth.amountMinor,
      CACHED_WITHOUT_BUDGET.spentThisMonth.amountMinor,
      CACHED_WITHOUT_BUDGET.projectedTotal.amountMinor,
    ]);
    expect(text(fixture)).toContain('as of');
  });

  it('labels every figure it renders while serving a snapshot (docs/10 §8.3)', async () => {
    const { fixture } = await mount({ failFigures: true, cached: CACHED });
    const rendered = kpiAmounts(fixture);
    const label = host(fixture).querySelector('.asof');

    // Every money figure on screen is one the cached payload holds, and there is exactly one label for
    // the serving mode — so no offline figure can render without its provenance (decision 4).
    expect(rendered).toHaveLength(4);
    expect(rendered).toEqual([
      CACHED.available.amountMinor,
      CACHED.incomeThisMonth.amountMinor,
      CACHED.spentThisMonth.amountMinor,
      CACHED.projectedTotal.amountMinor,
    ]);
    expect(label?.textContent).toContain('as of');
  });
});
