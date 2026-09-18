import { describe, expect, it } from 'vitest';

import type { AiRouter } from '@finmate/ai';

import {
  RoutedQuestionRouter,
  UNCONFIGURED_ROUTER,
  type RouteRequest,
} from './assistant-router';
import { ROUTE_PROMPT } from './route-prompt';

/**
 * The routing seam against a **scripted** router — ADR-036, no provider, no network.
 *
 * Two things are asserted here that the pure validator cannot see: that an answer outside the registry
 * is discarded *without becoming a failure the caller has to handle*, and that the prompt this seam
 * sends is the one `route-prompt.ts` renders — member list in `user`, question left to the adapter.
 */
const request: RouteRequest = { question: 'zapamti ovu ispravku', locale: 'sr-Latn' };

/** A router that answers with whatever the script says, and records what it was asked. */
function scriptedRouter(answer: unknown): {
  router: AiRouter;
  calls: { task: string; input: Record<string, unknown> }[];
} {
  const calls: { task: string; input: Record<string, unknown> }[] = [];
  const router = {
    invoke: async (task: string, input: unknown) => {
      calls.push({ task, input: input as Record<string, unknown> });
      return {
        ok: true,
        value: answer,
        rung: 'FULL_PIPELINE',
        reason: 'AI_UNUSED',
        endpoint: 'LOCAL',
        provider: 'LOCAL',
        telemetry: { latencyMs: 12, costMicros: 7, model: 'stub', promptTokens: 1, completionTokens: 1 },
        failures: [],
        task,
      };
    },
    endpoints: (task: string) => (task === 'ROUTE' ? ['LOCAL'] : []),
  } as unknown as AiRouter;
  return { router, calls };
}

describe('the routing seam (ADR-036)', () => {
  it('is inert and honest when nothing is configured', async () => {
    expect(UNCONFIGURED_ROUTER.available).toBe(false);
    const outcome = await UNCONFIGURED_ROUTER.route(request);
    // No decision, nothing attempted, and a reason that says which of the two it was.
    expect(outcome.decision).toBeNull();
    expect(outcome.attempted).toBe(false);
    expect(outcome.reason).toBe('AI_UNAVAILABLE:no-provider-configured');
    expect(outcome.costMicros).toBe('0');
  });

  it('turns a registered member into a decision, and reports what the call cost', async () => {
    const { router, calls } = scriptedRouter({ route: 'ADD_TAG', text: '  Odmor ' });
    const outcome = await new RoutedQuestionRouter(router).route(request);

    expect(outcome.decision).toEqual({ kind: 'ACTION', action: 'ADD_TAG', text: 'Odmor' });
    expect(outcome.attempted).toBe(true);
    expect(outcome.reason).toBeNull();
    expect(outcome.latencyMs).toBe(12);
    // Micro-units as a **string**: the money path never carries a float (ADR-003).
    expect(outcome.costMicros).toBe('7');

    // The call is a `ROUTE` with the prompt this package renders, and the question travels as data for
    // the adapter to wrap — not inside the instruction half (docs/08 §6.9).
    expect(calls).toHaveLength(1);
    expect(calls[0]?.task).toBe('ROUTE');
    expect(calls[0]?.input['question']).toBe('zapamti ovu ispravku');
    expect(calls[0]?.input['locale']).toBe('sr-Latn');
    expect(calls[0]?.input['templateId']).toBe(ROUTE_PROMPT.templateId);
    expect(String(calls[0]?.input['user'])).toContain('ADD_TAG');
    expect(String(calls[0]?.input['system'])).not.toContain('zapamti ovu ispravku');
  });

  it('discards an unregistered member instead of failing, and says which one it was', async () => {
    // The important half: a model that invents a capability must not become an error the caller has to
    // handle — the caller's response is the refusal it already had. The reason string names the member
    // for the log and **not** the text, which is the user's own words (docs/08 §6.3).
    const { router } = scriptedRouter({ route: 'DELETE_EVERYTHING', text: 'sve' });
    const outcome = await new RoutedQuestionRouter(router).route(request);

    expect(outcome.decision).toBeNull();
    expect(outcome.attempted).toBe(true);
    expect(outcome.reason).toContain('UNREGISTERED_MEMBER');
    expect(outcome.reason).toContain('DELETE_EVERYTHING');
    expect(outcome.reason).not.toContain('sve');
  });

  it('reports a provider failure as no decision, never as a throw', async () => {
    // docs/04 §9's degradation ladder ends in the deterministic path, so a provider outage must not
    // unwind the request that asked the question.
    const failing = {
      invoke: async () => ({
        ok: false,
        rung: 'RULES_KEYWORDS_ONLY',
        reason: 'PROVIDER_UNAVAILABLE',
        task: 'ROUTE',
        failures: [{ endpoint: 'LOCAL', reason: 'TIMEOUT' }],
        error: null,
      }),
    } as unknown as AiRouter;

    const outcome = await new RoutedQuestionRouter(failing).route(request);
    expect(outcome.decision).toBeNull();
    expect(outcome.attempted).toBe(true);
    expect(outcome.reason).toContain('PROVIDER_UNAVAILABLE');
    expect(outcome.reason).toContain('TIMEOUT');
  });

  it('does not call a provider for an empty question', async () => {
    const { router, calls } = scriptedRouter({ route: 'SPEND_TOTAL', text: null });
    const outcome = await new RoutedQuestionRouter(router).route({ question: '   ', locale: 'en' });

    expect(outcome.attempted).toBe(false);
    expect(outcome.reason).toBe('EMPTY_QUESTION');
    expect(calls).toHaveLength(0);
  });
});
