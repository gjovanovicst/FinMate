// @vitest-environment jsdom
// FIRST import, deliberately: it loads `@angular/compiler`, and `@angular/router` is a partially
// compiled package whose module body needs the JIT compiler to already be present. ESM evaluates
// imports in declaration order, so putting any other Angular import above this one fails with
// "The injectable 'PlatformLocation' needs to be compiled using the JIT compiler".
import { initAngularTesting } from '@web-test/angular-testing';

import { CUSTOM_ELEMENTS_SCHEMA, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GraphqlClient } from '../../core/graphql/graphql.client';
import { SyncService } from '../../core/offline/sync.service';
import { MoneyComponent } from '../../shared/ui/money/money.component';
import { CaptureComponent } from './capture.component';

initAngularTesting();

/**
 * The capture screen, mounted.
 *
 * This is the first component in the repo with real behaviour worth asserting rather than a thin
 * template wrapper (which is what `apps/web/vitest.config.mts` was waiting for): it owns a debounce,
 * a request-supersede guard, and four distinct render states. The pure decisions live in
 * `capture.view.spec.ts`; what is asserted here is only what a *rendered* component can show —
 * that the field exists, that a keystroke produces rows, that the ⚪/🔴 badges appear, and that the
 * rejected arm of the union is not silently swallowed.
 *
 * The GraphQL client is stubbed. `HttpClient` is not involved: the point is the component's own
 * state machine, and a fake transport would only add a second thing that can be wrong.
 *
 * `fm-money` is replaced by a **custom element**, and that is a workaround with a precise cause:
 * Angular's JIT compiler — which is what a test runs, unlike the AOT production build — does not
 * discover `input()` **signal inputs**, so `MoneyComponent` renders with an unbound required input
 * and throws NG0950. `web:build` accepts the very same binding, so the template is not at fault and
 * the binding is still covered; what is *not* covered here is money formatting, which
 * `money-text.spec.ts` owns. Amounts are asserted on the component's own state instead.
 */

const ACCOUNTS = {
  accounts: {
    edges: [{ node: { id: 'acct-1', name: 'Everyday', currency: 'RSD', isArchived: false } }],
  },
};

const CATEGORIES = {
  categories: [
    { id: 'cat-food', name: 'Hrana', kind: 'EXPENSE', parentId: null },
    { id: 'cat-salary', name: 'Plata', kind: 'INCOME', parentId: null },
  ],
};

/** The parse response a healthy household gets for `Lidl 2000, plata 5000`. */
const PARSE = {
  captureParse: {
    parseId: 'parse-1',
    rawText: 'Lidl 2000, plata 5000',
    degraded: false,
    usedAi: false,
    unresolvedSegments: [],
    fragments: [
      {
        id: 'proposal-1',
        categoryId: 'cat-food',
        decidedBy: 'KEYWORD',
        confidence: 0.95,
        needsReview: false,
        advisory: false,
        rationale: 'KEYWORD',
        merchantId: null,
        amountMinor: '200000',
        currency: 'RSD',
        description: 'Lidl',
        needsDirectionConfirmation: false,
        alternatives: [],
      },
      {
        id: 'proposal-2',
        categoryId: null,
        decidedBy: 'FALLBACK',
        confidence: 0,
        needsReview: true,
        advisory: false,
        rationale: 'FALLBACK',
        merchantId: null,
        amountMinor: '500000',
        currency: 'RSD',
        description: 'plata',
        needsDirectionConfirmation: false,
        alternatives: [],
      },
    ],
  },
};

function stubClient(overrides: Record<string, unknown> = {}) {
  const query = vi.fn((document: string) => {
    if (document.includes('CaptureAccounts')) return Promise.resolve(ACCOUNTS);
    if (document.includes('CaptureCategories')) return Promise.resolve(CATEGORIES);
    if (document.includes('CaptureParse')) return Promise.resolve(PARSE);
    if (document.includes('UndoCapture')) return Promise.resolve({ undoCapture: 1 });
    return Promise.resolve({
      captureCommit: {
        __typename: 'CaptureCommitSuccessModel',
        replayed: false,
        committed: [
          { clientRowId: 'row-1', wasReplayed: false, transaction: { id: 'tx-1' } },
        ],
      },
    });
  });
  return { client: { query, ...overrides } as unknown as GraphqlClient, query };
}

/** The commit response for a call whose single row looked like a duplicate. */
function duplicateCommitResponse() {
  return {
    captureCommit: {
      __typename: 'CaptureCommitSuccessModel',
      replayed: false,
      reviewQueueCount: 0,
      committed: [{ clientRowId: 'row-1', wasReplayed: false, transaction: { id: 'tx-new' } }],
      duplicateSuspects: [
        {
          clientRowId: 'row-1',
          transactionId: 'tx-new',
          existingTransactionId: 'tx-old',
          similarity: 1,
          matchedOn: ['amount', 'description', 'date'],
          existingTransaction: {
            id: 'tx-old',
            description: 'Lidl',
            occurredLocalDate: '2026-09-14',
            amount: { amountMinor: '200000', currency: 'RSD' },
          },
        },
      ],
    },
  };
}

