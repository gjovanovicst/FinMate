// @vitest-environment jsdom
// FIRST import, deliberately: it loads `@angular/compiler`, and `@angular/router` is a partially
// compiled package whose module body needs the JIT compiler to already be present (see
// `capture.component.spec.ts` for the full reasoning).
import { initAngularTesting } from '@web-test/angular-testing';

import { CUSTOM_ELEMENTS_SCHEMA, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GraphqlClient } from '../../core/graphql/graphql.client';
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
 * query, so the user never sees an unfiltered list replaced by a filtered one.
 *
 * `fm-money` and the detail sheet are custom elements here, as everywhere else in this suite: the
 * money component's required input throws NG0950 under JIT before its binding lands, and the sheet
 * owns its own spec.
 */
const ACCOUNT = { id: 'a1', name: 'Tekući', currency: 'RSD' };
const CATEGORY = { id: 'c1', name: 'Hrana', kind: 'EXPENSE', path: ['Hrana'] };

async function mount(query: Record<string, string>): Promise<{
  component: TransactionsComponent;
  variables: () => Record<string, unknown> | undefined;
}> {
  const client = {
    query: vi.fn((document: string, _variables?: Record<string, unknown>) => {
      if (document.includes('query Taxonomy')) {
        return Promise.resolve({
          accounts: { edges: [{ node: ACCOUNT }] },
          categories: [CATEGORY],
        });
      }
      return Promise.resolve({
        transactions: {
          totalCount: 0,
          pageInfo: { endCursor: null, hasNextPage: false },
          edges: [],
        },
      });
    }),
  };

  const paramMap = convertToParamMap(query);
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: GraphqlClient, useValue: client },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: paramMap }, queryParamMap: of(paramMap) } },
    ],
  });
  TestBed.overrideComponent(TransactionsComponent, {
    remove: { imports: [MoneyComponent, TransactionDetailComponent] },
    add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
  });

  const fixture = TestBed.createComponent(TransactionsComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();

  return {
    component: fixture.componentInstance,
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
      from: '2026-09-01',
      to: '2026-09-30',
      kind: 'EXPENSE',
      categoryId: 'c1',
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
    const { component, variables } = await mount({});

    expect(component.filters().from).toBe('');
    expect(component.filters().categoryId).toBe('');
    expect(variables()?.['from']).toBeUndefined();
    expect(variables()?.['categoryId']).toBeUndefined();
  });

  it('ignores a parameter the screen cannot apply rather than forwarding it', async () => {
    // `merchantId` is not an argument of the transactions query (docs/06 §8.8), and forwarding it
    // would be a validation error for a URL the user did not write.
    const { component, variables } = await mount({ merchantId: 'm1', from: '2026-09-01' });

    expect(variables()).toEqual({ first: expect.any(Number), from: '2026-09-01' });
    expect(component.filters().categoryId).toBe('');
  });
});
