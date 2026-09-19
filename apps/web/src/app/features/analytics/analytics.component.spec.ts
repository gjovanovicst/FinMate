// @vitest-environment jsdom
// FIRST import, deliberately: it loads `@angular/compiler`, and `@angular/router` is a partially
// compiled package whose module body needs the JIT compiler to already be present (see
// `capture.component.spec.ts` for the full reasoning).
import { initAngularTesting } from '@web-test/angular-testing';

import { CUSTOM_ELEMENTS_SCHEMA, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GraphqlClient } from '../../core/graphql/graphql.client';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { MoneyComponent } from '../../shared/ui/money/money.component';
import { AnalyticsComponent } from './analytics.component';
import { monthRange, shiftMonthKey } from './analytics.view';

initAngularTesting();

/**
 * The analytics screen, mounted.
 *
 * The decisions live in `analytics.view.spec.ts`; what a *rendered* component proves beyond them is
 * that one request carries every panel, that a flat chart draws **only** the roots plus the
 * uncategorised bucket (drawing the API's whole tree would count a parent's subtree twice), that the
 * uncategorised row has **no drill-through** while a Category row's link carries the range, that a
 * null ratio renders as *nothing to compare with* rather than `0 %`, and that `[`/`]` move the period
 * through one request per month.
 */
const CATEGORY = (id: string, name: string, path: readonly string[], parentId: string | null) => ({
  id,
  name,
  path,
  parentId,
});

const VIEW = {
  spendByCategory: [
    {
      categoryId: 'food',
      category: CATEGORY('food', 'Hrana', ['Hrana'], null),
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      total: { amountMinor: '1200000', currency: 'RSD' },
      transactionCount: 3,
      shareOfTotal: 0.6,
      priorPeriodTotal: { amountMinor: '1000000', currency: 'RSD' },
      changeRatio: 0.2,
      isSubtreeAggregate: true,
    },
    {
      categoryId: 'market',
      category: CATEGORY('market', 'Supermarket', ['Hrana', 'Supermarket'], 'food'),
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      total: { amountMinor: '1200000', currency: 'RSD' },
      transactionCount: 3,
      shareOfTotal: 0.6,
      priorPeriodTotal: { amountMinor: '1000000', currency: 'RSD' },
      changeRatio: 0.2,
      isSubtreeAggregate: false,
    },
    {
      categoryId: 'fuel',
      category: CATEGORY('fuel', 'Gorivo', ['Gorivo'], null),
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      total: { amountMinor: '600000', currency: 'RSD' },
      transactionCount: 1,
      shareOfTotal: 0.3,
      // No baseline at all: the API returns null, and the screen must say so.
      priorPeriodTotal: { amountMinor: '0', currency: 'RSD' },
      changeRatio: null,
      isSubtreeAggregate: false,
    },
    {
      categoryId: null,
      category: null,
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      total: { amountMinor: '200000', currency: 'RSD' },
      transactionCount: 1,
      shareOfTotal: 0.1,
      priorPeriodTotal: null,
      changeRatio: null,
      isSubtreeAggregate: false,
    },
  ],
  spendOverTime: [
    {
      bucketStart: '2026-04-01',
      bucketEnd: '2026-04-30',
      expenseTotal: { amountMinor: '500000', currency: 'RSD' },
      incomeTotal: { amountMinor: '0', currency: 'RSD' },
      transactionCount: 1,
    },
    {
      bucketStart: '2026-09-01',
      bucketEnd: '2026-09-30',
      expenseTotal: { amountMinor: '2000000', currency: 'RSD' },
      incomeTotal: { amountMinor: '0', currency: 'RSD' },
      transactionCount: 5,
    },
  ],
  topMerchants: [
    {
      merchantId: 'lidl',
      displayName: 'Lidl',
      total: { amountMinor: '900000', currency: 'RSD' },
      transactionCount: 2,
    },
  ],
  monthComparison: {
    period: '2026-09',
    compareTo: '2026-08',
    total: { amountMinor: '2000000', currency: 'RSD' },
    compareTotal: { amountMinor: '1600000', currency: 'RSD' },
    delta: { amountMinor: '400000', currency: 'RSD' },
    deltaRatio: 0.25,
    categories: [
      {
        categoryId: 'fuel',
        category: CATEGORY('fuel', 'Gorivo', ['Gorivo'], null),
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        total: { amountMinor: '600000', currency: 'RSD' },
        transactionCount: 1,
        shareOfTotal: 0.3,
        priorPeriodTotal: { amountMinor: '0', currency: 'RSD' },
        changeRatio: null,
        isSubtreeAggregate: false,
      },
    ],
  },
};

async function mount(): Promise<{
  fixture: ReturnType<typeof TestBed.createComponent<AnalyticsComponent>>;
  client: { query: ReturnType<typeof vi.fn> };
}> {
  const client = {
    query: vi.fn((_query: string, _variables?: Record<string, unknown>) => Promise.resolve(VIEW)),
  };

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: GraphqlClient, useValue: client },
    ],
  });

  // `fm-money` is a custom element here, exactly as in the assistant's mounted spec: its `amount`
  // input is `input.required`, and a JIT-rendered child throws NG0950 when the harness evaluates it
  // before the binding lands. What this file proves is that the figures are *handed* to it.
  TestBed.overrideComponent(AnalyticsComponent, {
    remove: { imports: [MoneyComponent, IconComponent] },
    add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
  });

  const fixture = TestBed.createComponent(AnalyticsComponent);
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, client };
}

