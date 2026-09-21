// @vitest-environment jsdom
// FIRST import, deliberately: it loads `@angular/compiler`, and `@angular/router` is a partially
// compiled package whose module body needs the JIT compiler to already be present (see
// `capture.component.spec.ts`).
import { initAngularTesting } from '@web-test/angular-testing';

import { CUSTOM_ELEMENTS_SCHEMA, Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GraphqlClient } from '../../core/graphql/graphql.client';
import { OnboardingStore } from '../../core/onboarding/onboarding.store';
import { CaptureComponent } from '../capture/capture.component';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { OnboardingComponent } from './onboarding.component';

initAngularTesting();

/**
 * The onboarding wizard, mounted.
 *
 * The pure decisions live in `onboarding.view.spec.ts`. What is asserted here is only what a
 * *rendered* component can show, and each one is a way the wizard could quietly do the wrong thing:
 *
 *  - step 1 previews the tree it is about to create, and Continue is what WRITES it (`Skip` must not);
 *  - Continue on step 2 creates exactly one Account, because I-4 makes a Transaction without one
 *    illegal — and a resumed Household with an account must not get a second;
 *  - step 3 creates the Counterparty **with the whole phrase as its alias** and a rule only when the
 *    pipeline settled on a category, which is ADR-010's "proposed, then confirmed";
 *  - step 4 reports what `applyMerchantSelection` actually did, including the two refusals it can
 *    return, rather than claiming a clean sweep;
 *  - the last step records completion and leaves, and it tells the shared store so the dashboard
 *    guard stops redirecting.
 *
 * `fm-capture` is replaced by a stub: step 6 embeds the real capture screen, which owns its own spec,
 * and mounting it here would test two components at once.
 */
@Component({ selector: 'fm-capture', standalone: true, template: '<p data-test="capture-stub"></p>' })
class CaptureStub {}

interface StubOptions {
  readonly state?: {
    step: number;
    categories: number;
    accounts: number;
    /** The Household's ledger currency (ADR-045). Defaults to the shipped one, as most specs assume. */
    currency?: string;
  };
  readonly onMutation?: (document: string, variables: Record<string, unknown>) => unknown;
}

function stubClient(options: StubOptions = {}) {
  const mutations: { document: string; variables: Record<string, unknown> }[] = [];

  const query = vi.fn((document: string, variables?: Record<string, unknown>) => {
    const vars = variables ?? {};

    if (document.includes('OnboardingCategoryNames')) {
      return Promise.resolve({
        categories: [
          { id: 'cat-house', path: ['Kuća', 'Septička jama'] },
          { id: 'cat-food', path: ['Hrana', 'Supermarket'] },
        ],
      });
    }
    if (document.includes('OnboardingState')) {
      return Promise.resolve({
        onboardingState: {
          currency: 'RSD',
          ...(options.state ?? { step: 1, categories: 0, accounts: 0 }),
        },
      });
    }

    mutations.push({ document, variables: vars });
    return Promise.resolve(options.onMutation?.(document, vars) ?? mutationResponse(document, vars));
  });

  return { client: { query } as unknown as GraphqlClient, query, mutations };
}

function mutationResponse(document: string, variables: Record<string, unknown>): unknown {
  if (document.includes('SetOnboardingStep')) {
    return { setOnboardingStep: { step: variables['step'], categories: 0, accounts: 0 } };
  }
  if (document.includes('SeedStarterCategories')) {
    return { seedStarterCategories: { categories: 39, keywords: 131, reused: 0 } };
  }
  if (document.includes('OnboardingAccount')) return { createAccount: { id: 'acct-1' } };
  if (document.includes('OnboardingParse')) {
    // The pipeline segments on commas; the stub does the same so a single-phrase input yields one card.
    const text = String(variables['text'] ?? '');
    const phrases = text.split(',').map((part) => part.trim()).filter((part) => part !== '');
    // The category depends on the PHRASE, not on its position — which is what the live API does: a
    // person's name implies no category, a bill like `septička jama` does. A stub that numbered the
    // cards instead would hide the difference the picker exists to handle.
    return {
      captureParse: {
        fragments: phrases.map((description) => ({
          description,
          categoryId: /septicka|septička/i.test(description) ? 'cat-house' : null,
          needsReview: !/septicka|septička/i.test(description),
        })),
      },
    };
  }
  if (document.includes('OnboardingCounterparty')) return { createCounterparty: { id: 'cp-1' } };
  if (document.includes('OnboardingAliases')) return { setCounterpartyAliases: { id: 'cp-1' } };
  if (document.includes('OnboardingRule')) return { createRule: { id: 'rule-1' } };
  if (document.includes('ApplyMerchantSelection')) {
    return {
      applyMerchantSelection: {
        applied: 3,
        alreadyOwned: 1,
        unresolved: ['Nepostojeći'],
        withoutCategory: ['Maxi'],
      },
    };
  }
  if (document.includes('OnboardingBudget')) return { upsertBudget: { id: 'budget-1' } };
  if (document.includes('CompleteOnboarding')) {
    return { completeOnboarding: { step: 7, completedAt: '2026-09-15T12:00:00.000Z' } };
  }
  return {};
}

