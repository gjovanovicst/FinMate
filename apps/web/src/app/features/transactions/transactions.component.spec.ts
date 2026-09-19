// @vitest-environment jsdom
// FIRST import, deliberately: it loads `@angular/compiler`, and `@angular/router` is a partially
// compiled package whose module body needs the JIT compiler to already be present (see
// `capture.component.spec.ts` for the full reasoning).
import { initAngularTesting } from '@web-test/angular-testing';

import { CUSTOM_ELEMENTS_SCHEMA, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GraphqlClient } from '../../core/graphql/graphql.client';
import { LedgerCacheService, type LedgerSnapshot } from '../../core/offline/ledger-cache.service';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { MoneyComponent } from '../../shared/ui/money/money.component';
import { TransactionDetailComponent } from './transaction-detail.component';
import { TransactionsComponent } from './transactions.component';

initAngularTesting();

/**
 * The transactions screen's half of the drill-through.
 *
 * The assistant links to `/transactions?from=…&categoryId=…` (docs/06 §4.4), and the conversion from
 * that URL into the screen's filter is pure and tested in `transactions.view.spec.ts`. What only a
 * mounted component proves is the **wiring**: that the parameters reach the screen before its first
 * query, so the user never sees an unfiltered list replaced by a filtered one — and that
 * `/transactions/:id` (docs/02 §2.1) fetches **that** row by id rather than hoping it is on the page.
 *
 * `fm-money` and the detail sheet are custom elements here, as everywhere else in this suite: the
 * money component's required input throws NG0950 under JIT before its binding lands, and the sheet
 * owns its own spec.
 */
const ACCOUNT = { id: 'a1', name: 'Tekući', currency: 'RSD' };
const CATEGORY = { id: 'c1', name: 'Hrana', kind: 'EXPENSE', path: ['Hrana'] };

/** A row shaped exactly like the list query's node, which is what the drill-in must produce. */
const ROW = {
  id: 'tx-9',
  kind: 'EXPENSE',
  status: 'CONFIRMED',
  amount: { amountMinor: '200000', currency: 'RSD' },
  description: 'Lidl',
  note: null,
  occurredAt: '2026-09-20T10:00:00.000Z',
  occurredLocalDate: '2026-09-20',
  categoryId: 'c1',
  accountId: 'a1',
  needsReview: false,
  attachmentId: null,
  version: 1,
  splits: [],
};

interface MountOptions {
  readonly query?: Record<string, string>;
  /** The `:id` path segment, i.e. the `/transactions/:id` drill-in. */
  readonly id?: string;
  /** Make the single-row query fail, for the not-found path. */
  readonly failRow?: boolean;
  /** Make the **list** query fail, which is the offline path 4.2.8b serves the cache on. */
  readonly failList?: boolean;
  /** The rows the list query returns. Defaults to an empty page. */
  readonly rows?: readonly (typeof ROW)[];
  /** What the ledger cache holds, i.e. what a previous visit left behind. */
  readonly cache?: LedgerSnapshot | null;
}

/**
 * A faithful stand-in for {@link LedgerCacheService}.
 *
 * Faithful matters here: the real service sets its provenance signal in `readRows` and clears it in
 * `writeRows`/`reset`, and the screen's label reads that signal. A fake that only recorded calls would
 * let a wiring mistake — a label that outlives the rows, a live list still labelled stale — pass.
 */
function fakeCache(cache: LedgerSnapshot | null): {
  readonly service: LedgerCacheService;
  readonly written: { rows: readonly unknown[]; today: string; currency: string }[];
  readonly reads: () => number;
} {
  const staleAt = signal<string | null>(null);
  const written: { rows: readonly unknown[]; today: string; currency: string }[] = [];
  let reads = 0;

  const service = {
    staleAt: staleAt.asReadonly(),
    writeRows: (rows: readonly unknown[], today: string, currency: string) => {
      written.push({ rows, today, currency });
      staleAt.set(null);
      return Promise.resolve();
    },
    readRows: () => {
      reads += 1;
      staleAt.set(cache?.syncedAt ?? null);
      return Promise.resolve(cache);
    },
    reset: () => {
      staleAt.set(null);
    },
  } as unknown as LedgerCacheService;

  return { service, written, reads: () => reads };
}

