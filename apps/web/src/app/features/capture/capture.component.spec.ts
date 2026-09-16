// @vitest-environment jsdom
// FIRST import, deliberately: it loads `@angular/compiler`, and `@angular/router` is a partially
// compiled package whose module body needs the JIT compiler to already be present. ESM evaluates
// imports in declaration order, so putting any other Angular import above this one fails with
// "The injectable 'PlatformLocation' needs to be compiled using the JIT compiler".
import { initAngularTesting } from '@web-test/angular-testing';

import { CUSTOM_ELEMENTS_SCHEMA, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthStore } from '../../core/auth/auth.store';
import { GraphqlClient } from '../../core/graphql/graphql.client';
import { SyncService } from '../../core/offline/sync.service';
import { MoneyComponent } from '../../shared/ui/money/money.component';
import { ConsentSheetComponent } from '../../shared/ui/consent-sheet/consent-sheet.component';
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
  role = 'OWNER',
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
      { provide: AuthStore, useValue: { role: signal(role) } },
      // A stub only where the queue's behaviour is the subject; otherwise the real service is mounted,
      // which is harmless because an empty queue sends nothing.
      ...(sync ? [{ provide: SyncService, useValue: sync as SyncService }] : []),
    ],
  });
  // `fm-money` and the consent sheet are custom elements here; see the file header. The sheet is opaque
  // for the same reason `fm-money` is — the JIT renderer cannot bind an `input()` signal child, so a
  // mounted sheet would throw NG0950. Its own copy and verbs are `consent-sheet.component.spec.ts`'s
  // subject; what a *capture* test can prove is the trigger, which is this component's `askKind`.
  TestBed.overrideComponent(CaptureComponent, {
    remove: { imports: [MoneyComponent, ConsentSheetComponent] },
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

/**
 * The first-use consent sheet's trigger — docs/08 §6.6, ADR-032, task 5.2a.
 *
 * §6.6 asks for the question "at **first use**, not buried in onboarding", and the first use is the first
 * fragment rules resolution cannot finish. So the trigger is asserted here, at the moment a degraded
 * preview lands, and the four ways it must stay silent are each a test: a preview that was *not* degraded
 * has no question in it, a Household that has already decided is not asked again (asking a settled
 * question is the nagging §6.6 names as a dark pattern), a deployment that routes nothing has nothing to
 * permit, and a MEMBER cannot decide it and would only be interrupted to be told so.
 *
 * The sheet's own copy is not re-asserted: it is a custom element here, and
 * `consent-sheet.component.spec.ts` mounts it directly. What is proved below is the trigger and the two
 * ways out — a recorded answer and a deferral.
 */

/** The egress table a deployment that needs permission has: DeepSeek's own platform, outside the EEA. */
const CONSENT_ROUTE = {
  purpose: 'AI_DATA_PROCESSING',
  task: 'CLASSIFY',
  endpoint: 'DEEPSEEK_GLOBAL',
  provider: 'DEEPSEEK',
  region: 'NON_EEA',
  requiresConsent: true,
};

/**
 * The same preview as `PARSE`, with the server reporting that it fell through to a degraded path.
 *
 * `rawText` is filled in from the request, as the API echoes it: the component discards an answer whose
 * `rawText` is no longer the field's text, so a fixture with a fixed name would be dropped as stale.
 */
function degradedParse(rawText: string) {
  return { captureParse: { ...PARSE.captureParse, rawText, degraded: true, usedAi: false } };
}

interface ConsentOptions {
  readonly routes?: readonly unknown[];
  readonly records?: readonly { kind: string; state: string }[];
  /** Reject the write, to prove a refused decision does not look recorded. */
  readonly refuseWrite?: boolean;
}

/**
 * A client that also answers the consent documents, with the state the API would hold.
 *
 * `recordAiConsent` appends to the same list `aiConsents` reads, because that is what the table does
 * (append-only, newest row wins) — so a test can watch a *grant* turn the next question off for the
 * right reason rather than because the stub was told to.
 */
function consentClient(options: ConsentOptions = {}) {
  const records = [...(options.records ?? [])];
  const routes = options.routes ?? [CONSENT_ROUTE];
  const base = stubClient();
  const query = vi.fn((document: string, variables?: Record<string, unknown>) => {
    if (document.includes('CaptureParse')) {
      return Promise.resolve(degradedParse((variables as { text: string }).text));
    }
    if (document.includes('RecordAiConsent')) {
      if (options.refuseWrite === true) return Promise.reject(new Error('refused'));
      const input = (variables as { input: { kind: string; state: string } }).input;
      records.push({ kind: input.kind, state: input.state });
      return Promise.resolve({ recordAiConsent: { kind: input.kind, state: input.state } });
    }
    if (document.includes('Consent')) {
      // A **copy**, because a real answer arrives as freshly parsed JSON: `signal.set` ignores an
      // identical reference, so handing back the same array would leave `askable` cached on the state
      // the first read returned and hide the very transition under test.
      return Promise.resolve({ aiConsents: [...records], aiEgress: routes });
    }
    return (base.query as (d: string, v?: Record<string, unknown>) => unknown)(document, variables);
  });
  return { client: { query } as unknown as GraphqlClient, query, records };
}

/** Type the text and let the 250 ms debounce fire for real, then let the render settle. */
async function typeAndParse(
  fixture: { whenStable: () => Promise<void>; detectChanges: () => void },
  component: CaptureComponent,
  text = 'Lidl mesec',
): Promise<void> {
  component.onInput(text);
  await new Promise((resolve) => setTimeout(resolve, 320));
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('CaptureComponent — the first-use consent question', () => {
  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('asks when a degraded preview could have used a model it has no permission for', async () => {
    const { client } = consentClient();
    const { fixture, component } = await mount(client);

    await typeAndParse(fixture, component);

    expect(component.degraded()).toBe(true);
    expect(component.askKind()).toBe('AI_DATA_PROCESSING');
    // The sheet is on screen, and it is the screen's own question — not a settings link.
    expect((fixture.nativeElement as HTMLElement).querySelector('fm-consent-sheet')).not.toBeNull();
  });

  it('stays silent when the rules finished the job without a model', async () => {
    const client = stubClient();
    const { fixture, component } = await mount(client.client);

    await typeAndParse(fixture, component);

    expect(component.degraded()).toBe(false);
    expect(component.askKind()).toBeNull();
  });

  it('does not ask a Household that has already decided', async () => {
    // Declined, then the same entry typed again: the way back is /settings, not a second interruption.
    const { client } = consentClient({ records: [{ kind: 'AI_DATA_PROCESSING', state: 'DECLINED' }] });
    const { fixture, component } = await mount(client);

    await typeAndParse(fixture, component);

    expect(component.askKind()).toBeNull();
  });

  it('does not ask when the deployment routes nothing', async () => {
    // The inert deployment: there is no permission to request, so a question would advertise a decision
    // that does not exist.
    const { client } = consentClient({ routes: [] });
    const { fixture, component } = await mount(client);

    await typeAndParse(fixture, component);

    expect(component.askKind()).toBeNull();
  });

  it('does not ask a MEMBER, who cannot answer it', async () => {
    const { client } = consentClient();
    const { fixture, component } = await mount(client, undefined, 'MEMBER');

    await typeAndParse(fixture, component);

    expect(component.mayChangeConsent()).toBe(false);
    expect(component.askKind()).toBeNull();
  });

  it('asks about the purpose the server routes, not one this screen assumes', async () => {
    // Only receipts need permission here, so a hardcoded "text" question would ask about traffic this
    // deployment does not send.
    const { client } = consentClient({
      routes: [{ ...CONSENT_ROUTE, purpose: 'CLOUD_OCR', task: 'OCR' }],
    });
    const { fixture, component } = await mount(client);

    await typeAndParse(fixture, component);

    expect(component.askKind()).toBe('CLOUD_OCR');
  });

  it('records an answer on the capture surface and closes the question', async () => {
    const { client, query } = consentClient();
    const { fixture, component } = await mount(client);
    await typeAndParse(fixture, component);

    await component.answerConsent('AI_DATA_PROCESSING', 'GRANTED');
    fixture.detectChanges();

    const write = query.mock.calls.find((call) => String(call[0]).includes('RecordAiConsent'));
    // The surface is evidence: a record can be traced to the screen that showed the copy.
    expect(write?.[1]).toMatchObject({
      input: { kind: 'AI_DATA_PROCESSING', state: 'GRANTED', surface: 'capture' },
    });
    expect(component.askKind()).toBeNull();
    // And the grant is read back, so the next degraded preview finds a decided question.
    expect(component.consent.states().some((entry) => entry.state === 'GRANTED')).toBe(true);
  });

  it('asks the next purpose once the first one is answered', async () => {
    // Two permissions needed: the question is held as a purpose, so answering one cannot swallow the
    // other.
    const { client } = consentClient({
      routes: [CONSENT_ROUTE, { ...CONSENT_ROUTE, purpose: 'CLOUD_OCR', task: 'OCR' }],
    });
    const { fixture, component } = await mount(client);
    await typeAndParse(fixture, component);
    expect(component.askKind()).toBe('AI_DATA_PROCESSING');

    await component.answerConsent('AI_DATA_PROCESSING', 'GRANTED');
    await typeAndParse(fixture, component, 'Lidl mesec 2');

    expect(component.askKind()).toBe('CLOUD_OCR');
  });

  it('writes nothing for "Not now", and does not ask again in this visit', async () => {
    const { client, query } = consentClient();
    const { fixture, component } = await mount(client);
    await typeAndParse(fixture, component);

    component.dismissConsent('AI_DATA_PROCESSING');
    fixture.detectChanges();
    expect(component.askKind()).toBeNull();

    await typeAndParse(fixture, component, 'Lidl mesec 2');

    // A deferral is not a decision: no row was written for it...
    expect(query.mock.calls.some((call) => String(call[0]).includes('RecordAiConsent'))).toBe(false);
    // ...and the second degraded preview does not reopen the question this visit.
    expect(component.askKind()).toBeNull();
  });

  it('says nothing about consent when the read failed on a screen that works offline', async () => {
    // The capture screen queues offline, so a failed consent *read* must not turn into a red alert on it:
    // nothing was attempted and the user has nothing to retry. The message belongs to a refused write.
    const client = stubClient();
    (client.query as ReturnType<typeof vi.fn>).mockImplementation((document: string) => {
      if (document.includes('Consent')) return Promise.reject(new Error('offline'));
      return (stubClient().query as (d: string) => unknown)(document);
    });
    const { fixture, component } = await mount(client.client);

    await typeAndParse(fixture, component);

    expect(component.askKind()).toBeNull();
    expect((fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')).toBeNull();
  });

  it('keeps the question open when the write is refused', async () => {
    const { client } = consentClient({ refuseWrite: true });
    const { fixture, component } = await mount(client);
    await typeAndParse(fixture, component);

    await component.answerConsent('AI_DATA_PROCESSING', 'GRANTED');
    fixture.detectChanges();

    // Closing it would look like the decision had been recorded — the one thing this screen must not
    // appear to have done.
    expect(component.askKind()).toBe('AI_DATA_PROCESSING');
    expect(component.consent.error()).not.toBeNull();
    expect((fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')).not.toBeNull();
  });
});
