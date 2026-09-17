// @vitest-environment jsdom
// FIRST import, deliberately: it loads `@angular/compiler`, and `@angular/router` is a partially
// compiled package whose module body needs the JIT compiler to already be present (see
// `capture.component.spec.ts` for the full reasoning).
import { initAngularTesting } from '@web-test/angular-testing';

import { CUSTOM_ELEMENTS_SCHEMA, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GraphqlClient } from '../../core/graphql/graphql.client';
import { MoneyComponent } from '../../shared/ui/money/money.component';
import { RecurringComponent } from './recurring.component';
import type { RecurringRule } from './recurring.view';

initAngularTesting();

/**
 * The recurring screen, mounted.
 *
 * The decisions live in `recurring.view.spec.ts`; what a *rendered* component proves beyond them is
 * that the schedule is **said in words** while the raw RFC 5545 text stays behind the disclosure
 * (docs/02 §4.14), that creating a rule sends the string the picker built, and that the list never
 * shows a date the API did not expand.
 */
const RULE: RecurringRule = {
  id: 'r1',
  accountId: 'a1',
  accountName: 'Tekući',
  kind: 'EXPENSE',
  amount: { amountMinor: '129900', currency: 'RSD' },
  categoryId: null,
  description: 'Netflix',
  rrule: 'RRULE:FREQ=MONTHLY;BYMONTHDAY=15',
  nextOccurrenceOn: '2099-01-15',
  endsOn: null,
  autoConfirm: true,
  isDetected: false,
  isActive: true,
  generatedCount: 4,
  upcomingOccurrences: ['2099-01-15', '2099-02-15'],
};

async function mount(
  respond?: (query: string) => unknown,
): Promise<{
  fixture: ReturnType<typeof TestBed.createComponent<RecurringComponent>>;
  client: { query: ReturnType<typeof vi.fn> };
}> {
  const client = {
    query: vi.fn((query: string, _variables?: Record<string, unknown>) => {
      if (respond) return Promise.resolve(respond(query));
      if (query.includes('query Recurring')) {
        return Promise.resolve({
          recurringRules: [RULE],
          accounts: { edges: [{ node: { id: 'a1', name: 'Tekući' } }] },
        });
      }
      return Promise.resolve({});
    }),
  };

  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: GraphqlClient, useValue: client }],
  });

  // `fm-money` is a custom element here: its `amount` input is `input.required`, and a JIT-rendered
  // child throws NG0950 when the harness evaluates it before the binding lands.
  TestBed.overrideComponent(RecurringComponent, {
    remove: { imports: [MoneyComponent] },
    add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
  });

  const fixture = TestBed.createComponent(RecurringComponent);
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, client };
}

type Fixture = ReturnType<typeof TestBed.createComponent<RecurringComponent>>;