async function mount(options: MountOptions = {}): Promise<{
  component: TransactionsComponent;
  client: { readonly query: ReturnType<typeof vi.fn> };
  variables: () => Record<string, unknown> | undefined;
  cache: ReturnType<typeof fakeCache>;
}> {
  const cache = fakeCache(options.cache ?? null);
  const client = {
    query: vi.fn((document: string, _variables?: Record<string, unknown>) => {
      if (document.includes('query Taxonomy')) {
        return Promise.resolve({
          accounts: { edges: [{ node: ACCOUNT }] },
          categories: [CATEGORY],
        });
      }
      // `query Transaction(` — the parentheses matter: the list document is `query Transactions(`.
      if (document.includes('query Transaction(')) {
        if (options.failRow === true) return Promise.reject(new Error('boom'));
        return Promise.resolve({ transaction: ROW });
      }
      if (options.failList === true) return Promise.reject(new Error('offline'));
      const rows = options.rows ?? [];
      return Promise.resolve({
        transactions: {
          totalCount: rows.length,
          pageInfo: { endCursor: null, hasNextPage: false },
          edges: rows.map((node) => ({ node })),
        },
      });
    }),
  };

  const queryMap = convertToParamMap(options.query ?? {});
  const pathMap = convertToParamMap(options.id === undefined ? {} : { id: options.id });
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      // `RouterLink` is in the template and the sheet's dismiss is a navigation, so the screen needs
      // a real router even though nothing here navigates by hand.
      provideRouter([]),
      { provide: GraphqlClient, useValue: client },
      { provide: LedgerCacheService, useValue: cache.service },
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: { queryParamMap: queryMap, paramMap: pathMap },
          queryParamMap: of(queryMap),
          paramMap: of(pathMap),
        },
      },
    ],
  });
  TestBed.overrideComponent(TransactionsComponent, {
    remove: { imports: [MoneyComponent, IconComponent, TransactionDetailComponent] },
    add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
  });

  const fixture = TestBed.createComponent(TransactionsComponent);
  fixture.detectChanges();
  // `load()` is a floating promise chain — taxonomy, then the list, then the cache write — and
  // `whenStable()` resolves as soon as the app has no queued *work*, which is not the same as the
  // chain being done. One turn reaches the list query; the cache write is one turn further. Flush a
  // few macrotasks so an assertion about what was cached cannot depend on how many `await`s the
  // failure path happened to take.
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.whenStable();
  }
  fixture.detectChanges();

  return {
    component: fixture.componentInstance,
    client,
    cache,
    variables: () => {
      const call = client.query.mock.calls.find((entry) => String(entry[0]).includes('query Transactions'));
      return call?.[1] as Record<string, unknown> | undefined;
    },
  };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('the transactions screen and a drill-through link', () => {
  it('applies the link’s filter before the first query', async () => {
    const { component, variables } = await mount({
      query: {
        from: '2026-09-01',
        to: '2026-09-30',
        kind: 'EXPENSE',
        categoryId: 'c1',
      },
    });

    expect(component.filters()).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-30',
      kind: 'EXPENSE',
      categoryId: 'c1',
    });
    // The first page is already filtered: one query, not a visible correction.
    expect(variables()).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-30',
      kind: 'EXPENSE',
      categoryId: 'c1',
    });
  });

  it('opens unfiltered when there is no drill-through, which is how the screen is normally used', async () => {
    const { component, variables } = await mount();

    expect(component.filters().from).toBe('');
    expect(component.filters().categoryId).toBe('');
    expect(variables()?.['from']).toBeUndefined();
    expect(variables()?.['categoryId']).toBeUndefined();
  });

  it('ignores a parameter the screen cannot apply rather than forwarding it', async () => {
    // `merchantId` is not an argument of the transactions query (docs/06 §8.8), and forwarding it
    // would be a validation error for a URL the user did not write.
    const { component, variables } = await mount({
      query: { merchantId: 'm1', from: '2026-09-01' },
    });

    expect(variables()).toEqual({ first: expect.any(Number), from: '2026-09-01' });
    expect(component.filters().categoryId).toBe('');
  });
});

describe('the transactions screen and a `/transactions/:id` drill-in', () => {
  it('fetches that row by id and opens it, even though the list does not contain it', async () => {
    const { component, client } = await mount({ id: 'tx-9' });

    const call = client.query.mock.calls.find((entry) =>
      String(entry[0]).includes('query Transaction('),
    );
    expect(call?.[1]).toEqual({ id: 'tx-9' });
    // The row came from the single-row query, not from the (empty) page the list loaded.
    expect(component.editing()?.id).toBe('tx-9');
    expect(component.editing()?.splits).toEqual([]);
  });

  it('does not fetch a single row when the screen is just the list', async () => {
    const { client } = await mount({ query: { from: '2026-09-01' } });
    expect(
      client.query.mock.calls.some((entry) => String(entry[0]).includes('query Transaction(')),
    ).toBe(false);
  });

  it('surfaces a refused id in the banner rather than opening an empty sheet', async () => {
    const { component } = await mount({ id: 'missing', failRow: true });

    expect(component.editing()).toBeNull();
    expect(component.error()).not.toBeNull();
  });
});

