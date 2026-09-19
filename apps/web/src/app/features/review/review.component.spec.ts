// @vitest-environment jsdom
// FIRST import, deliberately: it loads `@angular/compiler`, and `@angular/router` is a partially
// compiled package whose module body needs the JIT compiler to already be present (see
// `capture.component.spec.ts` for the full reasoning).
import { initAngularTesting } from '@web-test/angular-testing';

import { CUSTOM_ELEMENTS_SCHEMA, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GraphqlClient } from '../../core/graphql/graphql.client';
import { ReviewQueueStore } from '../../core/review/review-queue.store';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { MoneyComponent } from '../../shared/ui/money/money.component';
import { ReviewComponent } from './review.component';

initAngularTesting();

/**
 * The review queue, mounted.
 *
 * The pure decisions live in `review.view.spec.ts`; what is asserted here is only what a *rendered*
 * component can prove, and each of these is something that was invisible before this screen existed:
 *
 *  - a queued row is actually shown, with its badge, its reason and its alternatives;
 *  - the Resolve button is **refused** on an uncategorised row until a category is chosen, which is
 *    docs/02 §4.6's "the queue never auto-resolves anything" enforced where the click happens;
 *  - the "Zapamti za ubuduće" checkbox is **absent** where the server would ignore it;
 *  - the mutation carries the plan the pure layer worked out, including the two booleans;
 *  - the server's `reviewQueueCount` reaches the shared store, which is what the nav badge draws.
 *
 * The GraphQL client is stubbed, and `fm-money` is swapped for a custom element because Angular's
 * JIT does not discover `input()` signal inputs (NG0950) — both for the reasons documented in
 * `capture.component.spec.ts`.
 */

const ROWS = [
  {
    id: 'item-1',
    reason: 'LOW_CONFIDENCE',
    confidence: 0.55,
    suggestedCategoryId: 'cat-food',
    candidates: [
      { categoryId: 'cat-food', confidence: 0.55 },
      { categoryId: 'cat-house', confidence: 0.3 },
    ],
    ageHours: 5,
    transaction: {
      id: 'tx-1',
      kind: 'EXPENSE',
      status: 'PENDING',
      amount: { amountMinor: '200000', currency: 'RSD' },
      description: 'Lidl',
      occurredLocalDate: '2026-09-14',
      categoryId: 'cat-food',
      merchantId: 'merchant-lidl',
      counterpartyId: null,
    },
  },
  {
    id: 'item-2',
    reason: 'UNCATEGORISED',
    confidence: 0,
    suggestedCategoryId: null,
    candidates: [],
    ageHours: 1,
    transaction: {
      id: 'tx-2',
      kind: 'EXPENSE',
      status: 'PENDING',
      amount: { amountMinor: '85000', currency: 'RSD' },
      description: 'Nepoznato',
      occurredLocalDate: '2026-09-15',
      categoryId: null,
      merchantId: null,
      counterpartyId: null,
    },
  },
];

const CATEGORIES = {
  categories: [
    { id: 'cat-food', kind: 'EXPENSE', path: ['Hrana', 'Supermarket'] },
    { id: 'cat-house', kind: 'EXPENSE', path: ['Kuća', 'Septička jama'] },
    { id: 'cat-salary', kind: 'INCOME', path: ['Plata'] },
  ],
};

const NAMES = {
  merchants: { edges: [{ node: { id: 'merchant-lidl', name: 'Lidl' } }] },
  counterparties: { edges: [] },
};

interface StubOptions {
  readonly rows?: readonly unknown[];
  readonly count?: number;
  readonly resolve?: (variables: Record<string, unknown>) => unknown;
  readonly queueFails?: boolean;
}

/** Records every mutation's variables and answers the four queries the screen makes. */
function stubClient(options: StubOptions = {}) {
  const mutations: Record<string, unknown>[] = [];

  const query = vi.fn((document: string, variables?: Record<string, unknown>) => {
    if (document.includes('ReviewQueueCount')) {
      return Promise.resolve({ reviewQueueCount: options.count ?? 0 });
    }
    if (document.includes('ReviewCategories')) return Promise.resolve(CATEGORIES);
    if (document.includes('ReviewMerchantNames') || document.includes('ReviewCounterpartyNames')) {
      return Promise.resolve(NAMES);
    }
    if (document.includes('ResolveReviewItem')) {
      mutations.push(variables?.['input'] as Record<string, unknown>);
      return Promise.resolve(
        options.resolve?.(variables ?? {}) ?? {
          resolveReviewItem: { resolvedSimilarCount: 1, reviewQueueCount: 1, ruleCreated: null },
        },
      );
    }
    if (document.includes('ReviewQueue')) {
      if (options.queueFails) return Promise.reject(new Error('network down'));
      return Promise.resolve({ reviewQueue: { edges: (options.rows ?? ROWS).map((node) => ({ node })) } });
    }
    return Promise.reject(new Error(`unexpected document: ${document.slice(0, 60)}`));
  });

  return { client: { query } as unknown as GraphqlClient, query, mutations };
}

