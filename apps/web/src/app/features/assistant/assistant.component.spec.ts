// @vitest-environment jsdom
// FIRST import, deliberately: it loads `@angular/compiler`, and `@angular/router` is a partially
// compiled package whose module body needs the JIT compiler to already be present (see
// `capture.component.spec.ts` for the full reasoning).
import { initAngularTesting } from '@web-test/angular-testing';

import { ApplicationRef, CUSTOM_ELEMENTS_SCHEMA, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GraphQLRequestError, GraphqlClient } from '../../core/graphql/graphql.client';
import { MoneyComponent } from '../../shared/ui/money/money.component';
import { AssistantComponent } from './assistant.component';

initAngularTesting();

/**
 * The assistant screen, mounted.
 *
 * The decisions live in `assistant.view.spec.ts`; what a *rendered* component proves beyond them is
 * that the composer actually asks, that a refusal offers chips that ask again, that the figures go
 * through `fm-money`, and — since 4.3.7b — that **how the answer was worded is disclosed inside the
 * provenance panel, and no diagnostic machine string ever reaches the page**.
 */
const ANSWER = {
  id: 'a1',
  question: 'koliko sam potrošio ovog meseca',
  intent: 'SPEND_TOTAL',
  answered: true,
  answerText: 'You spent 46.650,00 RSD.',
  suggestions: [] as string[],
  narrationMode: 'TEMPLATE_FALLBACK',
  latencyMs: 20,
  costMicros: null,
  reason: 'AI_UNAVAILABLE:no-provider-configured',
  facts: {
    template: 'SPEND_TOTAL',
    rows: [{ label: 'Hrana', value: '1745000', formatted: '17.450,00 RSD' }],
    totals: [
      { label: 'Spending', money: { amountMinor: '4665000', currency: 'RSD' }, formatted: '46.650,00 RSD' },
    ],
    formatted: { headline: '46.650,00 RSD' },
  },
  provenance: {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    transactionCount: 3,
    sourceQuery: 'spend.total.v1',
    filters: { kind: 'EXPENSE' },
    computedAt: '2026-09-20T10:00:00.000Z',
    ledgerCurrency: 'RSD',
  },
  drillThrough: {
    route: '/transactions',
    transactionIds: [],
    filter: { from: '2026-09-01', to: '2026-09-30', kind: 'EXPENSE' },
  },
};

async function mount(
  respond?: (query: string, variables?: Record<string, unknown>) => unknown,
): Promise<{
  fixture: ReturnType<typeof TestBed.createComponent<AssistantComponent>>;
  client: { query: ReturnType<typeof vi.fn> };
}> {
  const client = {
    query: vi.fn((query: string, variables?: Record<string, unknown>) => {
      if (respond) return Promise.resolve(respond(query, variables));
      if (query.includes('query AssistantSuggestions')) {
        return Promise.resolve({ assistantSuggestions: ['Koliko sam potrošio ovog meseca?'] });
      }
      return Promise.resolve({ assistantAnswer: ANSWER });
    }),
  };

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: GraphqlClient, useValue: client },
    ],
  });

  // `fm-money` is a custom element in a mounted spec, like everywhere else in this suite: its
  // `amount` input is `input.required`, and the JIT-rendered child throws NG0950 when the harness
  // evaluates it before the binding lands. What this file proves is that the figures are *handed* to
  // it; the formatting itself is `money.spec.ts`'s and the value shape is the view spec's.
  TestBed.overrideComponent(AssistantComponent, {
    remove: { imports: [MoneyComponent] },
    add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
  });

  const fixture = TestBed.createComponent(AssistantComponent);
  // Attached to the document: an element outside it cannot take focus, so a focus assertion would
  // pass vacuously against `document.activeElement`.
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  // `afterNextRender` runs on an application tick, not on a bare `detectChanges`, so the tick is what
  // gives the focus-on-entry behaviour its chance in a zoneless harness.
  TestBed.inject(ApplicationRef).tick();
  await fixture.whenStable();
  return { fixture, client };
}

function textOf(fixture: ReturnType<typeof TestBed.createComponent<AssistantComponent>>): string {
  return fixture.nativeElement.textContent ?? '';
}

