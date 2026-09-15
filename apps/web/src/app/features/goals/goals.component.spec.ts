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
import { GoalsComponent } from './goals.component';
import type { Goal } from './goals.view';

initAngularTesting();

/**
 * The goals screen, mounted.
 *
 * The decisions live in `goals.view.spec.ts`; what a *rendered* component proves beyond them is that
 * the figures go through `fm-money`, that the required monthly amount is **rendered, never an input**,
 * that a contribution is submitted with **one idempotency key minted at submit** (not per keystroke),
 * and that an invalid target is refused before anything is sent.
 */
const GOAL: Goal = {
  id: 'g1',
  name: 'Letovanje',
  target: { amountMinor: '12000000', currency: 'RSD' },
  targetDate: '2027-06-01',
  accountId: null,
  account: null,
  status: 'ACTIVE',
  contributed: { amountMinor: '2100000', currency: 'RSD' },
  remaining: { amountMinor: '9900000', currency: 'RSD' },
  progress: 0.175,
  requiredPerMonth: { amountMinor: '1100000', currency: 'RSD' },
  monthsRemaining: 9,
  contributions: [
    {
      id: 'c1',
      goalId: 'g1',
      amount: { amountMinor: '2100000', currency: 'RSD' },
      contributedOn: '2026-09-10',
      note: 'Kartica',
    },
  ],
};

async function mount(
  respond?: (query: string) => unknown,
): Promise<{
  fixture: ReturnType<typeof TestBed.createComponent<GoalsComponent>>;
  client: { query: ReturnType<typeof vi.fn> };
}> {
  const client = {
    query: vi.fn((query: string, _variables?: Record<string, unknown>) => {
      if (respond) return Promise.resolve(respond(query));
      if (query.includes('query Goals')) {
        return Promise.resolve({
          savingGoals: [GOAL],
          accounts: { edges: [{ node: { id: 'a1', name: 'Kartica' } }] },
        });
      }
      return Promise.resolve({});
    }),
  };

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: GraphqlClient, useValue: client },
    ],
  });

  // `fm-money` is a custom element here: its `amount` input is `input.required`, and a JIT-rendered
  // child throws NG0950 when the harness evaluates it before the binding lands. What this file proves
  // is that the figures are *handed* to it.
  TestBed.overrideComponent(GoalsComponent, {
    remove: { imports: [MoneyComponent] },
    add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
  });

  const fixture = TestBed.createComponent(GoalsComponent);
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, client };
}

type Fixture = ReturnType<typeof TestBed.createComponent<GoalsComponent>>;

function textOf(fixture: Fixture): string {
  return fixture.nativeElement.textContent ?? '';
}

function input(fixture: Fixture, selector: string, value: string): void {
  const element = fixture.nativeElement.querySelector(selector) as HTMLInputElement | null;
  if (!element) throw new Error(`no element for ${selector}`);
  element.value = value;
  element.dispatchEvent(new Event('input'));
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('the goals screen', () => {
  it('renders a card with the progress, the deadline and the backend’s monthly amount', async () => {
    const { fixture } = await mount();
    const text = textOf(fixture);

    expect(text).toContain('Letovanje');
    expect(text).toContain('18 %');
    expect(text).toContain('By');
    expect(text).toContain('needed per month');
    // The contribution's note, because a contribution has no Account of its own.
    expect(text).toContain('Kartica');

    const bar = fixture.nativeElement.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('18');
  });

  it('never offers the required monthly amount as an input', async () => {
    const { fixture } = await mount();

    const inputs = [...fixture.nativeElement.querySelectorAll('input, select, textarea')].map(
      (element) => (element as HTMLInputElement).name || (element as HTMLInputElement).id || '',
    );
    // The amount the backend derives is rendered, never editable (docs/02 §4.13).
    expect(inputs.some((name) => name.includes('required'))).toBe(false);
  });

  it('refuses an unreadable target before it queries anything', async () => {
    const { fixture, client } = await mount();
    fixture.componentInstance.toggleCreate();
    fixture.detectChanges();

    input(fixture, '#goal-name', 'Auto');
    input(fixture, 'input[inputmode="decimal"]', 'nema');
    fixture.componentInstance.create();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(textOf(fixture)).toContain('The target must be a number greater than zero.');
    const queries = client.query.mock.calls.map((call) => String(call[0]));
    expect(queries.some((query) => query.includes('CreateGoal'))).toBe(false);
  });

  it('creates a goal with the target as a Money object, never a number', async () => {
    const { fixture, client } = await mount();
    fixture.componentInstance.toggleCreate();
    fixture.detectChanges();

    input(fixture, '#goal-name', 'Auto');
    input(fixture, 'input[inputmode="decimal"]', '400.000');
    await fixture.componentInstance.create();
    await fixture.whenStable();

    const call = client.query.mock.calls.find((entry) => String(entry[0]).includes('CreateGoal'));
    const variables = call?.[1] as { input: { name: string; target: { amountMinor: string } } };
    expect(variables.input.name).toBe('Auto');
    expect(variables.input.target.amountMinor).toBe('40000000');
  });

  it('submits a contribution with one idempotency key, minted at submit (I-10)', async () => {
    const { fixture, client } = await mount();
    const component = fixture.componentInstance;

    component.openPayment(GOAL);
    fixture.detectChanges();
    component.paymentAmount.set('50.000');
    await component.contribute(GOAL);
    await fixture.whenStable();

    const call = client.query.mock.calls.find((entry) => String(entry[0]).includes('Contribute'));
    const variables = call?.[1] as {
      input: { goalId: string; amount: { amountMinor: string }; idempotencyKey: string };
    };
    expect(variables.input.goalId).toBe('g1');
    expect(variables.input.amount.amountMinor).toBe('5000000');
    expect(variables.input.idempotencyKey).toMatch(/[0-9a-f-]{20,}/);

    // A second submission mints a *new* key — the API decides whether it is a replay, the client
    // never reuses a key across two different intents.
    await component.contribute(GOAL);
    const second = client.query.mock.calls.filter((entry) => String(entry[0]).includes('Contribute'));
    expect(second).toHaveLength(2);
    const keys = second.map(
      (entry) => (entry[1] as { input: { idempotencyKey: string } }).input.idempotencyKey,
    );
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('archives through `updateSavingGoal` rather than deleting the goal', async () => {
    const { fixture, client } = await mount();
    await fixture.componentInstance.setStatus(GOAL, 'ARCHIVED');
    await fixture.whenStable();

    const call = client.query.mock.calls.find((entry) => String(entry[0]).includes('UpdateGoal'));
    expect(call?.[1]).toMatchObject({ input: { goalId: 'g1', status: 'ARCHIVED' } });
    const queries = client.query.mock.calls.map((entry) => String(entry[0]));
    expect(queries.some((query) => query.includes('deleteSavingGoal'))).toBe(false);
  });

  it('shows an error instead of an empty list when the query fails', async () => {
    const client = { query: vi.fn(() => Promise.reject(new Error('boom'))) };
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), { provide: GraphqlClient, useValue: client }],
    });
    TestBed.overrideComponent(GoalsComponent, {
      remove: { imports: [MoneyComponent] },
      add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
    });
    const fixture: Fixture = TestBed.createComponent(GoalsComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent ?? '').not.toBe('');
  });
});