async function mount(client: GraphqlClient): Promise<{
  fixture: ReturnType<typeof TestBed.createComponent<ReviewComponent>>;
  component: ReviewComponent;
  store: ReviewQueueStore;
}> {
  TestBed.configureTestingModule({
    imports: [ReviewComponent],
    providers: [provideZonelessChangeDetection(), { provide: GraphqlClient, useValue: client }],
  });
  // `fm-money` is a custom element here; see the file header.
  TestBed.overrideComponent(ReviewComponent, {
    remove: { imports: [MoneyComponent, IconComponent] },
    add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
  });

  const fixture = TestBed.createComponent(ReviewComponent);
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, store: TestBed.inject(ReviewQueueStore) };
}

function text(fixture: { nativeElement: unknown }): string {
  return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

function rows(fixture: { nativeElement: unknown }): HTMLElement[] {
  return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('.row'));
}

/** The Resolve button of the row at `index`. */
function resolveButton(fixture: { nativeElement: unknown }, index: number): HTMLButtonElement {
  const button = rows(fixture)[index]?.querySelector<HTMLButtonElement>('.btn--primary');
  if (!button) throw new Error(`no resolve button on row ${index}`);
  return button;
}

function rememberBox(fixture: { nativeElement: unknown }, index: number): HTMLInputElement | null {
  return rows(fixture)[index]?.querySelector<HTMLInputElement>('.check--remember input') ?? null;
}

function similarBox(fixture: { nativeElement: unknown }, index: number): HTMLInputElement | null {
  return rows(fixture)[index]?.querySelector<HTMLInputElement>('.check--similar input') ?? null;
}

