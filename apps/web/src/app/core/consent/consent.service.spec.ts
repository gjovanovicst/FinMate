// @vitest-environment jsdom
// FIRST import, deliberately: it loads the JIT compiler before any Angular import (docs/15 §9), which
// `TestBed` needs even for a service with no template.
import { initAngularTesting } from '@web-test/angular-testing';

import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GraphqlClient } from '../graphql/graphql.client';
import { ConsentService } from './consent.service';
import { AI_CONSENT_POLICY_VERSION, type AiEgressEntry, type ConsentRecord } from './consent.view';

initAngularTesting();

/**
 * The consent service — docs/08 §6.6.
 *
 * Two behaviours here are not plumbing. **A write re-reads** rather than patching the local list, because
 * the table is append-only and "the newest row is the state" is the API's rule — a second implementation
 * of it in the client is how the screen starts showing a grant the server does not hold. And **a refused
 * write changes nothing**, because a consent screen that appeared to have recorded a decision it did not
 * would be evidence of a lawful basis nobody has.
 */
const RECORDS: ConsentRecord[] = [
  { kind: 'AI_DATA_PROCESSING', state: 'NOT_ASKED', recordedAt: null, policyVersion: null, purposes: [] },
];
const ROUTES: AiEgressEntry[] = [
  {
    purpose: 'AI_DATA_PROCESSING',
    task: 'CLASSIFY',
    endpoint: 'DEEPSEEK_GLOBAL',
    provider: 'DEEPSEEK',
    region: 'NON_EEA',
    requiresConsent: true,
  },
];

/**
 * A `GraphqlClient` double whose **signature is declared**.
 *
 * `vi.fn(() => …)` infers a zero-argument call signature, so `mock.calls[0]` is typed as the empty tuple
 * `[]` and indexing it is `TS2493` — which `web:build` reports (it compiles specs) even when a bare `tsc`
 * run does not. Declaring the parameters is what makes `calls[0][0]` a string.
 */
type QueryDouble = ReturnType<typeof vi.fn<(document: string, variables?: Record<string, unknown>) => Promise<unknown>>>;

function mount(query: QueryDouble) {
  TestBed.configureTestingModule({ providers: [{ provide: GraphqlClient, useValue: { query } }] });
  return TestBed.inject(ConsentService);
}

afterEach(() => TestBed.resetTestingModule());

describe('ConsentService', () => {
  it('reads the state and the disclosure in one request', async () => {
    const query: QueryDouble = vi.fn(() => Promise.resolve({ aiConsents: RECORDS, aiEgress: ROUTES }));
    const service = mount(query);

    await service.load();

    expect(query).toHaveBeenCalledTimes(1);
    // One document carries both, so a decision cannot render without what it permits.
    expect(String(query.mock.calls[0]?.[0])).toContain('aiConsents');
    expect(String(query.mock.calls[0]?.[0])).toContain('aiEgress');
    expect(service.state('AI_DATA_PROCESSING')).toBe('NOT_ASKED');
    expect(service.routes()).toEqual(ROUTES);
    expect(service.askable()).toBe('AI_DATA_PROCESSING');
  });

  it('sends the copy revision and the surface with a decision, then re-reads', async () => {
    const granted: ConsentRecord[] = [{ ...RECORDS[0]!, state: 'GRANTED' }];
    const query: QueryDouble = vi
      .fn()
      .mockResolvedValueOnce({ aiConsents: RECORDS, aiEgress: ROUTES })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ aiConsents: granted, aiEgress: ROUTES });
    const service = mount(query);
    await service.load();

    const ok = await service.record('AI_DATA_PROCESSING', 'GRANTED', 'settings');

    expect(ok).toBe(true);
    const [, variables] = query.mock.calls[1] as unknown as [string, { input: Record<string, unknown> }];
    expect(variables.input).toMatchObject({
      kind: 'AI_DATA_PROCESSING',
      state: 'GRANTED',
      surface: 'settings',
      policyVersion: AI_CONSENT_POLICY_VERSION,
    });
    // Re-read, not patched: the server's newest row is the state.
    expect(query).toHaveBeenCalledTimes(3);
    expect(service.state('AI_DATA_PROCESSING')).toBe('GRANTED');
  });

  it('leaves the previous state alone when the write is refused, and says why', async () => {
    const query: QueryDouble = vi
      .fn()
      .mockResolvedValueOnce({ aiConsents: RECORDS, aiEgress: ROUTES })
      .mockRejectedValueOnce(new Error('FORBIDDEN'));
    const service = mount(query);
    await service.load();

    const ok = await service.record('AI_DATA_PROCESSING', 'GRANTED', 'settings');

    expect(ok).toBe(false);
    expect(service.state('AI_DATA_PROCESSING')).toBe('NOT_ASKED');
    expect(service.error()).not.toBeNull();
  });

  it('reports a failed read instead of rendering an empty screen as a decision', async () => {
    const service = mount(vi.fn(() => Promise.reject(new Error('offline'))) as QueryDouble);

    await service.load();

    expect(service.error()).not.toBeNull();
    // Nothing was invented: no state means NOT_ASKED, which is the safe reading, and the surface says so.
    expect(service.states()).toEqual([]);
    expect(service.routes()).toEqual([]);
  });
});