/**
 * The ledger cache, served by `/transactions` (task 4.2.8b, ADR-027, ADR-025 decision 5).
 *
 * Two properties are worth a mounted test rather than a unit one, because both are about *wiring* and
 * neither is visible from a pure function:
 *
 * 1. **only an unfiltered read is cached**, and
 * 2. **the label and the rows cannot disagree** — the cached arm is labelled, and a later live read
 *    takes the label away again.
 */
const CACHED: LedgerSnapshot = {
  syncedAt: '2026-09-20T18:00:00.000Z',
  currency: 'RSD',
  rows: [
    {
      amountMinor: '200000',
      kind: 'EXPENSE',
      occurredLocalDate: '2026-09-20',
      description: 'Lidl',
      category: { id: 'c1', name: 'Hrana' },
    },
    {
      amountMinor: '350000',
      kind: 'EXPENSE',
      occurredLocalDate: '2026-09-20',
      description: 'Gorivo',
      category: null,
    },
  ],
};

describe('the transactions screen and the ledger cache', () => {
  it('caches a successful unfiltered read, with the currency taken from the rows', async () => {
    const { cache } = await mount({ rows: [ROW] });

    expect(cache.written).toHaveLength(1);
    expect(cache.written[0]?.currency).toBe('RSD');
    expect(cache.written[0]?.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The whitelist's five fields, and a category built from the row's id and the loaded tree.
    expect(cache.written[0]?.rows).toEqual([
      {
        amountMinor: '200000',
        kind: 'EXPENSE',
        occurredLocalDate: '2026-09-20',
        description: 'Lidl',
        category: { id: 'c1', name: 'Hrana' },
      },
    ]);
  });

  it('never caches a filtered read, because a subset is not the ledger', async () => {
    // A search for "lidl" returns four rows; caching them would later present those four as the
    // Household's transactions and say nothing about the other ninety. The filter is applied through
    // the screen's own control rather than the URL: `search` is a screen-local filter, not one of the
    // drill-through keys the URL carries (docs/06 §8.4).
    const { component, cache } = await mount({ rows: [ROW] });
    expect(cache.written).toHaveLength(1);

    component.setFilter('search', 'lidl');
    await component.reload();

    // Still one write: the unfiltered first page, and nothing from the filtered read.
    expect(cache.written).toHaveLength(1);
  });

  it('serves the cache, labelled, when the read fails', async () => {
    const { component } = await mount({ failList: true, cache: CACHED });

    expect(component.cached()?.rows).toHaveLength(2);
    expect(component.cachedGroups()).toHaveLength(1);
    expect(component.cachedCount()).toBe(2);
    // One label for the serving mode (ADR-027 decision 4) — not one per row, not one per day.
    expect(component.staleLabel()).toBeTypeOf('string');
    // The failure is not an error state any more: the mode is disclosed instead.
    expect(component.error()).toBeNull();
    // The live list is cleared, so no server row can sit under a `podaci od` line it is not part of.
    expect(component.rows()).toEqual([]);
  });

  it('keeps the honest error state when the read fails and nothing was cached', async () => {
    const { component } = await mount({ failList: true });

    expect(component.cached()).toBeNull();
    expect(component.cachedGroups()).toEqual([]);
    expect(component.staleLabel()).toBeNull();
    expect(component.error()).toBeTypeOf('string');
  });

  it('refuses the cache while a filter is active, because the cache is unfiltered', async () => {
    // Serving the whole ledger after a failed *search* would answer a question the user did not ask.
    const { component } = await mount({ failList: true, cache: CACHED });
    expect(component.cached()).not.toBeNull();

    component.setFilter('search', 'lidl');
    await component.reload();

    expect(component.cached()).toBeNull();
    expect(component.error()).toBeTypeOf('string');
  });

  it('drops the label again once a live read succeeds', async () => {
    const { component, client } = await mount({ failList: true, cache: CACHED });
    expect(component.staleLabel()).not.toBeNull();

    // The next reload succeeds (a reconnect, or the retry a user triggers).
    client.query.mockImplementation((document: string) => {
      if (document.includes('query Taxonomy')) {
        return Promise.resolve({
          accounts: { edges: [{ node: ACCOUNT }] },
          categories: [CATEGORY],
        });
      }
      return Promise.resolve({
        transactions: {
          totalCount: 1,
          pageInfo: { endCursor: null, hasNextPage: false },
          edges: [{ node: ROW }],
        },
      });
    });
    await component.reload();

    expect(component.cached()).toBeNull();
    expect(component.staleLabel()).toBeNull();
    expect(component.rows()).toHaveLength(1);
  });
});