async function mount(options: StubOptions = {}) {
  const stub = stubClient(options);

  TestBed.configureTestingModule({
    imports: [OnboardingComponent],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([
        { path: '', children: [] },
        { path: 'onboarding', children: [] },
      ]),
      { provide: GraphqlClient, useValue: stub.client },
    ],
  });
  TestBed.overrideComponent(OnboardingComponent, {
    // `fm-icon` is a signal-input child and the JIT runner cannot bind one from a parent template
    // (NG0950 — see `@web-test/angular-testing`), so it joins the capture composer in the removal list.
    remove: { imports: [CaptureComponent, IconComponent] },
    add: { imports: [CaptureStub], schemas: [CUSTOM_ELEMENTS_SCHEMA] },
  });

  const fixture = TestBed.createComponent(OnboardingComponent);
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, stub, store: TestBed.inject(OnboardingStore) };
}

function text(fixture: { nativeElement: unknown }): string {
  return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

function buttonByText(fixture: { nativeElement: unknown }, label: string): HTMLButtonElement {
  const buttons = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'));
  const found = buttons.find((button) => (button.textContent ?? '').trim() === label);
  if (!found) throw new Error(`no button labelled "${label}" (have: ${buttons.map((b) => b.textContent?.trim()).join(' | ')})`);
  return found;
}

/** The mutation documents actually sent, for assertions about what was NOT called. */
function sent(stub: { mutations: { document: string }[] }, needle: string): number {
  return stub.mutations.filter((entry) => entry.document.includes(needle)).length;
}

describe('OnboardingComponent (mounted)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  // A mounted test that waits for the seed preview's tree: real work (the 39-node seed content is
  // built in the component), ~3.8 s alone, and it crossed Vitest's 5 s default in a full parallel
  // `nx run-many -t test` — a timeout, not a failed assertion. The explicit budget is the same fix the
  // recurring suite needed; docs/15 records the pattern.
  it('shows step 1 with the tree it is about to create', { timeout: 20_000 }, async () => {
    const { fixture } = await mount();
    const body = text(fixture);

    expect(body).toContain('Pick your starting categories');
    expect(body).toContain('Step 1 of 6');
    // The preview comes from the same document the server writes, so these are the real node names.
    expect(body).toContain('Supermarket');
    expect(body).toContain('Septička jama');
    expect(body).toContain('Expense');
  });

  it('switches the preview between expenses and income', async () => {
    const { fixture } = await mount();
    expect(text(fixture)).toContain('Supermarket');

    buttonByText(fixture, 'Income').click();
    fixture.detectChanges();

    // Category names come from the shipped document, so they stay Serbian in both languages — the
    // seed *is* the content (docs/11 §2.3).
    expect(text(fixture)).toContain('Penzija');
    expect(text(fixture)).not.toContain('Supermarket');
  });

  it('enables Continue on step 1 for a fresh Household, because Continue is what writes the tree', async () => {
    // The server reports zero categories for a Household that has never seeded, which is the state
    // every real signup starts in. Continue is the control that writes them (docs/02 §4.1), so it
    // must be live — the regression this guards disabled it until the tree existed, which a fresh
    // Household could never reach, leaving Skip (which does not seed) as the only way forward.
    const { fixture, component } = await mount();
    expect(buttonByText(fixture, 'Continue').disabled).toBe(false);
    expect(component.canContinue()).toBe(true);
  });

  it('writes the tree on Continue, then advances', async () => {
    const { fixture, stub } = await mount();

    buttonByText(fixture, 'Continue').click();
    await fixture.whenStable();

    expect(sent(stub, 'SeedStarterCategories')).toBe(1);
    expect(sent(stub, 'SetOnboardingStep')).toBe(1);
  });

  it('does NOT write the tree on Skip', async () => {
    // Skip means "empty tree, categorisation stays manual" (docs/02 §4.1), so it must not seed.
    const { fixture, stub } = await mount();

    buttonByText(fixture, 'Skip').click();
    await fixture.whenStable();

    expect(sent(stub, 'SeedStarterCategories')).toBe(0);
    expect(sent(stub, 'SetOnboardingStep')).toBe(1);
  });

  it('creates exactly one account on step 2, and labels Skip as the default-account path', async () => {
    const { fixture, stub } = await mount({
      state: { step: 2, categories: 39, accounts: 0 },
    });

    // docs/02 §4.1: skipping step 2 leaves the one CASH account I-4 requires, and the button says so
    // rather than quietly creating a record.
    expect(text(fixture)).toContain('Skip (use cash)');

    buttonByText(fixture, 'Skip (use cash)').click();
    await fixture.whenStable();

    expect(sent(stub, 'OnboardingAccount')).toBe(1);
    const created = stub.mutations.find((entry) => entry.document.includes('OnboardingAccount'));
    expect(created?.variables).toMatchObject({ kind: 'CASH' });
  });

  it('enables Continue on step 2 so the typed account is the one created', async () => {
    // Continue on step 2 is `createAccount`, so it must be live before an account exists: reading the
    // count alone disabled the one control that writes it, and only *Skip (use cash)* — which ignores
    // the typed name and kind — could move on.
    const { fixture, component, stub } = await mount({
      state: { step: 2, categories: 39, accounts: 0 },
    });

    // The field is pre-filled from the catalogue, so a fresh Household can continue immediately.
    expect(buttonByText(fixture, 'Continue').disabled).toBe(false);

    component.accountName.set('Banca Intesa');
    component.accountKind = 'BANK';
    fixture.detectChanges();
    buttonByText(fixture, 'Continue').click();
    await fixture.whenStable();

    const created = stub.mutations.find((entry) => entry.document.includes('OnboardingAccount'));
    expect(created?.variables).toMatchObject({ name: 'Banca Intesa', kind: 'BANK' });
  });

  it('keeps step 2 Continue disabled while the name is empty', async () => {
    const { fixture, component } = await mount({ state: { step: 2, categories: 39, accounts: 0 } });
    expect(buttonByText(fixture, 'Continue').disabled).toBe(false);

    component.accountName.set('   ');
    fixture.detectChanges();

    expect(buttonByText(fixture, 'Continue').disabled).toBe(true);
  });

  it('does not create a second account for a resumed Household', async () => {
    const { fixture, stub } = await mount({ state: { step: 2, categories: 39, accounts: 2 } });
    expect(text(fixture)).not.toContain('Skip (use cash)');

    buttonByText(fixture, 'Continue').click();
    await fixture.whenStable();

    expect(sent(stub, 'OnboardingAccount')).toBe(0);
  });

  it('asks the real pipeline for the step-3 suggestions and renders a card per phrase', async () => {
    const { fixture, component, stub } = await mount({ state: { step: 3, categories: 39, accounts: 1 } });

    component.peopleInput = 'Dejan rođa, septička jama';
    await component.proposePeople();
    fixture.detectChanges();

    expect(sent(stub, 'OnboardingParse')).toBe(1);
    expect(text(fixture)).toContain('Dejan');
    // The phrase with no category shows the blank option rather than inventing one, and both cards can
    // be given one by hand.
    expect(text(fixture)).toContain('No category yet');
    expect(text(fixture)).toContain('Kuća › Septička jama');
  });

  it('creates the Counterparty with the WHOLE phrase as its alias', async () => {
    const { fixture, component, stub } = await mount({ state: { step: 3, categories: 39, accounts: 1 } });

    component.peopleInput = 'Dejan rođa, septička jama';
    await component.proposePeople();
    fixture.detectChanges();

    const [first] = component.proposals();
    await component.addPerson(first!);
    await fixture.whenStable();

    const aliases = stub.mutations.find((entry) => entry.document.includes('OnboardingAliases'));
    // `Dejan` alone would not match a later `Dejan rođa 3600` — rung 3 needs every token present.
    expect(aliases?.variables['aliases']).toEqual(['dejan roda']);
    // And with no category implied, no rule: the picker is how the user supplies one.
    expect(sent(stub, 'OnboardingRule')).toBe(0);
  });

  it('creates the Counterparty regardless, but a rule only with a category', async () => {
    const { fixture, component, stub } = await mount({ state: { step: 3, categories: 39, accounts: 1 } });

    component.peopleInput = 'Dejan rođa, septička jama';
    await component.proposePeople();
    fixture.detectChanges();

    const [person, bill] = component.proposals();
    await component.addPerson(person!);
    await component.addPerson(bill!);
    await fixture.whenStable();

    // Both names are remembered either way — the alias is what makes them resolve next time.
    expect(sent(stub, 'OnboardingCounterparty')).toBe(2);
    expect(sent(stub, 'OnboardingAliases')).toBe(2);
    // ADR-010: only the user's Dodaj creates a rule, and never without a category to set.
    expect(sent(stub, 'OnboardingRule')).toBe(1);
  });

  it('lets the user give a PERSON a category, which is the only way step 3 can learn a person', async () => {
    // `Dejan rođa` implies no category by itself, so without this picker step 3 could only ever create
    // a rule for a bill — the F-09 case docs/01 §5 asks it to cover would be unreachable.
    const { fixture, component, stub } = await mount({ state: { step: 3, categories: 39, accounts: 1 } });

    component.peopleInput = 'Dejan rođa';
    await component.proposePeople();
    fixture.detectChanges();
    expect(component.chosenFor(component.proposals()[0]!)).toBe('');

    component.chooseCategory(0, 'cat-house');
    fixture.detectChanges();

    await component.addPerson(component.proposals()[0]!);
    await fixture.whenStable();

    const rule = stub.mutations.find((entry) => entry.document.includes('OnboardingRule'));
    expect(rule?.variables['actions']).toEqual({ setCategoryId: 'cat-house' });
    // The chosen category is also the Counterparty's default, so a plain name match categorises.
    const created = stub.mutations.find((entry) => entry.document.includes('OnboardingCounterparty'));
    expect(created?.variables['defaultCategoryId']).toBe('cat-house');
  });

  it('takes the pipeline suggestion as the default choice, so the common case is one tap', async () => {
    const { component } = await mount({ state: { step: 3, categories: 39, accounts: 1 } });

    component.peopleInput = 'septička jama';
    await component.proposePeople();

    expect(component.chosenFor(component.proposals()[0]!)).toBe('cat-house');
  });

  it('lets a chosen category be cleared again', async () => {
    const { component } = await mount({ state: { step: 3, categories: 39, accounts: 1 } });

    component.peopleInput = 'septička jama';
    await component.proposePeople();
    component.chooseCategory(0, '');
    expect(component.chosenFor(component.proposals()[0]!)).toBe('');
  });

  it('marks a card added so it cannot be added twice', async () => {
    const { fixture, component } = await mount({ state: { step: 3, categories: 39, accounts: 1 } });

    component.peopleInput = 'Dejan rođa';
    await component.proposePeople();
    fixture.detectChanges();
    expect(component.proposals()).toHaveLength(1);

    const [proposal] = component.proposals();
    await component.addPerson(proposal!);
    fixture.detectChanges();

    expect(text(fixture)).toContain('Added');
    // The card offers no second Add, so the same Counterparty cannot be created twice.
    expect(() => buttonByText(fixture, 'Add')).toThrow();
  });

  it('applies the merchant selection and reports the two refusals it can return', async () => {
    const { fixture, component, stub } = await mount({ state: { step: 4, categories: 39, accounts: 1 } });

    component.toggleMerchant('Lidl');
    component.toggleMerchant('Maxi');
    fixture.detectChanges();
    expect(text(fixture)).toContain('2 selected');

    buttonByText(fixture, 'Continue').click();
    await fixture.whenStable();

    const applied = stub.mutations.find((entry) => entry.document.includes('ApplyMerchantSelection'));
    expect(applied?.variables['names']).toEqual(['Lidl', 'Maxi']);

    // All four outcomes are surfaced; a wizard that says "3 added" while one merchant silently got no
    // category is claiming a suggestion it did not make.
    const body = text(fixture);
    expect(body).toContain('3 added to your household');
    expect(body).toContain('1 already yours');
    expect(body).toContain('could not be given a category');
    expect(body).toContain('Nepostojeći');
  });

  it('filters the merchant list through the shared fold, so a Cyrillic query finds the same rows', async () => {
    const { fixture, component } = await mount({ state: { step: 4, categories: 39, accounts: 1 } });

    component.merchantQuery.set('лидл');
    fixture.detectChanges();

    expect(text(fixture)).toContain('Lidl');
    expect(text(fixture)).not.toContain('Netflix');
  });

  it('writes the budget when an amount was given', async () => {
    const { fixture, component, stub } = await mount({ state: { step: 5, categories: 39, accounts: 1 } });

    component.budgetAmount = '120000';
    buttonByText(fixture, 'Continue').click();
    await fixture.whenStable();

    const budget = stub.mutations.find((entry) => entry.document.includes('OnboardingBudget'));
    // Minor units as a STRING: the API rejects a JSON number for Money (ADR-003).
    expect(budget?.variables['amount']).toEqual({ amountMinor: '12000000', currency: 'RSD' });
    expect(budget?.variables['period']).toBe('MONTHLY');
  });

  it('parses a Serbian amount, where a dot is a thousands separator', async () => {
    const { fixture, component, stub } = await mount({ state: { step: 5, categories: 39, accounts: 1 } });

    component.budgetAmount = '1.200';
    buttonByText(fixture, 'Continue').click();
    await fixture.whenStable();

    const budget = stub.mutations.find((entry) => entry.document.includes('OnboardingBudget'));
    expect(budget?.variables['amount']).toEqual({ amountMinor: '120000', currency: 'RSD' });
  });

  it('shows the currency chosen at signup on step 2, not the shipped default', async () => {
    // ADR-045 lets the reader choose the ledger currency at signup, so the wizard must serve it.
    // This field was the literal `RSD` and told a EUR Household the wrong thing.
    const { fixture } = await mount({
      state: { step: 2, categories: 39, accounts: 0, currency: 'EUR' },
    });

    const field = (fixture.nativeElement as HTMLElement).querySelector('input[readonly]');
    expect((field as HTMLInputElement).value).toBe('EUR');
    expect(text(fixture)).toContain('(EUR)');
  });

  it('prices the budget in the Household currency, not a hardcoded RSD', async () => {
    // JPY has no minor unit, so parsing it as RSD (2 decimals) inflated the budget 100×.
    const { fixture, component, stub } = await mount({
      state: { step: 5, categories: 39, accounts: 1, currency: 'JPY' },
    });

    component.budgetAmount = '120000';
    buttonByText(fixture, 'Continue').click();
    await fixture.whenStable();

    const budget = stub.mutations.find((entry) => entry.document.includes('OnboardingBudget'));
    expect(budget?.variables['amount']).toEqual({ amountMinor: '120000', currency: 'JPY' });
  });

  it('advances without writing a budget when the amount is left empty', async () => {
    const { fixture, stub } = await mount({ state: { step: 5, categories: 39, accounts: 1 } });

    buttonByText(fixture, 'Continue').click();
    await fixture.whenStable();

    expect(sent(stub, 'OnboardingBudget')).toBe(0);
    expect(sent(stub, 'SetOnboardingStep')).toBe(1);
  });

  it('embeds the capture screen for the guided first entry', async () => {
    const { fixture } = await mount({ state: { step: 6, categories: 39, accounts: 1 } });
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="capture-stub"]')).not.toBeNull();
  });

  it('records completion, tells the guard store, and leaves', async () => {
    const { fixture, stub, store } = await mount({ state: { step: 6, categories: 39, accounts: 1 } });
    expect(store.needed()).toBe(false);

    buttonByText(fixture, 'Finish').click();
    await fixture.whenStable();

    expect(sent(stub, 'CompleteOnboarding')).toBe(1);
    // The guard caches this, so the dashboard would bounce straight back without the update.
    expect(store.needed()).toBe(false);
  });

  it('shows the server message when a step fails, and stays on the step', async () => {
    // The user must not advance past a write that did not happen.
    const { fixture, component, stub } = await mount({
      state: { step: 1, categories: 39, accounts: 0 },
      onMutation: (document) => {
        if (document.includes('SeedStarterCategories')) throw new Error('network down');
        return mutationResponse(document, {});
      },
    });

    buttonByText(fixture, 'Continue').click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(text(fixture)).toContain('network down');
    expect(component.step()).toBe(1);
    expect(sent(stub, 'SetOnboardingStep')).toBe(0);
  });

  it('goes back without writing anything', async () => {
    const { fixture, component, stub } = await mount({ state: { step: 3, categories: 39, accounts: 1 } });

    buttonByText(fixture, 'Back').click();
    await fixture.whenStable();

    expect(component.step()).toBe(2);
    expect(sent(stub, 'SetOnboardingStep')).toBe(1);
    expect(sent(stub, 'SeedStarterCategories')).toBe(0);
  });

  it('does nothing on Back at the first step', async () => {
    const { fixture, stub } = await mount();
    buttonByText(fixture, 'Back').click();
    await fixture.whenStable();
    expect(sent(stub, 'SetOnboardingStep')).toBe(0);
  });
});