function textOf(fixture: Fixture): string {
  return fixture.nativeElement.textContent ?? '';
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('the recurring screen', () => {
  it('says the schedule in words and keeps the RFC 5545 text behind a disclosure', async () => {
    const { fixture } = await mount();
    const text = textOf(fixture);

    expect(text).toContain('Netflix');
    // The sentence, not the string (docs/02 §4.14). English catalogue in the harness.
    expect(text).toContain('every month on the 15th');
    expect(text).toContain('4 posted');

    const details = fixture.nativeElement.querySelector('details.raw');
    expect(details?.querySelector('code')?.textContent).toContain('RRULE:FREQ=MONTHLY;BYMONTHDAY=15');
  });

  it('renders only the dates the API expanded', async () => {
    const { fixture } = await mount();
    const text = textOf(fixture);

    // The fixture's dates are in 2099, so the 30-day summary is empty — and says so rather than
    // inventing a date the server never produced.
    expect(text).toContain('Nothing is due in the next 30 days');
  });

  it('creates a rule with the schedule the picker built', async () => {
    const { fixture, client } = await mount();
    const component = fixture.componentInstance;

    component.toggleForm();
    fixture.detectChanges();
    component.draft.set({
      ...component.draft(),
      description: 'EPS',
      amount: '4200',
      accountId: 'a1',
      frequency: 'MONTHLY',
      interval: '1',
      startsOn: '2026-11-01',
      endsOn: '2027-06-01',
      autoConfirm: false,
    });
    await component.save();
    await fixture.whenStable();

    const call = client.query.mock.calls.find((entry) => String(entry[0]).includes('CreateRecurringRule'));
    const variables = call?.[1] as {
      input: { rrule: string; amount: { amountMinor: string }; endsOn: string; startsOn: string };
    };
    expect(variables.input.rrule).toBe('RRULE:FREQ=MONTHLY;BYMONTHDAY=1;UNTIL=20270601');
    expect(variables.input.amount.amountMinor).toBe('420000');
    expect(variables.input.startsOn).toBe('2026-11-01');
    expect(variables.input.endsOn).toBe('2027-06-01');
  });

  it('refuses an invalid draft before it queries anything', async () => {
    const { fixture, client } = await mount();
    const component = fixture.componentInstance;

    component.toggleForm();
    fixture.detectChanges();
    component.draft.set({ ...component.draft(), description: '', amount: '0', accountId: '' });
    await component.save();
    fixture.detectChanges();

    expect(textOf(fixture)).toContain('Give the rule a description.');
    const queries = client.query.mock.calls.map((entry) => String(entry[0]));
    expect(queries.some((query) => query.includes('CreateRecurringRule'))).toBe(false);
  });

  it('deactivates through `updateRecurringRule` rather than deleting the rule', async () => {
    const { fixture, client } = await mount();
    await fixture.componentInstance.setActive(RULE, false);
    await fixture.whenStable();

    const call = client.query.mock.calls.find((entry) => String(entry[0]).includes('UpdateRecurringRule'));
    expect(call?.[1]).toMatchObject({ input: { ruleId: 'r1', isActive: false } });
    const queries = client.query.mock.calls.map((entry) => String(entry[0]));
    expect(queries.some((query) => query.includes('deleteRecurringRule'))).toBe(false);
  });

  it('accepts and dismisses a proposal through the two detection mutations', async () => {
    const proposal: RecurringRule = { ...RULE, id: 'p1', description: 'Spotify', isDetected: true, isActive: false };
    const { fixture, client } = await mount((query) =>
      query.includes('query Recurring')
        ? { recurringRules: [proposal], accounts: { edges: [] } }
        : {},
    );
    fixture.detectChanges();

    // The proposal is drawn with its evidence and two answers, and it is not in the rules list.
    expect(textOf(fixture)).toContain('Spotify');
    expect(textOf(fixture)).toContain('Suggestions');

    await fixture.componentInstance.acceptProposal(proposal);
    await fixture.componentInstance.dismissProposal(proposal);
    await fixture.whenStable();

    const queries = client.query.mock.calls.map((entry) => String(entry[0]));
    expect(queries.some((query) => query.includes('confirmDetectedSubscription'))).toBe(true);
    expect(queries.some((query) => query.includes('dismissDetectedSubscription'))).toBe(true);
  });

  it('runs the detector on request, since there is no scheduled job', async () => {
    const { fixture, client } = await mount();
    await fixture.componentInstance.checkSubscriptions();
    await fixture.whenStable();

    const call = client.query.mock.calls.find((entry) => String(entry[0]).includes('detectSubscriptions'));
    expect(call).toBeDefined();
  });

  it('shows an error instead of an empty list when the query fails', async () => {
    const client = { query: vi.fn(() => Promise.reject(new Error('boom'))) };
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), { provide: GraphqlClient, useValue: client }],
    });
    TestBed.overrideComponent(RecurringComponent, {
      remove: { imports: [MoneyComponent] },
      add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
    });
    const fixture: Fixture = TestBed.createComponent(RecurringComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent ?? '').not.toBe('');
  });
  it('cancels the form submit, so saving a rule does not reload the page', async () => {
    // The third screen with the same defect (docs/15): `(ngSubmit)` with no forms module imported
    // compiles, never fires, and lets the browser navigate instead.
    const { fixture } = await mount();
    // The composer is behind its own toggle, so the form only exists once it is open.
    fixture.componentInstance.toggleForm();
    fixture.detectChanges();
    const form = (fixture.nativeElement as HTMLElement).querySelector('form');

    expect(form).not.toBeNull();
    const event = new Event('submit', { cancelable: true, bubbles: true });
    form?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });
});