async function mount(
  client: GraphqlClient,
  sync?: Partial<SyncService>,
): Promise<{
  fixture: ReturnType<typeof TestBed.createComponent<CaptureComponent>>;
  component: CaptureComponent;
}> {
  TestBed.configureTestingModule({
    imports: [CaptureComponent],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: GraphqlClient, useValue: client },
      // A stub only where the queue's behaviour is the subject; otherwise the real service is mounted,
      // which is harmless because an empty queue sends nothing.
      ...(sync ? [{ provide: SyncService, useValue: sync as SyncService }] : []),
    ],
  });
  // `fm-money` is a custom element here; see the file header.
  TestBed.overrideComponent(CaptureComponent, {
    remove: { imports: [MoneyComponent] },
    add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
  });

  const fixture = TestBed.createComponent(CaptureComponent);
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance };
}

describe('CaptureComponent (mounted)', () => {
  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('renders the field, the examples and the empty state before anything is typed', async () => {
    const { fixture } = await mount(stubClient().client);
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect((fixture.nativeElement as HTMLElement).querySelector('textarea')).not.toBeNull();
    expect(text).toContain('Nothing to sort out yet');
    // No account: the screen must say so instead of offering a form that cannot work.
    expect(text).not.toContain('You need an account first');
  });

  it('says so when the Household has no account at all', async () => {
    const client = stubClient();
    (client.query as ReturnType<typeof vi.fn>).mockImplementation((document: string) => {
      if (document.includes('CaptureAccounts')) return Promise.resolve({ accounts: { edges: [] } });
      if (document.includes('CaptureCategories')) return Promise.resolve(CATEGORIES);
      return Promise.resolve(PARSE);
    });

    const { fixture } = await mount(client.client);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('You need an account first');
  });

  it('shows local rows with their amounts before the server answers', async () => {
    const { fixture, component } = await mount(stubClient().client);

    component.onInput('Lidl 2000, plata 5000');
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    // Local extraction is synchronous (docs/02 §3): the rows are on screen in the ⚪ state, and the
    // amounts are already exact minor units.
    expect(text).toContain('Working it out…');
    expect(component.rows()).toHaveLength(2);
    expect(component.rows()[0]!.candidates[0]!.amountMinor).toBe(200000n);
    expect(component.rows()[1]!.candidates[0]!.amountMinor).toBe(500000n);
  });

  it('fills in the confidence badge from the server response and labels the blocking lane', async () => {
    const { fixture, component } = await mount(stubClient().client);

    component.onInput('Lidl 2000, plata 5000');
    // Real timers, a real debounce: the 250 ms window is the behaviour under test.
    await new Promise((resolve) => setTimeout(resolve, 320));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.rows()[0]!.proposal?.id).toBe('proposal-1');
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Automatic');
    expect(text).toContain('95');
    // A null category is the BLOCKING lane whatever the confidence (I-8).
    expect(text).toContain('I am not sure');
    expect(component.blockedRows(component.rows())).toHaveLength(1);
  });

  it('renders the rejection arm of the union rather than treating it as a success', async () => {
    const client = stubClient();
    (client.query as ReturnType<typeof vi.fn>).mockImplementation((document: string) => {
      if (document.includes('CaptureAccounts')) return Promise.resolve(ACCOUNTS);
      if (document.includes('CaptureCategories')) return Promise.resolve(CATEGORIES);
      if (document.includes('CaptureParse')) return Promise.resolve(PARSE);
      return Promise.resolve({
        captureCommit: {
          __typename: 'CaptureCommitRejectedModel',
          code: 'NOT_FOUND',
          message: '1 row(s) could not be committed, so none were.',
          rejected: [
            {
              clientRowId: 'whatever',
              code: 'NOT_FOUND',
              message: 'Category not found.',
              field: 'categoryId',
            },
          ],
        },
      });
    });

    const { fixture, component } = await mount(client.client);
    component.onInput('Lidl 2000');
    fixture.detectChanges();
    await component.commit();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Nothing was saved');
    expect(text).toContain('Category not found.');
    // The draft survives a refused commit — the ids on the rows are what make the retry idempotent.
    expect(component.text()).toBe('Lidl 2000');
  });

  it('clears the draft after a successful commit', async () => {
    const { fixture, component } = await mount(stubClient().client);
    component.onInput('Lidl 2000');
    fixture.detectChanges();

    await component.commit();
    fixture.detectChanges();

    expect(component.text()).toBe('');
    expect(component.rows()).toHaveLength(0);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Added 1.');
  });

  it('queues the batch and clears the draft when the commit fails retryably (F-26)', async () => {
    // An offline commit is not an error the user must resolve: the batch goes to the outbox with the
    // ids it was built with, the composer clears, and the next capture is never blocked (docs/02 §4.3).
    const client = stubClient();
    (client.query as ReturnType<typeof vi.fn>).mockImplementation((document: string) => {
      if (document.includes('CaptureAccounts')) return Promise.resolve(ACCOUNTS);
      if (document.includes('CaptureCategories')) return Promise.resolve(CATEGORIES);
      if (document.includes('CaptureParse')) return Promise.resolve(PARSE);
      // How a genuinely offline client fails: status 0, which `isRetryable` treats as retryable.
      return Promise.reject({ status: 0, message: 'Failed to fetch', errors: [] });
    });

    const enqueueCapture = vi.fn().mockResolvedValue({ seq: 1 });
    const { fixture, component } = await mount(client.client, { enqueueCapture });
    component.onInput('Lidl 2000');
    fixture.detectChanges();

    await component.commit();
    fixture.detectChanges();

    expect(enqueueCapture).toHaveBeenCalledTimes(1);
    const call = enqueueCapture.mock.calls[0];
    const input = call?.[0] as { readonly rows: readonly { readonly idempotencyKey: string }[] };
    const preview = call?.[1] as readonly { readonly rawText: string; readonly localCategoryId: string | null }[];
    expect(input.rows).toHaveLength(1);
    expect(preview[0]?.rawText).toBe('Lidl 2000');

    expect(component.text()).toBe('');
    expect(component.rows()).toHaveLength(0);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Saved, waiting to send (1)');
  });

  it('never queues a refused commit, and keeps the draft', async () => {
    const client = stubClient();
    (client.query as ReturnType<typeof vi.fn>).mockImplementation((document: string) => {
      if (document.includes('CaptureAccounts')) return Promise.resolve(ACCOUNTS);
      if (document.includes('CaptureCategories')) return Promise.resolve(CATEGORIES);
      if (document.includes('CaptureParse')) return Promise.resolve(PARSE);
      return Promise.resolve({
        captureCommit: {
          __typename: 'CaptureCommitRejectedModel',
          code: 'NOT_FOUND',
          message: '1 row(s) could not be committed, so none were.',
          rejected: [
            { clientRowId: 'whatever', code: 'NOT_FOUND', message: 'Category not found.', field: 'categoryId' },
          ],
        },
      });
    });

    const enqueueCapture = vi.fn();
    const { fixture, component } = await mount(client.client, { enqueueCapture });
    component.onInput('Lidl 2000');
    fixture.detectChanges();

    await component.commit();
    fixture.detectChanges();

    expect(enqueueCapture).not.toHaveBeenCalled();
    expect(component.text()).toBe('Lidl 2000');
  });

  it('shows the duplicate chip against the row the user typed, and undoes it in one call', async () => {
    const client = stubClient();
    (client.query as ReturnType<typeof vi.fn>).mockImplementation((document: string) => {
      if (document.includes('CaptureAccounts')) return Promise.resolve(ACCOUNTS);
      if (document.includes('CaptureCategories')) return Promise.resolve(CATEGORIES);
      if (document.includes('CaptureParse')) return Promise.resolve(PARSE);
      if (document.includes('UndoCapture')) return Promise.resolve({ undoCapture: 1 });
      return Promise.resolve(duplicateCommitResponse());
    });

    const { fixture, component } = await mount(client.client);
    component.onInput('Lidl 2000');
    fixture.detectChanges();
    await component.commit();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Looks like a duplicate');
    // The chip names what the user just typed, and what it resembles — the preview is gone by now,
    // so both have to come from the summary.
    expect(text).toContain('Lidl 2000');
    expect(text).toContain('Lidl');
    expect(text).toContain('same amount');

    await component.undoDuplicates();
    fixture.detectChanges();

    const undoCall = (client.query as ReturnType<typeof vi.fn>).mock.calls.find((call) =>
      String(call[0]).includes('UndoCapture'),
    );
    expect(undoCall?.[1]).toEqual({ transactionIds: ['tx-new'] });
    // The panel is gone: there is nothing left to undo, so it must not linger offering it.
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('Looks like a duplicate');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Undone: 1.');
  });

  it('undoes the whole batch from the toast', async () => {
    const client = stubClient();
    const { fixture, component } = await mount(client.client);
    component.onInput('Lidl 2000');
    fixture.detectChanges();
    await component.commit();
    fixture.detectChanges();

    await component.undoAll();
    fixture.detectChanges();

    const undoCall = (client.query as ReturnType<typeof vi.fn>).mock.calls.find((call) =>
      String(call[0]).includes('UndoCapture'),
    );
    expect(undoCall?.[1]).toEqual({ transactionIds: ['tx-1'] });
  });
});