async function typeAndAsk(
  fixture: ReturnType<typeof TestBed.createComponent<AssistantComponent>>,
  question: string,
): Promise<void> {
  const component = fixture.componentInstance;
  component.question.set(question);
  await component.ask();
  fixture.detectChanges();
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('the assistant screen', () => {
  it('starts with the API’s own questions as chips, not a copy of them', async () => {
    const { fixture, client } = await mount();

    expect(textOf(fixture)).toContain('Koliko sam potrošio ovog meseca?');
    const queries = client.query.mock.calls.map((call) => String(call[0]));
    expect(queries.some((query) => query.includes('assistantSuggestions'))).toBe(true);
  });

  it('asks with the active language, so the sentence and the figures are grouped the same way', async () => {
    const { fixture, client } = await mount();
    await typeAndAsk(fixture, 'koliko sam potrošio ovog meseca');

    const call = client.query.mock.calls.find((entry) => String(entry[0]).includes('query AssistantAnswer'));
    expect(call?.[1]).toMatchObject({ question: 'koliko sam potrošio ovog meseca' });
    // `i18n.tag()` — 'en' by default here, 'sr-Latn-RS' in a Serbian session.
    expect(typeof (call?.[1] as { locale?: unknown }).locale).toBe('string');
  });

  it('renders the answer, its figures as money, and the provenance line', async () => {
    const { fixture } = await mount();
    await typeAndAsk(fixture, 'koliko sam potrošio ovog meseca');

    const text = textOf(fixture);
    expect(text).toContain('You spent 46.650,00 RSD.');
    expect(text).toContain('Hrana');
    expect(text).toContain('Spending');
    // Every figure goes through the only money renderer in the client (ADR-003): two totals/rows
    // here, and no figure is ever printed by this component itself.
    expect(fixture.nativeElement.querySelectorAll('fm-money').length).toBe(2);
    expect(text).toContain('based on 3 transactions');
    expect(text).toContain('spend.total.v1');
  });

  it('links to the filtered list with the drill-through the answer came with', async () => {
    const { fixture } = await mount();
    await typeAndAsk(fixture, 'koliko sam potrošio ovog meseca');

    const link = fixture.nativeElement.querySelector('a.card__link');
    expect(link?.getAttribute('href')).toBe(
      '/transactions?from=2026-09-01&to=2026-09-30&kind=EXPENSE',
    );
  });

  it('says how the answer was worded, inside the provenance panel and never as a badge', async () => {
    // docs/06 §8.5 asked for the fallback to stay invisible; 4.3.7b reversed that once narration became
    // routable, because the mode is the only *statement* of which path produced the words. The wording
    // is the part §8.5 was protecting: the template is described as what it is, not as a failure.
    const { fixture } = await mount();
    await typeAndAsk(fixture, 'koliko sam potrošio ovog meseca');

    const panel = fixture.nativeElement.querySelector('details.prov');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('put into words by the app itself');
    expect(panel?.textContent).toContain('No AI model is configured');

    // The machine string is diagnostic (docs/06 §8.5) and must never be rendered.
    const text = textOf(fixture);
    expect(text).not.toContain('TEMPLATE_FALLBACK');
    expect(text).not.toContain('AI_UNAVAILABLE');
    expect(text).not.toContain('UNACCOUNTED');
  });

  it('says a model narrated when one did, and claims nothing else', async () => {
    const { fixture } = await mount((query) => {
      if (query.includes('query AssistantSuggestions')) return { assistantSuggestions: [] };
      return { assistantAnswer: { ...ANSWER, narrationMode: 'LLM', reason: null } };
    });

    await typeAndAsk(fixture, 'koliko sam potrošio ovog meseca');

    const text = textOf(fixture);
    expect(text).toContain('An AI model put this answer into words');
    expect(text).not.toContain('no AI model was used');
    // A narrated answer is not a fallback, so nothing is offered for a decision that was never blocked.
    expect(fixture.nativeElement.querySelector('.card__note')).toBeNull();
  });

  it('offers the way back when consent is why the answer was a template', async () => {
    // The one visible sentence, and only for the reason the reader caused and can undo.
    const { fixture } = await mount((query) => {
      if (query.includes('query AssistantSuggestions')) return { assistantSuggestions: [] };
      return {
        assistantAnswer: {
          ...ANSWER,
          narrationMode: 'TEMPLATE_FALLBACK',
          reason: 'CONSENT_DECLINED:CONSENT_DECLINED',
        },
      };
    });

    await typeAndAsk(fixture, 'koliko sam potrošio ovog meseca');

    const note = fixture.nativeElement.querySelector('.card__note');
    expect(note?.textContent).toContain('AI processing is not allowed for this household');
    expect(note?.querySelector('a')?.getAttribute('href')).toBe('/settings');
  });

  it('keeps that note off the card for a fallback nobody can act on', async () => {
    // `ANSWER`'s reason is `AI_UNAVAILABLE:no-provider-configured`: a deployment property, not a choice.
    const { fixture } = await mount();
    await typeAndAsk(fixture, 'koliko sam potrošio ovog meseca');

    expect(fixture.nativeElement.querySelector('.card__note')).toBeNull();
  });

  it('shows a refusal with chips that ask again, which is the point of the refusal', async () => {
    const { fixture } = await mount((query) => {
      if (query.includes('query AssistantSuggestions')) {
        return { assistantSuggestions: ['Koliko sam potrošio ovog meseca?'] };
      }
      return {
        assistantAnswer: {
          ...ANSWER,
          answered: false,
          answerText: 'I cannot answer that from your ledger. Try one of the questions below.',
          facts: { template: 'NO_TEMPLATE_MATCH', rows: [], totals: [], formatted: {} },
          drillThrough: null,
          suggestions: ['Koliko sam potrošio ovog meseca?'],
        },
      };
    });

    await typeAndAsk(fixture, 'kakvo je vreme sutra');

    const text = textOf(fixture);
    expect(text).toContain('I cannot answer that from your ledger');
    // No drill-through, because there is nothing to check: the API returned none.
    expect(fixture.nativeElement.querySelector('a.card__link')).toBeNull();

    const chips = [...fixture.nativeElement.querySelectorAll('button.chip')] as HTMLButtonElement[];
    expect(chips.some((chip) => chip.textContent?.includes('Koliko sam potrošio'))).toBe(true);
  });

  it('marks a failed request as a failure, not as a refusal from the ledger', async () => {
    // The two ask different things of the user: a refusal means "ask something else" (its chips are
    // useful), a failure means "try again".
    const { fixture } = await mount((query) => {
      if (query.includes('query AssistantSuggestions')) return { assistantSuggestions: [] };
      throw new Error('Network down');
    });

    await typeAndAsk(fixture, 'koliko sam potrošio ovog meseca');

    const text = textOf(fixture);
    expect(text).toContain('could not be sent');
    expect(fixture.nativeElement.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('renders an F-30 proposal as a labelled plan that says nothing was applied', async () => {
    const { fixture } = await mount((query) => {
      if (query.includes('query AssistantSuggestions')) return { assistantSuggestions: [] };
      return {
        assistantAnswer: {
          ...ANSWER,
          intent: 'SAVINGS_PROPOSAL',
          answerText: 'You could save 5.000,00 RSD by spending less.',
          facts: {
            template: 'SAVINGS_PROPOSAL',
            rows: [{ label: 'Hrana / Supermarket', value: '349000', formatted: '3.490,00 RSD' }],
            totals: [
              { label: 'Target', money: { amountMinor: '500000', currency: 'RSD' }, formatted: '5.000,00 RSD' },
              { label: 'Proposed', money: { amountMinor: '349000', currency: 'RSD' }, formatted: '3.490,00 RSD' },
              { label: 'Shortfall', money: { amountMinor: '151000', currency: 'RSD' }, formatted: '1.510,00 RSD' },
            ],
            formatted: { headline: '3.490,00 RSD' },
          },
          drillThrough: null,
        },
      };
    });

    await typeAndAsk(fixture, 'kako da uštedim 5.000');
    const text = textOf(fixture);

    expect(text).toContain('Proposal (computed)');
    expect(text).toContain('Target');
    expect(text).toContain('Short by');
    // The point of the copy: a plan presented as a plan, with nothing applied behind the user's back.
    expect(text).toContain('no budget has been changed');
    expect(fixture.nativeElement.querySelector('.proposal')).not.toBeNull();
    // Three totals plus the one reduction line, all through the only money renderer.
    expect(fixture.nativeElement.querySelectorAll('.proposal fm-money').length).toBe(4);
  });

  it('keeps the thread, so the previous question is still readable', async () => {
    const { fixture } = await mount();

    await typeAndAsk(fixture, 'koliko sam potrošio ovog meseca');
    await typeAndAsk(fixture, 'koliko je stanje na računu');

    const questions = [...fixture.nativeElement.querySelectorAll('.turn__question')].map(
      (node: Element) => node.textContent?.trim(),
    );
    expect(questions).toEqual(['koliko sam potrošio ovog meseca', 'koliko je stanje na računu']);
  });

  it('takes focus on entry, because it is a composer and not a form to be discovered', async () => {
    // docs/02 §9, FL-09. `afterNextRender` runs after the first render, so the assertion has to as
    // well — `whenStable` in `mount` is what gives it the chance.
    const { fixture } = await mount();

    const input = fixture.nativeElement.querySelector('#assistant-question');
    expect(document.activeElement).toBe(input);
  });

  it('cancels the form submit, so asking a question does not reload the page', async () => {
    // The regression this exists for: with `(ngSubmit)` and no forms module imported, the binding was
    // registered as a DOM event named "ngSubmit" that never fires, the browser did its native GET
    // submit, and a real browser reloaded /assistant with no answer (measured; docs/15).
    const { fixture, client } = await mount();
    const component = fixture.componentInstance;
    component.question.set('koliko sam potrošio u lidlu');
    const form = (fixture.nativeElement as HTMLElement).querySelector('form.ask');

    expect(form).not.toBeNull();
    const event = new Event('submit', { cancelable: true, bubbles: true });
    form?.dispatchEvent(event);
    await fixture.whenStable();

    expect(event.defaultPrevented).toBe(true);
    // And the question really went out, which is what the reload used to prevent.
    expect(
      client.query.mock.calls.some((call) => String(call[0]).includes('query AssistantAnswer')),
    ).toBe(true);
  });

  it('asks nothing for an empty or whitespace-only question', async () => {
    const { fixture, client } = await mount();
    const component = fixture.componentInstance;

    component.question.set('   ');
    await component.ask();

    expect(component.thread()).toEqual([]);
    expect(client.query.mock.calls.some((call) => String(call[0]).includes('query AssistantAnswer'))).toBe(false);
  });
});

/**
 * The write path, mounted — B-2b.
 *
 * What a rendered component proves beyond `assistant.view.spec.ts` is the part that only exists at the
 * seam: that a question is **not** offered as a write when the ledger answered it, that Confirm sends the
 * proposal id and one idempotency key and nothing else, that the id and key are replaced when the kind
 * changes, and that a failed write is reported as a write failure rather than swallowed or mistaken for
 * the refusal above it. Each of those is a way to write the wrong thing (R-29), which is why none of
 * them is left to the pure helpers.
 */
const REFUSAL = {
  ...ANSWER,
  answered: false,
  answerText: 'I cannot answer that from your ledger.',
  facts: { template: 'NO_TEMPLATE_MATCH', rows: [], totals: [], formatted: {} },
  drillThrough: null,
  suggestions: [] as string[],
};

const PROPOSAL = {
  proposed: true,
  reason: null,
  proposalId: 'proposal-1',
  action: 'ADD_CATEGORY',
  preview: {
    sentence: 'New category “Putovanja” (expense, top level)',
    diff: [
      { slot: 'name', field: 'name', before: null, after: 'Putovanja', afterValue: null, defaulted: false },
      { slot: 'kind', field: 'kind', before: null, after: 'expense', afterValue: 'EXPENSE', defaulted: true },
      { slot: 'parentId', field: 'parent', before: null, after: 'top level', afterValue: null, defaulted: false },
    ],
  },
  expiresAt: '2026-09-20T10:10:00.000Z',
};

const RESULT = {
  action: 'ADD_CATEGORY',
  createdId: 'category-1',
  createdLabel: 'Putovanja',
  undo: 'SOFT_DELETE',
  sentence: 'New category “Putovanja” (expense, top level)',
  replayed: false,
};

/**
 * A transaction proposal, as `assistantProposeAction` returns one (docs/06 §8.16).
 *
 * `lines[].amount` is the API's `Money` scalar — minor units plus currency, which is what `fm-money`
 * takes. The card must never format a figure itself (ADR-003).
 */
const TRANSACTION_PROPOSAL = {
  proposed: true,
  reason: null,
  proposalId: 'proposal-tx',
  action: 'ADD_TRANSACTION',
  preview: {
    sentence: 'Nova transakcija „kafa” — 180,00 RSD, Kafa i kolači',
    diff: [
      { slot: 'kind', field: 'vrsta', before: null, after: 'rashod', afterValue: 'EXPENSE', defaulted: false },
      { slot: 'accountId', field: 'račun', before: null, after: 'Keš', afterValue: 'acct-1', defaulted: true },
    ],
    lines: [
      {
        label: 'kafa',
        amount: { amountMinor: '18000', currency: 'RSD' },
        category: 'Kafa i kolači',
        occurredOn: '2026-09-18',
        needsReview: false,
      },
    ],
  },
  expiresAt: '2026-09-20T10:10:00.000Z',
};

const TRANSACTION_RESULT = {
  action: 'ADD_TRANSACTION',
  createdId: 'tx-1',
  createdLabel: 'kafa',
  undo: 'UNDO_CAPTURE',
  sentence: 'Dodato „kafa” — 180,00 RSD.',
  replayed: false,
};

/** The picker's options — including an archived Account, which must not be offered. */
const ACCOUNTS = {
  accounts: {
    edges: [
      { node: { id: 'acct-1', name: 'Keš', isArchived: false } },
      { node: { id: 'acct-2', name: 'Tekući', isArchived: false } },
      { node: { id: 'acct-3', name: 'Stari', isArchived: true } },
    ],
  },
};

/** A responder that refuses the question and answers the write path from `over`. */
function writeResponder(over: Partial<Record<'answer' | 'propose' | 'execute' | 'undo', unknown>> = {}) {
  return (query: string, _variables?: Record<string, unknown>): unknown => {
    if (query.includes('query AssistantSuggestions')) return { assistantSuggestions: [] };
    if (query.includes('query AssistantAccounts')) return ACCOUNTS;
    if (query.includes('mutation AssistantProposeAction')) return { assistantProposeAction: over.propose ?? PROPOSAL };
    if (query.includes('mutation AssistantExecuteAction')) return { assistantExecuteAction: over.execute ?? RESULT };
    if (query.includes('mutation AssistantUndoAddCategory')) return { deleteCategory: true };
    if (query.includes('mutation AssistantUndoCapture')) return { undoCapture: 1 };
    return { assistantAnswer: over.answer ?? REFUSAL };
  };
}

async function askAndSettle(
  fixture: ReturnType<typeof TestBed.createComponent<AssistantComponent>>,
  question = 'dodaj kategoriju Putovanja',
): Promise<void> {
  fixture.componentInstance.question.set(question);
  await fixture.componentInstance.ask();
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('the assistant write path (B-2b)', () => {
  it('offers no write when the ledger answered the question', async () => {
    // The ordering, and the reason it is not merely a preference: a question the ledger can answer must
    // never be turned into an offer to change something (docs/06 §8.16).
    const { fixture, client } = await mount();
    await askAndSettle(fixture, 'koliko sam potrošio ovog meseca');

    expect(
      client.query.mock.calls.some((call) => String(call[0]).includes('mutation AssistantProposeAction')),
    ).toBe(false);
    expect(fixture.nativeElement.querySelector('.act')).toBeNull();
  });

  it('renders the proposal the server built, and says nothing has happened yet', async () => {
    const { fixture } = await mount(writeResponder());
    await askAndSettle(fixture);

    const text = textOf(fixture);
    expect(fixture.nativeElement.querySelector('.act')).not.toBeNull();
    // The sentence is the backend's; the diff is the backend's; the client decides only the chrome.
    expect(text).toContain('New category “Putovanja” (expense, top level)');
    expect(text).toContain('top level');
    expect(text).toContain('chosen for you');
    expect(text).toContain('Nothing has been changed yet');
    expect(fixture.nativeElement.querySelector('.act__confirm')).not.toBeNull();
    // …and the refusal above it is intact: the ledger's answer was "I cannot answer that", which is what
    // made the offer possible.
    expect(text).toContain('I cannot answer that from your ledger');
    expect(fixture.nativeElement.querySelector('.act--done')).toBeNull();
  });

  it('confirms with the proposal id and one idempotency key, and nothing else', async () => {
    const { fixture, client } = await mount(writeResponder());
    await askAndSettle(fixture);

    const confirm = fixture.nativeElement.querySelector('.act__confirm') as HTMLButtonElement;
    confirm.click();
    await fixture.whenStable();
    fixture.detectChanges();

    const call = client.query.mock.calls.find((entry) =>
      String(entry[0]).includes('mutation AssistantExecuteAction'),
    );
    const variables = call?.[1] as Record<string, unknown>;
    // The load-bearing assertion of ADR-035 decision 2: no name, no kind, no parent — the server
    // re-reads the proposal it stored, so this call cannot describe a different write.
    expect(Object.keys(variables).sort()).toEqual(['idempotencyKey', 'proposalId']);
    expect(variables['proposalId']).toBe('proposal-1');
    expect(typeof variables['idempotencyKey']).toBe('string');
    expect((variables['idempotencyKey'] as string).length).toBeGreaterThan(0);

    // The result card replaces the proposal, and it quotes the row that was written.
    const text = textOf(fixture);
    expect(fixture.nativeElement.querySelector('.act--done')).not.toBeNull();
    expect(text).toContain('New category “Putovanja” (expense, top level)');
    expect(fixture.nativeElement.querySelector('.act__confirm')).toBeNull();
  });

  it('reuses the same idempotency key for a repeated confirm', async () => {
    // A double-click, or a retry after a timeout, must describe **one** intended write. The key is
    // minted with the proposal and never regenerated — the same rule the capture path follows.
    const { fixture, client } = await mount(
      writeResponder({ execute: { ...RESULT, replayed: true } }),
    );
    await askAndSettle(fixture);

    const key = fixture.componentInstance.thread()[0]?.action?.idempotencyKey;
    (fixture.nativeElement.querySelector('.act__confirm') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();

    const call = client.query.mock.calls.find((entry) =>
      String(entry[0]).includes('mutation AssistantExecuteAction'),
    );
    expect((call?.[1] as Record<string, unknown>)['idempotencyKey']).toBe(key);
    // And a replay says so, because "it worked" and "it worked, and only once" are different claims.
    expect(textOf(fixture)).toContain('nothing was created twice');
  });

  it('replaces the proposal and its key when the kind changes', async () => {
    const { fixture, client } = await mount((query, variables) => {
      if (query.includes('query AssistantSuggestions')) return { assistantSuggestions: [] };
      if (query.includes('mutation AssistantProposeAction')) {
        // The server re-proposes: a new id, and the diff now says INCOME.
        return variables?.['kind'] === 'INCOME'
          ? {
              assistantProposeAction: {
                ...PROPOSAL,
                proposalId: 'proposal-2',
                preview: {
                  sentence: 'New category “Putovanja” (income, top level)',
                  diff: PROPOSAL.preview.diff.map((row) =>
                    row.slot === 'kind' ? { ...row, after: 'income', afterValue: 'INCOME' } : row,
                  ),
                },
              },
            }
          : { assistantProposeAction: PROPOSAL };
      }
      return { assistantAnswer: REFUSAL };
    });
    await askAndSettle(fixture);

    const before = fixture.componentInstance.thread()[0]?.action?.idempotencyKey;
    const toggles = [
      ...fixture.nativeElement.querySelectorAll('.act__toggle'),
    ] as HTMLButtonElement[];
    expect(toggles).toHaveLength(2);
    expect(toggles[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(toggles[1]?.getAttribute('aria-pressed')).toBe('false');

    toggles[1]?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    const proposeCalls = client.query.mock.calls.filter((entry) =>
      String(entry[0]).includes('mutation AssistantProposeAction'),
    );
    const variables = proposeCalls.at(-1)?.[1] as Record<string, unknown>;
    expect(variables['kind']).toBe('INCOME');
    expect(variables['question']).toBe('dodaj kategoriju Putovanja');

    // The confirmation must name the action the person was *shown*, so the id changes…
    expect(fixture.componentInstance.thread()[0]?.action?.proposal?.proposalId).toBe('proposal-2');
    // …and so does the key, or the server would replay the previous kind's outcome.
    expect(fixture.componentInstance.thread()[0]?.action?.idempotencyKey).not.toBe(before);
    expect(textOf(fixture)).toContain('New category “Putovanja” (income, top level)');

    const togglesAfter = [
      ...fixture.nativeElement.querySelectorAll('.act__toggle'),
    ] as HTMLButtonElement[];
    expect(togglesAfter[1]?.getAttribute('aria-pressed')).toBe('true');
  });

  it('renders the rows a transaction will write, with the amount through fm-money', async () => {
    const { fixture, client } = await mount(writeResponder({ propose: TRANSACTION_PROPOSAL }));
    await askAndSettle(fixture, 'dodaj trošak kafa 180');

    const text = textOf(fixture);
    // The row: its text, its Category and its day.
    expect(text).toContain('kafa');
    expect(text).toContain('Kafa i kolači');
    expect(text).toContain('2026');
    const line = fixture.nativeElement.querySelector('.act__line');
    expect(line).not.toBeNull();
    // Every figure goes through the only money renderer in the client (ADR-003), and the amount arrives
    // as minor units — never as a string this component formatted itself.
    expect(line.querySelector('fm-money')).not.toBeNull();
    // The picker's list was asked for, once.
    expect(
      client.query.mock.calls.filter((call) => String(call[0]).includes('query AssistantAccounts')),
    ).toHaveLength(1);
  });

  it('says a row will go to the review queue rather than implying it is settled', async () => {
    const { fixture } = await mount(
      writeResponder({
        propose: {
          ...TRANSACTION_PROPOSAL,
          preview: {
            ...TRANSACTION_PROPOSAL.preview,
            lines: [
              { ...TRANSACTION_PROPOSAL.preview.lines[0], category: null, needsReview: true },
            ],
          },
        },
      }),
    );
    await askAndSettle(fixture, 'dodaj trošak kafa 180');

    const text = textOf(fixture);
    expect(text).toContain('no category yet');
    expect(text).toContain('goes to the review queue');
  });

  it('offers the account the proposal filled as a control, and re-proposes with the chosen one', async () => {
    const { fixture, client } = await mount(writeResponder({ propose: TRANSACTION_PROPOSAL }));
    await askAndSettle(fixture, 'dodaj trošak kafa 180');

    const select = fixture.nativeElement.querySelector('.act__select') as HTMLSelectElement;
    expect(select).not.toBeNull();
    // The live Accounts only: an archived one is not somewhere a new row may be written.
    expect([...select.options].map((option) => option.textContent)).toEqual(['Keš', 'Tekući']);
    expect(select.value).toBe('acct-1');

    select.value = 'acct-2';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();

    const calls = client.query.mock.calls.filter((call) =>
      String(call[0]).includes('mutation AssistantProposeAction'),
    );
    // The same mechanism as the kind toggle, and the same reason: the API answers a changed default
    // with a **new** proposal, never with a changed one (ADR-035 decision 2).
    expect((calls.at(-1)?.[1] as Record<string, unknown>)['accountId']).toBe('acct-2');
  });

  it('undoes a confirmed transaction through undoCapture, and links to the row', async () => {
    // The card's result half is per-action: a Transaction is undone by a different mutation than a
    // Category, and its link goes to the row rather than to a list (found by the browser pass — the
    // confirmed entry had no Undo at all while `undoPlan` knew only `SOFT_DELETE`).
    const { fixture, client } = await mount(
      writeResponder({ propose: TRANSACTION_PROPOSAL, execute: TRANSACTION_RESULT }),
    );
    await askAndSettle(fixture, 'dodaj trošak kafa 180');
    (fixture.nativeElement.querySelector('.act__confirm') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();

    const link = fixture.nativeElement.querySelector('.act--done a') as HTMLAnchorElement;
    expect(link?.getAttribute('href')).toBe('/transactions/tx-1');

    (fixture.nativeElement.querySelector('.act__undo') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();

    const call = client.query.mock.calls.find((entry) =>
      String(entry[0]).includes('mutation AssistantUndoCapture'),
    );
    // A **list**, because that is what `undoCapture` takes — docs/02 §3's toast is all-or-nothing per
    // call, and this action writes one row.
    expect((call?.[1] as Record<string, unknown>)['transactionIds']).toEqual(['tx-1']);
    // …and the sentence names what was removed from where.
    expect(textOf(fixture)).toContain('removed from your transactions');
  });

  it('offers no account control, and asks for no accounts, when the question named the account', async () => {
    const { fixture, client } = await mount(
      writeResponder({
        propose: {
          ...TRANSACTION_PROPOSAL,
          preview: {
            ...TRANSACTION_PROPOSAL.preview,
            diff: TRANSACTION_PROPOSAL.preview.diff.map((row) =>
              row.slot === 'accountId' ? { ...row, defaulted: false } : row,
            ),
          },
        },
      }),
    );
    await askAndSettle(fixture, 'dodaj trošak kafa 180');

    expect(fixture.nativeElement.querySelector('.act__select')).toBeNull();
    expect(
      client.query.mock.calls.some((call) => String(call[0]).includes('query AssistantAccounts')),
    ).toBe(false);
    expect(textOf(fixture)).toContain('kafa');
  });

  it('offers no kind toggle when the question stated the kind', async () => {
    // The server's `defaulted` flag is what decides: a value the user asked for is not a suggestion.
    const { fixture } = await mount(
      writeResponder({
        propose: {
          ...PROPOSAL,
          preview: {
            ...PROPOSAL.preview,
            diff: PROPOSAL.preview.diff.map((row) =>
              row.slot === 'kind' ? { ...row, defaulted: false } : row,
            ),
          },
        },
      }),
    );
    await askAndSettle(fixture);

    expect(fixture.nativeElement.querySelector('.act')).not.toBeNull();
    expect(fixture.nativeElement.querySelectorAll('.act__toggle')).toHaveLength(0);
  });

  it('undoes a confirmed write through the same mutation the categories screen uses', async () => {
    const { fixture, client } = await mount(writeResponder());
    await askAndSettle(fixture);

    (fixture.nativeElement.querySelector('.act__confirm') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();

    const undo = fixture.nativeElement.querySelector('.act__undo') as HTMLButtonElement;
    expect(undo.textContent).toContain('Undo');
    undo.click();
    await fixture.whenStable();
    fixture.detectChanges();

    const call = client.query.mock.calls.find((entry) =>
      String(entry[0]).includes('deleteCategory'),
    );
    // The row the server said it created — not the label, not the name the user typed.
    expect((call?.[1] as Record<string, unknown>)['id']).toBe('category-1');
    expect(textOf(fixture)).toContain('no longer among your categories');
    expect(fixture.nativeElement.querySelector('.act__undo')).toBeNull();
  });

  it('offers no undo for an action the server did not declare undoable', async () => {
    const { fixture } = await mount(writeResponder({ execute: { ...RESULT, undo: 'NONE' } }));
    await askAndSettle(fixture);
    (fixture.nativeElement.querySelector('.act__confirm') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.act--done')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.act__undo')).toBeNull();
  });

  it('asks for the missing name instead of leaving a bare refusal', async () => {
    const { fixture } = await mount(
      writeResponder({
        propose: { proposed: false, reason: 'UNRUNNABLE:name', proposalId: null, action: 'ADD_CATEGORY', preview: null, expiresAt: null },
      }),
    );
    await askAndSettle(fixture, 'dodaj kategoriju');

    expect(textOf(fixture)).toContain('Tell me what to call it');
    expect(fixture.nativeElement.querySelector('.act')).toBeNull();
  });

  it('says nothing extra for a question that is simply not an action', async () => {
    // `NOT_AN_ACTION` is the ordinary reply to an unanswerable question, and the refusal already said it.
    const { fixture } = await mount(
      writeResponder({
        propose: { proposed: false, reason: 'NOT_AN_ACTION', proposalId: null, action: null, preview: null, expiresAt: null },
      }),
    );
    await askAndSettle(fixture, 'kakvo je vreme sutra');

    const text = textOf(fixture);
    expect(text).toContain('I cannot answer that from your ledger');
    expect(text).not.toContain('Tell me what to call it');
    expect(fixture.nativeElement.querySelector('.card__note')).toBeNull();
  });

  it('names the collision when the name is already taken, in the reader’s language', async () => {
    // `CONFLICT` is the one error whose specific cause the reader can fix. The shared mapper would say
    // "something with those details already exists", which hides the only actionable word: the name.
    const { fixture } = await mount((query) => {
      if (query.includes('query AssistantSuggestions')) return { assistantSuggestions: [] };
      if (query.includes('mutation AssistantProposeAction')) {
        throw new GraphQLRequestError(
          [{ message: 'A category named "Hrana" already exists here.', code: 'CONFLICT', retryable: false }],
          200,
        );
      }
      return { assistantAnswer: REFUSAL };
    });
    await askAndSettle(fixture, 'dodaj kategoriju Hrana');

    expect(textOf(fixture)).toContain('A category with that name already exists');
    expect(fixture.nativeElement.querySelector('.act')).toBeNull();
  });

  it('reports a failed write as a write failure, not as the answer', async () => {
    const { fixture } = await mount((query) => {
      if (query.includes('query AssistantSuggestions')) return { assistantSuggestions: [] };
      if (query.includes('mutation AssistantProposeAction')) return { assistantProposeAction: PROPOSAL };
      if (query.includes('mutation AssistantExecuteAction')) {
        throw new GraphQLRequestError(
          [{ message: 'That action is no longer available.', code: 'NOT_FOUND', retryable: false }],
          200,
        );
      }
      return { assistantAnswer: REFUSAL };
    });
    await askAndSettle(fixture);

    (fixture.nativeElement.querySelector('.act__confirm') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();

    // `NOT_FOUND` is the one failure a retry cannot fix: the server consumed the proposal before it
    // attempted the write, so the card stops offering a button that could only fail again.
    expect(textOf(fixture)).toContain('This offer is no longer valid');
    expect(fixture.nativeElement.querySelector('.act--done')).toBeNull();
    expect(fixture.nativeElement.querySelector('.act__confirm')).toBeNull();
    // The refusal above is untouched, and nothing claims to have happened.
    expect(textOf(fixture)).toContain('I cannot answer that from your ledger');
  });

  it('keeps the offer for a failure a retry could fix', async () => {
    // An unreachable server is not a consumed proposal: the request never arrived, so the same
    // idempotency key is exactly the right thing to send again.
    const { fixture } = await mount((query) => {
      if (query.includes('query AssistantSuggestions')) return { assistantSuggestions: [] };
      if (query.includes('mutation AssistantProposeAction')) return { assistantProposeAction: PROPOSAL };
      if (query.includes('mutation AssistantExecuteAction')) {
        throw new GraphQLRequestError(
          [{ message: 'fetch failed', code: 'UNREACHABLE', retryable: true }],
          0,
        );
      }
      return { assistantAnswer: REFUSAL };
    });
    await askAndSettle(fixture);

    (fixture.nativeElement.querySelector('.act__confirm') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.act__confirm')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.act--done')).toBeNull();
  });
});
