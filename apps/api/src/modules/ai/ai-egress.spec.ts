import { describe, expect, it } from 'vitest';

import type { Endpoint, Task } from '@finmate/ai';

import { AiEgressRegionEnum, toAiEgressModels } from './ai-egress.model';
import type { AiAssembly } from './ai-providers';

/**
 * The egress disclosure — docs/08 §6.5, §6.6, ADR-031.
 *
 * The consent sheet has to name the provider **and the region**, and this mapping is where "an endpoint
 * name" becomes "a sentence a person can decide on". It is pure, so every branch is asserted here rather
 * than through a Nest module — and the branch that matters most is the one that must never say EEA when
 * it is not.
 */
function assembly(routes: Partial<Record<Task, Endpoint>>, providers: Partial<Record<Endpoint, string>>): AiAssembly {
  const routing: Record<string, { primary: Endpoint; fallback: null }> = {};
  const built: Partial<Record<Endpoint, { name: string }>> = {};
  for (const [task, endpoint] of Object.entries(routes)) {
    if (endpoint === undefined) continue;
    routing[task] = { primary: endpoint, fallback: null };
    built[endpoint] = { name: providers[endpoint] ?? 'UNKNOWN' };
  }
  return {
    routing,
    providers: built,
    routedTasks: Object.keys(routing) as Task[],
    skipped: [],
  } as unknown as AiAssembly;
}

describe('toAiEgressModels', () => {
  it('reports a non-EEA route as needing consent, with the provider that would answer', () => {
    const rows = toAiEgressModels(assembly({ CLASSIFY: 'DEEPSEEK_GLOBAL' }, { DEEPSEEK_GLOBAL: 'DEEPSEEK' }));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purpose: 'AI_DATA_PROCESSING',
      task: 'CLASSIFY',
      endpoint: 'DEEPSEEK_GLOBAL',
      provider: 'DEEPSEEK',
      region: AiEgressRegionEnum.NON_EEA,
      requiresConsent: true,
    });
  });

  it('never calls this node EEA, and never asks consent for it', () => {
    // `LOCAL` is not an EEA endpoint — it is *this* node — and "we process it here" and "we send it to an
    // EEA processor" are different sentences for somebody to agree to. Asking consent for a LOCAL route
    // would also ask about nothing.
    const rows = toAiEgressModels(assembly({ CLASSIFY: 'LOCAL' }, { LOCAL: 'LOCAL' }));

    expect(rows[0]).toMatchObject({ region: AiEgressRegionEnum.LOCAL, requiresConsent: false });
  });

  it('reports an `_EU` endpoint as EEA, because its host is configured rather than implied', () => {
    const rows = toAiEgressModels(assembly({ CLASSIFY: 'DEEPSEEK_EU' }, { DEEPSEEK_EU: 'DEEPSEEK' }));

    expect(rows[0]).toMatchObject({ region: AiEgressRegionEnum.EEA, requiresConsent: false });
  });

  it('maps a task to the purpose that governs it, and groups the text tasks together', () => {
    const rows = toAiEgressModels(
      assembly(
        { CLASSIFY: 'DEEPSEEK_GLOBAL', NARRATE: 'DEEPSEEK_GLOBAL', OCR: 'DEEPSEEK_EU' },
        { DEEPSEEK_GLOBAL: 'DEEPSEEK', DEEPSEEK_EU: 'DEEPSEEK' },
      ),
    );

    expect(rows.map((row) => [row.task, row.purpose])).toEqual([
      ['CLASSIFY', 'AI_DATA_PROCESSING'],
      ['NARRATE', 'AI_DATA_PROCESSING'],
      ['OCR', 'CLOUD_OCR'],
    ]);
  });

  it('has nothing to disclose when nothing is routed, which is the inert deployment', () => {
    expect(toAiEgressModels(assembly({}, {}))).toEqual([]);
  });

  it('fails closed on an endpoint that is not shown to be this node or EEA', () => {
    // Unreachable through the composition root, which refuses an endpoint it cannot place — but the
    // disclosure must not be the place a future endpoint quietly becomes EEA by omission.
    const rows = toAiEgressModels(assembly({ CLASSIFY: 'MYSTERY' as Endpoint }, {}));

    expect(rows[0]).toMatchObject({
      region: AiEgressRegionEnum.NON_EEA,
      requiresConsent: true,
    });
  });
});
