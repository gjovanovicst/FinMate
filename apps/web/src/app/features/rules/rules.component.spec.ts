// @vitest-environment jsdom
// FIRST import, deliberately — it loads `@angular/compiler`, which `@angular/router` needs before its
// module body runs. See `@web-test/angular-testing`.
import { initAngularTesting } from '@web-test/angular-testing';

import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GraphqlClient } from '../../core/graphql/graphql.client';
import { RulesComponent } from './rules.component';

initAngularTesting();

/**
 * The rules screen, mounted.
 *
 * A new screen whose whole job is to be *read*, so the assertions are about what a person sees: the
 * rule that will never fire is in the first group, the sentence names the merchant rather than its
 * UUID, and a nested document falls back to the raw JSON instead of being flattened into something
 * false.
 */

const CATEGORIES = {
  categories: [
    { id: 'cat-food', path: 'Hrana › Supermarket' },
    { id: 'cat-house', path: 'Kuća › Septička jama' },
  ],
};
const MERCHANTS = { merchants: { edges: [{ node: { id: 'merchant-lidl', name: 'Lidl' } }] } };
const COUNTERPARTIES = { counterparties: { edges: [] } };

const RULES = {
  rules: [
    {
      id: 'rule-shadowed',
      name: 'Gorivo je Gorivo',
      priority: 900,
      isActive: true,
      stopOnMatch: true,
      conditions: { all: [{ field: 'text', op: 'contains', value: 'gorivo' }] },
      actions: { setCategoryId: 'cat-house' },
      origin: 'LEARNED',
      sourceCorrectionId: 'corr-1',
      hitCount: '0',
      lastHitAt: null,
      isStale: false,
      conflictsWith: [
        {
          ruleId: 'rule-winner',
          ruleName: 'Sve na Hranu',
          priority: 1,
          overlappingField: 'text',
          existingValue: 'cat-food',
          proposedValue: 'cat-house',
        },
      ],
    },
    {
      id: 'rule-healthy',
      name: 'Lidl je Hrana',
      priority: 100,
      isActive: true,
      stopOnMatch: true,
      conditions: { all: [{ field: 'merchant', op: 'eq', value: 'merchant-lidl' }] },
      actions: { setCategoryId: 'cat-food' },
      origin: 'USER',
      sourceCorrectionId: null,
      hitCount: '7',
      lastHitAt: '2026-09-14T10:00:00.000Z',
      isStale: false,
      conflictsWith: [],
    },
    {
      id: 'rule-nested',
      name: 'Ugnježdeno',
      priority: 200,
      isActive: true,
      stopOnMatch: true,
      conditions: {
        all: [{ field: 'kind', op: 'eq', value: 'EXPENSE' }, { any: [{ field: 'text', op: 'contains', value: 'x' }] }],
      },
      actions: {},
      origin: 'USER',
      sourceCorrectionId: null,
      hitCount: '0',
      lastHitAt: null,
      isStale: false,
      conflictsWith: [],
    },
    {
      id: 'rule-off',
      name: 'Isključeno',
      priority: 100,
      isActive: false,
      stopOnMatch: true,
      conditions: { all: [{ field: 'text', op: 'contains', value: 'kafa' }] },
      actions: { setCategoryId: 'cat-food' },
      origin: 'USER',
      sourceCorrectionId: null,
      hitCount: '0',
      lastHitAt: null,
      isStale: true,
      conflictsWith: [],
    },
  ],
};

function stubClient() {
  const query = vi.fn((document: string) => {
    if (document.includes('RuleCategoryNames')) return Promise.resolve(CATEGORIES);
    if (document.includes('RuleMerchantNames')) return Promise.resolve(MERCHANTS);
    if (document.includes('RuleCounterpartyNames')) return Promise.resolve(COUNTERPARTIES);
    if (document.includes('mutation')) return Promise.resolve({ updateRule: { id: 'x', isActive: false } });
    return Promise.resolve(RULES);
  });
  return { client: { query } as unknown as GraphqlClient, query };
}

async function mount(client: GraphqlClient) {
  TestBed.configureTestingModule({
    imports: [RulesComponent],
    providers: [provideZonelessChangeDetection(), provideRouter([]), { provide: GraphqlClient, useValue: client }],
  });
  const fixture = TestBed.createComponent(RulesComponent);
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance };
}

describe('RulesComponent (mounted)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders the shadowed rule first, naming the rule that beats it and the category it sets', async () => {
    const { fixture, component } = await mount(stubClient().client);
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(component.buckets().needsAttention.map((rule) => rule.id)).toEqual(['rule-shadowed']);
    expect(text).toContain('Worth a look');
    // Both facts the user needs: which rule wins, and what it decides. An id here would be useless.
    expect(text).toContain('Sve na Hranu');
    expect(text).toContain('Hrana › Supermarket');
  });

  it('renders a rule as a sentence, resolving the merchant name', async () => {
    const { fixture } = await mount(stubClient().client);
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    // The condition reads "merchant is Lidl" — not the UUID — and the action names its category.
    expect(text).toContain('merchant is Lidl');
    expect(text).toContain('categorise as Hrana › Supermarket');
    expect(text).not.toContain('merchant-lidl');
    expect(text).toContain('7 matched');
    // A learned rule is labelled as such, so it is never presented as one the user wrote (ADR-010).
    expect(text).toContain('learned');
    expect(text).toContain('yours');
  });

  it('shows a nested document raw rather than flattening it into something false', async () => {
    const { fixture } = await mount(stubClient().client);
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(text).toContain('This rule nests conditions, so it is shown as stored:');
    // The raw document is present verbatim, so `any` is visible instead of being dropped.
    expect(text).toContain('"any"');
  });

  it('does not nag about a rule the user switched off', async () => {
    const { component } = await mount(stubClient().client);
    expect(component.buckets().needsAttention.map((rule) => rule.id)).not.toContain('rule-off');
    expect(component.buckets().inactive.map((rule) => rule.id)).toEqual(['rule-off']);
  });

  it('reports the empty state instead of an empty screen', async () => {
    const client = stubClient();
    (client.query as ReturnType<typeof vi.fn>).mockImplementation((document: string) => {
      if (document.includes('RuleCategoryNames')) return Promise.resolve(CATEGORIES);
      if (document.includes('RuleMerchantNames')) return Promise.resolve(MERCHANTS);
      if (document.includes('RuleCounterpartyNames')) return Promise.resolve(COUNTERPARTIES);
      return Promise.resolve({ rules: [] });
    });

    const { fixture } = await mount(client.client);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('No rules yet');
  });
});