describe('ReviewComponent (mounted)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders every queued row with its badge, reason and alternatives', async () => {
    const { fixture } = await mount(stubClient().client);
    const body = text(fixture);

    expect(body).toContain('Lidl');
    expect(body).toContain('Nepoznato');
    // The badge is the glyph AND the label AND the percentage — never a bare colour (docs/02 §3).
    expect(body).toContain('55 %');
    expect(body).toContain('Hrana › Supermarket');
    expect(rows(fixture)).toHaveLength(2);
  });

  it('names the reason each row is here', async () => {
    const { fixture } = await mount(stubClient().client);
    const body = text(fixture);
    expect(body).toContain('Not sure enough');
    expect(body).toContain('No category');
  });

  it('shows the all-caught-up state when the queue is empty', async () => {
    const { fixture } = await mount(stubClient({ rows: [] }).client);
    expect(text(fixture)).toContain('Nothing is waiting');
    expect(rows(fixture)).toHaveLength(0);
  });

  it('surfaces a failed load and offers a retry instead of an empty queue', async () => {
    // An empty queue and an unreadable queue look identical unless the error is stated, and one of
    // them means "all done" and the other means "you cannot know".
    const { fixture } = await mount(stubClient({ queueFails: true }).client);
    const body = text(fixture);
    expect(body).toContain('network down');
    expect(body).toContain('Try again');
    expect(body).not.toContain('Nothing is waiting');
  });

  it('refuses to resolve an uncategorised row until a category is chosen', async () => {
    const { fixture, component } = await mount(stubClient().client);
    // Row 2 is uncategorised: nothing is chosen, so there is no plan and the control is disabled.
    expect(component.resolvePlan(component.items()[1]!, null)).toBeNull();
    expect(resolveButton(fixture, 1).disabled).toBe(true);
    // Row 1 has a suggestion, so it is resoluble as it stands.
    expect(resolveButton(fixture, 0).disabled).toBe(false);
  });

  it('sends ACCEPT_SUGGESTION for a confirmed suggestion, with no learning flags', async () => {
    const stub = stubClient();
    const { fixture } = await mount(stub.client);

    resolveButton(fixture, 0).click();
    await fixture.whenStable();

    expect(stub.mutations).toHaveLength(1);
    expect(stub.mutations[0]).toEqual({
      id: 'item-1',
      action: 'ACCEPT_SUGGESTION',
      categoryId: null,
      rememberForFuture: false,
      applyToSimilar: false,
    });
  });

  it('hides the remember checkbox where the server would ignore it', async () => {
    const { fixture } = await mount(stubClient().client);
    // Row 1 is already on its suggested category: accepting it is not a Correction, so
    // `rememberForFuture` would be dropped. The row says so instead of offering a dead control.
    expect(rememberBox(fixture, 0)).toBeNull();
    expect(text(fixture)).toContain('nothing new to remember');
  });

  it('sends SET_CATEGORY with the chosen alternative and the remember flag', async () => {
    const stub = stubClient();
    const { fixture, component } = await mount(stub.client);

    // `1` picks the first alternative on the cursor row. Then move to the uncategorised row and choose
    // a category there, so the write is a genuine correction rather than a confirmation.
    const list = (fixture.nativeElement as HTMLElement).querySelector('.queue')!;
    list.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
    fixture.detectChanges();
    expect(component.chosenOf(component.items()[0]!)).toBe('cat-food');

    component.choose('item-2', 'cat-house');
    fixture.detectChanges();

    const box = rememberBox(fixture, 1);
    expect(box).not.toBeNull();
    box!.click();
    fixture.detectChanges();

    resolveButton(fixture, 1).click();
    await fixture.whenStable();

    expect(stub.mutations[0]).toEqual({
      id: 'item-2',
      action: 'SET_CATEGORY',
      categoryId: 'cat-house',
      rememberForFuture: true,
      applyToSimilar: false,
    });
  });

  it('offers apply-to-similar only on a row with a resolved entity', async () => {
    const { fixture, component } = await mount(stubClient().client);
    expect(component.canApplyToSimilar(component.items()[0]!)).toBe(true);
    expect(component.canApplyToSimilar(component.items()[1]!)).toBe(false);
    expect(similarBox(fixture, 0)).not.toBeNull();
    expect(similarBox(fixture, 1)).toBeNull();
  });

  it('removes the resolved row and applies the server count to the badge store', async () => {
    const stub = stubClient({
      resolve: () => ({
        resolveReviewItem: { resolvedSimilarCount: 1, reviewQueueCount: 1, ruleCreated: null },
      }),
    });
    const { fixture, component, store } = await mount(stub.client);
    expect(component.items()).toHaveLength(2);

    resolveButton(fixture, 0).click();
    await fixture.whenStable();

    expect(component.items().map((row) => row.id)).toEqual(['item-2']);
    // The count the nav badge draws comes from the server, never from a local guess.
    expect(store.count()).toBe(1);
  });

  it('announces the rule it created', async () => {
    const stub = stubClient({
      // The shell has already read the count, so the store knows the queue had rows to clear.
      count: 2,
      resolve: () => ({
        resolveReviewItem: {
          resolvedSimilarCount: 1,
          reviewQueueCount: 0,
          ruleCreated: { id: 'rule-1', name: 'Lidl → Hrana' },
        },
      }),
    });
    const { fixture, component } = await mount(stub.client);

    resolveButton(fixture, 0).click();
    await fixture.whenStable();

    expect(component.announcement()).toContain('Rule created: Lidl → Hrana');
    // The queue went to zero, so the one-per-session cleared notice shows.
    expect(component.cleared()).toBe(true);
  });

  it('keeps the row and reports the failure when a resolve fails', async () => {
    // A failed resolve that removed the row optimistically would lose the user's decision silently.
    const stub = stubClient({
      resolve: () => {
        throw new Error('conflict');
      },
    });
    const { fixture, component } = await mount(stub.client);

    resolveButton(fixture, 0).click();
    await fixture.whenStable();

    expect(component.items()).toHaveLength(2);
    expect(text(fixture)).toContain('conflict');
  });

  it('moves the cursor with j and clamps at the end', async () => {
    const { fixture, component } = await mount(stubClient().client);
    const list = (fixture.nativeElement as HTMLElement).querySelector('.queue')!;

    expect(component.cursor()).toBe(0);
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    fixture.detectChanges();
    expect(component.cursor()).toBe(1);
    expect(component.announcement()).toContain('Row 2 of 2');

    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    fixture.detectChanges();
    expect(component.cursor()).toBe(1);
  });

  it('ignores the shortcuts while the category select has focus', async () => {
    // docs/02 §8: a shortcut never fires inside a form control. A select also consumes 1-3 itself.
    const { fixture, component } = await mount(stubClient().client);
    const select = rows(fixture)[0]!.querySelector('select')!;

    select.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    fixture.detectChanges();
    expect(component.cursor()).toBe(0);
  });

  it('loads the whole queue again when a sweep resolved more than one row', async () => {
    // The client cannot know which peers were swept, so the list is re-read rather than guessed at.
    const stub = stubClient({
      resolve: () => ({
        resolveReviewItem: { resolvedSimilarCount: 4, reviewQueueCount: 0, ruleCreated: null },
      }),
    });
    const { fixture } = await mount(stub.client);
    const queueCalls = () =>
      stub.query.mock.calls.filter(([document]) => String(document).includes('reviewQueue(first:'))
        .length;
    const before = queueCalls();

    resolveButton(fixture, 0).click();
    await fixture.whenStable();

    expect(queueCalls()).toBe(before + 1);
  });
});
