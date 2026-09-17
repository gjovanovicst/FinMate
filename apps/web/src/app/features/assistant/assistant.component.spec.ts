// @vitest-environment jsdom
// FIRST import, deliberately: it loads `@angular/compiler`, and `@angular/router` is a partially
// compiled package whose module body needs the JIT compiler to already be present (see
// `capture.component.spec.ts` for the full reasoning).
import { initAngularTesting } from '@web-test/angular-testing';

import { ApplicationRef, CUSTOM_ELEMENTS_SCHEMA, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GraphqlClient } from '../../core/graphql/graphql.client';
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

async function mount(respond?: (query: string) => unknown): Promise<{
  fixture: ReturnType<typeof TestBed.createComponent<AssistantComponent>>;
  client: { query: ReturnType<typeof vi.fn> };
}> {
  const client = {
    query: vi.fn((query: string, _variables?: Record<string, unknown>) => {
      if (respond) return Promise.resolve(respond(query));
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

  it('asks nothing for an empty or whitespace-only question', async () => {
    const { fixture, client } = await mount();
    const component = fixture.componentInstance;

    component.question.set('   ');
    await component.ask();

    expect(component.thread()).toEqual([]);
    expect(client.query.mock.calls.some((call) => String(call[0]).includes('query AssistantAnswer'))).toBe(false);
  });
});