type Fixture = ReturnType<typeof TestBed.createComponent<AnalyticsComponent>>;

function calls(client: { query: ReturnType<typeof vi.fn> }): Record<string, unknown>[] {
  return client.query.mock.calls.map((call) => call[1] as Record<string, unknown>);
}

function periodOf(variables: Record<string, unknown>): string {
  return String(variables['period']);
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('the analytics screen', () => {
  it('asks once for the whole screen, with the period the user is looking at', async () => {
    const { client } = await mount();

    expect(client.query).toHaveBeenCalledTimes(1);
    const variables = calls(client)[0] ?? {};
    const period = periodOf(variables);
    expect(period).toMatch(/^\d{4}-\d{2}$/);

    // The range is the month's inclusive days, the baseline is the month before, and the trend
    // reaches back further so the sparkline has a shape.
    expect(variables['range']).toEqual(monthRange(period));
    expect(variables['compareTo']).toBe(shiftMonthKey(period, -1));
    const trend = variables['trendRange'] as { start: string; end: string };
    expect(trend.end).toBe(monthRange(period).end);
    expect(trend.start < monthRange(period).start).toBe(true);

    // One operation carries all four panels — docs/02 §4.15's "one query drives every chart".
    const query = String(client.query.mock.calls[0]?.[0]);
    for (const field of ['spendByCategory', 'spendOverTime', 'topMerchants', 'monthComparison']) {
      expect(query).toContain(field);
    }
    // A selection set on the Money scalar is a runtime 400 the client cannot see (docs/15).
    expect(query).not.toContain('total {');
    // `cashflow` is deliberately not fetched: F-20 asks for category trends, month-over-month and
    // top merchants, and docs/02 §4.15 draws no cashflow panel (docs/06 §4.3 exposes it regardless).
    expect(query).not.toContain('cashflow');
  });

  it('draws the roots and the uncategorised bucket, never a parent and its child together', async () => {
    const { fixture } = await mount();
    const element: HTMLElement = fixture.nativeElement;

    const bars = element.querySelectorAll('.bar');
    expect(bars).toHaveLength(3);
    const text = element.textContent ?? '';
    expect(text).toContain('Hrana');
    // The catalogue's English wording: the harness resolves `en` (ADR-019).
    expect(text).toContain('Uncategorised');
    // The child is in the table, not in the bars.
    expect(bars[0]?.textContent).not.toContain('Supermarket');
    expect(element.textContent ?? '').toContain('Supermarket');
  });

  it('links a Category row to the range’s transactions and refuses to link the uncategorised one', async () => {
    const { fixture } = await mount();
    const element: HTMLElement = fixture.nativeElement;

    const links = [...element.querySelectorAll('.bar a')].map((anchor) => anchor.getAttribute('href') ?? '');
    expect(links).toHaveLength(2);
    expect(links[0]).toContain('categoryId=food');
    expect(links[0]).toContain('from=');
    expect(links[0]).toContain('to=');
    // The uncategorised bucket has no drill-through: `transactions(...)` cannot filter for "no
    // Category", so a link would open rows the figure did not come from.
    expect(links.some((href) => href.includes('categoryId=null'))).toBe(false);

    const csv = element.querySelector('.controls__csv')?.getAttribute('href') ?? '';
    expect(csv).toContain('/api/export/transactions.csv');
    expect(csv).toContain('from=');
  });

  it('says there is nothing to compare with rather than printing a zero', async () => {
    const { fixture } = await mount();
    const text = fixture.nativeElement.textContent ?? '';

    expect(text).toContain('nothing to compare with');
    // The Category with a real baseline gets its percentage.
    expect(text).toContain('more 20 %');

    // And the one without a baseline says so in words, in its own row — rather than printing `0 %`
    // or `+∞ %` (docs/02 §4.15). Read from the row itself, because "20 %" contains a "0 %".
    const bars = [...fixture.nativeElement.querySelectorAll('.bar')] as HTMLElement[];
    const fuel = bars.find((bar) => (bar.textContent ?? '').includes('Gorivo'));
    expect(fuel?.querySelector('.bar__change')?.textContent ?? '').toContain(
      'nothing to compare with',
    );
  });

  it('moves the period with [ and ], and follows the baseline with it', async () => {
    const { fixture, client } = await mount();
    const element: HTMLElement = fixture.nativeElement;
    const first = periodOf(calls(client)[0] ?? {});

    element.querySelector('.pager')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: '[', bubbles: true }),
    );
    await fixture.whenStable();

    expect(client.query).toHaveBeenCalledTimes(2);
    const second = calls(client)[1] ?? {};
    expect(periodOf(second)).toBe(shiftMonthKey(first, -1));
    expect(second['compareTo']).toBe(shiftMonthKey(first, -2));

    element.querySelector('.pager')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: ']', bubbles: true }),
    );
    await fixture.whenStable();
    expect(periodOf(calls(client)[2] ?? {})).toBe(first);
  });

  it('shows an error instead of an empty chart when the query fails', async () => {
    const client = { query: vi.fn(() => Promise.reject(new Error('boom'))) };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: GraphqlClient, useValue: client },
      ],
    });
    TestBed.overrideComponent(AnalyticsComponent, {
      remove: { imports: [MoneyComponent, IconComponent] },
      add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
    });
    const fixture: Fixture = TestBed.createComponent(AnalyticsComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const alert = fixture.nativeElement.querySelector('[role="alert"]');
    expect(alert?.textContent ?? '').not.toBe('');
  });
});
