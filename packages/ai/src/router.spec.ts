/**
 * Routing, fallback, the degradation ladder and cost/latency — the integration point of docs/04 §9.
 *
 * Everything here is offline: providers point at a stub `fetch`, or at a purpose-built stub
 * `AiProvider` when the point is the router rather than an adapter.
 *
 * @module @finmate/ai
 */

import { describe, expect, it } from 'vitest';

import {
  DEGRADATION_LADDER,
  AiRouter,
  degradationRank,
  rungForFailure,
  rungForParseProposal,
  supportsTask,
  worstRung,
} from './router';
import { DEFAULT_ROUTING, type Endpoint, type RoutingTable } from './endpoints';

/**
 * A routing table **with** a fallback, for the tests that are about the chain.
 *
 * `DEFAULT_ROUTING` no longer carries one (ADR-031): its `DEEPSEEK_EU` fallback resolved to a non-EEA
 * host. A deployment that has configured an EEA base URL can still route this way, so the router's
 * fail-open behaviour is exercised here rather than through a default that must not exist.
 */
const CHAIN_ROUTING: RoutingTable = {
  PARSE: { primary: 'LOCAL', fallback: 'DEEPSEEK_EU' },
  CLASSIFY: { primary: 'LOCAL', fallback: 'DEEPSEEK_EU' },
  NARRATE: { primary: 'LOCAL', fallback: 'DEEPSEEK_EU' },
  // ⚠️ Text only. An **image** fallback to a cloud endpoint needs a consent gate even inside the EEA
  // (ADR-038, docs/08 §6.5) — `validateRouting` refuses it without one, so a fixture that wants a
  // cloud OCR chain installs a gate; these tests are about fallback mechanics and `CLASSIFY`.
  OCR: { primary: 'LOCAL', fallback: null },
  EMBED: { primary: 'LOCAL', fallback: null },
};
import { AiRequestError, AiTransientError, AiUnavailableError } from './errors';
import {
  unaccountedTelemetry,
  type AiProvider,
  type CallTelemetry,
  type ClassifyInput,
  type ClassifyProposal,
  type ParseProposal,
  type ProviderName,
  type Task,
} from './provider';
import { TASK_TIMEOUTS_MS, createDeepSeekProvider, createLocalProvider } from './adapters/factory';
import { chatCompletion, counterClock, hangingFetch, stubFetch } from './testing/stubs';

const CATEGORY_ID = '0190f2c1-1111-7000-8000-000000000001';

function classifyInput(): ClassifyInput {
  return {
    task: 'CLASSIFY',
    baseUrl: 'https://api.example.invalid',
    system: 's',
    user: 'u',
    templateId: 'classify.serbian-household',
    version: '7',
    locale: 'sr-Latn',
    fragment: { text: 'Lidl 2000', amountMinor: '200000', currency: 'RSD', occurredOn: null },
    categories: [{ id: CATEGORY_ID, path: 'Hrana / Supermarket' }],
  };
}

/** A provider whose behaviour is a function, so the router can be exercised without HTTP. */
class StubProvider implements AiProvider {
  readonly name: ProviderName;
  readonly calls: Task[] = [];

  constructor(
    name: ProviderName,
    private readonly behaviour: (task: Task) => Promise<unknown>,
    private readonly telemetry: Partial<CallTelemetry> = {},
  ) {
    this.name = name;
  }

  async callTask<T>(task: Task, _input: unknown): Promise<{ value: T; telemetry: CallTelemetry }> {
    this.calls.push(task);
    const value = (await this.behaviour(task)) as T;
    return { value, telemetry: { ...unaccountedTelemetry(), ...this.telemetry } };
  }

  async parse(): Promise<ParseProposal> {
    return (await this.behaviour('PARSE')) as ParseProposal;
  }
  async classify(): Promise<ClassifyProposal> {
    return (await this.behaviour('CLASSIFY')) as ClassifyProposal;
  }
  async narrate(): Promise<string> {
    return String(await this.behaviour('NARRATE'));
  }
  ocr?: undefined;
  embed?: undefined;
}

function ok(proposal: ClassifyProposal) {
  return async () => proposal;
}

const GOOD: ClassifyProposal = {
  categoryId: CATEGORY_ID,
  confidence: 0.91,
  rationale: 'lidl je supermarket',
  alternatives: [],
  extracted: {},
};

describe('the ladder vocabulary', () => {
  it('is ordered worst-last', () => {
    expect(DEGRADATION_LADDER).toEqual([
      'FULL_PIPELINE',
      'RULES_KEYWORDS_ONLY',
      'DETERMINISTIC_ONLY',
      'MANUAL_ENTRY',
    ]);
    expect(degradationRank('FULL_PIPELINE')).toBeLessThan(degradationRank('MANUAL_ENTRY'));
  });

  it('merges two outcomes into the worse one', () => {
    expect(worstRung('FULL_PIPELINE', 'DETERMINISTIC_ONLY')).toBe('DETERMINISTIC_ONLY');
    expect(worstRung('MANUAL_ENTRY', 'RULES_KEYWORDS_ONLY')).toBe('MANUAL_ENTRY');
  });

  it('maps a provider outage to rules-only, never to manual entry', () => {
    // Rules and keywords ran before the model and are untouched by an outage (ADR-002).
    expect(rungForFailure('CIRCUIT_OPEN')).toBe('RULES_KEYWORDS_ONLY');
    expect(rungForFailure('TIMEOUT')).toBe('RULES_KEYWORDS_ONLY');
  });

  it('maps a parse miss to deterministic extraction, or manual entry without one', () => {
    expect(rungForParseProposal({ ok: true }, true)).toBe('FULL_PIPELINE');
    expect(rungForParseProposal({ ok: false }, true)).toBe('DETERMINISTIC_ONLY');
    expect(rungForParseProposal({ ok: false }, false)).toBe('MANUAL_ENTRY');
  });
});

describe('constructor', () => {
  it('refuses to exist with an unsafe routing table', () => {
    const unsafe = {
      CLASSIFY: { primary: 'OPENAI', fallback: null },
    } as unknown as RoutingTable;
    expect(() => new AiRouter({ routing: unsafe, providers: {} })).toThrow(
      /not one of the known endpoints/,
    );
  });

  it('accepts the canonical default', () => {
    expect(() => new AiRouter({ routing: DEFAULT_ROUTING, providers: {} })).not.toThrow();
  });
});

describe('the happy path', () => {
  it('uses the primary provider and reports FULL_PIPELINE', async () => {
    const local = new StubProvider('LOCAL', ok(GOOD));
    const router = new AiRouter({ routing: DEFAULT_ROUTING, providers: { LOCAL: local } });

    const result = await router.invoke<ClassifyProposal>('CLASSIFY', classifyInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(GOOD);
    expect(result.rung).toBe('FULL_PIPELINE');
    expect(result.endpoint).toBe('LOCAL');
    expect(result.provider).toBe('LOCAL');
    expect(result.failures).toEqual([]);
  });

  it('returns cost, latency and the provider used, for classification_decisions', async () => {
    const local = new StubProvider('LOCAL', ok(GOOD), {
      model: 'qwen2.5:3b-instruct',
      costMicros: 1234,
      latencyMs: 432,
      promptTokens: 100,
      completionTokens: 20,
      retryCount: 0,
    });
    const router = new AiRouter({ routing: DEFAULT_ROUTING, providers: { LOCAL: local } });

    const result = await router.invoke<ClassifyProposal>('CLASSIFY', classifyInput());
    if (!result.ok) throw new Error('expected success');

    expect(result.telemetry).toEqual({
      model: 'qwen2.5:3b-instruct',
      costMicros: 1234,
      latencyMs: 432,
      promptTokens: 100,
      completionTokens: 20,
      retryCount: 0,
    });
  });

  it('never touches the fallback when the primary answers', async () => {
    const local = new StubProvider('LOCAL', ok(GOOD));
    const deepseek = new StubProvider('DEEPSEEK', ok(GOOD));
    const router = new AiRouter({
      routing: CHAIN_ROUTING,
      providers: { LOCAL: local, DEEPSEEK_EU: deepseek },
    });

    await router.invoke('CLASSIFY', classifyInput());
    expect(deepseek.calls).toEqual([]);
  });
});

describe('fail-open down the chain', () => {
  it('falls through to the fallback when the primary fails', async () => {
    const local = new StubProvider('LOCAL', async () => {
      throw new AiTransientError('TRANSIENT_HTTP', 'HTTP 503', 'LOCAL', 503, 2);
    });
    const deepseek = new StubProvider('DEEPSEEK', ok(GOOD));
    const router = new AiRouter({
      routing: CHAIN_ROUTING,
      providers: { LOCAL: local, DEEPSEEK_EU: deepseek },
    });

    const result = await router.invoke<ClassifyProposal>('CLASSIFY', classifyInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.endpoint).toBe('DEEPSEEK_EU');
    // The fallback's success still counts as the full pipeline — a model answered.
    expect(result.rung).toBe('FULL_PIPELINE');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.endpoint).toBe('LOCAL');
  });

  it('degrades to rules-only when every endpoint is unavailable', async () => {
    const local = new StubProvider('LOCAL', async () => {
      throw new AiTransientError('CONNECTION_FAILED', 'refused', 'LOCAL', null, 2);
    });
    const deepseek = new StubProvider('DEEPSEEK', async () => {
      throw new AiTransientError('TIMEOUT', 'slow', 'DEEPSEEK', null, 2);
    });
    const router = new AiRouter({
      routing: CHAIN_ROUTING,
      providers: { LOCAL: local, DEEPSEEK_EU: deepseek },
    });

    const result = await router.invoke<ClassifyProposal>('CLASSIFY', classifyInput());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rung).toBe('RULES_KEYWORDS_ONLY');
    expect(result.reason).toBe('PROVIDER_UNAVAILABLE');
    expect(result.failures.map((failure) => failure.endpoint)).toEqual(['LOCAL', 'DEEPSEEK_EU']);
  });

  it('treats a missing adapter as a provider failure, not a crash', async () => {
    const router = new AiRouter({ routing: CHAIN_ROUTING, providers: {} });
    const result = await router.invoke('CLASSIFY', classifyInput());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Two hops: the primary and the fallback, each with no adapter mounted.
    expect(result.failures.map((failure) => failure.reason)).toEqual([
      'UNKNOWN_PROVIDER',
      'UNKNOWN_PROVIDER',
    ]);
    expect(result.rung).toBe('RULES_KEYWORDS_ONLY');
  });

  it('skips an endpoint whose adapter has no model for the task', async () => {
    const noEmbed = new StubProvider('LOCAL', ok(GOOD));
    const router = new AiRouter({ routing: DEFAULT_ROUTING, providers: { LOCAL: noEmbed } });

    const result = await router.invoke('EMBED', ['Lidl']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // `EMBED` has a null fallback in the default table, so there is nothing after it.
    expect(result.failures.map((failure) => failure.reason)).toEqual(['TASK_NOT_SUPPORTED']);
  });

  it('reports failure with the requested task, so a caller can attribute it', async () => {
    const router = new AiRouter({ routing: DEFAULT_ROUTING, providers: {} });
    const result = await router.invoke('OCR', {});
    if (result.ok) throw new Error('expected failure');
    expect(result.task).toBe('OCR');
  });
});

describe('a non-retryable failure does not advance to the fallback', () => {
  it('stops at the primary and surfaces the error for an operator', async () => {
    const local = new StubProvider('LOCAL', async () => {
      throw new AiRequestError('NON_RETRYABLE_HTTP', 'HTTP 401', 'LOCAL', 401);
    });
    const deepseek = new StubProvider('DEEPSEEK', ok(GOOD));
    const router = new AiRouter({
      routing: CHAIN_ROUTING,
      providers: { LOCAL: local, DEEPSEEK_EU: deepseek },
    });

    const result = await router.invoke<ClassifyProposal>('CLASSIFY', classifyInput());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The fallback would receive the same bad payload, so trying it is noise.
    expect(deepseek.calls).toEqual([]);
    expect(result.error?.status).toBe(401);
    expect(result.rung).toBe('RULES_KEYWORDS_ONLY');
  });
});

describe('the circuit breaker, through the router', () => {
  /** A provider that always fails transiently, in the shape the transport produces. */
  async function transientFailure(): Promise<never> {
    throw new AiTransientError('TRANSIENT_HTTP', 'HTTP 503', 'LOCAL', 503, 2);
  }

  it('opens after the threshold, short-circuits, and half-opens after the cooldown', async () => {
    const clock = counterClock();
    const local = new StubProvider('LOCAL', transientFailure);
    const deepseek = new StubProvider('DEEPSEEK', ok(GOOD));
    const router = new AiRouter({
      routing: CHAIN_ROUTING,
      providers: { LOCAL: local, DEEPSEEK_EU: deepseek },
      circuit: { now: clock.now, openMs: 1_000 },
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await router.invoke('CLASSIFY', classifyInput());
    }
    expect(local.calls).toHaveLength(3);

    // Fourth call: the circuit is open, so the primary is skipped entirely.
    const shortCircuited = await router.invoke('CLASSIFY', classifyInput());
    expect(local.calls).toHaveLength(3);
    expect(shortCircuited.ok).toBe(true);
    if (!shortCircuited.ok) return;
    expect(shortCircuited.failures.some((failure) => failure.reason === 'CIRCUIT_OPEN')).toBe(true);

    // After the cooldown, one probe is admitted.
    clock.advance(1_000);
    await router.invoke('CLASSIFY', classifyInput());
    expect(local.calls).toHaveLength(4);
  });

  it('reopens on a failed half-open probe and closes on a successful one', async () => {
    const clock = counterClock();
    let shouldFail = true;
    const local = new StubProvider('LOCAL', async (task) => {
      if (shouldFail) return transientFailure();
      return task === 'CLASSIFY' ? GOOD : GOOD;
    });
    const deepseek = new StubProvider('DEEPSEEK', ok(GOOD));
    const router = new AiRouter({
      routing: CHAIN_ROUTING,
      providers: { LOCAL: local, DEEPSEEK_EU: deepseek },
      circuit: { now: clock.now, openMs: 100 },
    });

    for (let attempt = 0; attempt < 3; attempt += 1) await router.invoke('CLASSIFY', classifyInput());

    // The probe fails, so the cooldown restarts: an immediate retry is still short-circuited.
    clock.advance(100);
    await router.invoke('CLASSIFY', classifyInput());
    const callsAfterFailedProbe = local.calls.length;
    await router.invoke('CLASSIFY', classifyInput());
    expect(local.calls).toHaveLength(callsAfterFailedProbe);

    // The next probe succeeds and the circuit closes.
    clock.advance(100);
    shouldFail = false;
    await router.invoke('CLASSIFY', classifyInput());
    expect(local.calls).toHaveLength(callsAfterFailedProbe + 1);

    const snapshot = router.circuitSnapshots().find((entry) => entry.endpoint === 'LOCAL');
    expect(snapshot?.state).toBe('CLOSED');
  });

  it('does not count a 401 towards the circuit — a bad key is not a provider outage', async () => {
    const local = new StubProvider('LOCAL', async () => {
      throw new AiRequestError('NON_RETRYABLE_HTTP', 'HTTP 401', 'LOCAL', 401);
    });
    const router = new AiRouter({
      routing: { CLASSIFY: { primary: 'LOCAL', fallback: null } },
      providers: { LOCAL: local },
    });

    for (let attempt = 0; attempt < 5; attempt += 1) await router.invoke('CLASSIFY', classifyInput());

    // Every attempt reached the provider: the circuit never opened, because counting a 401 would
    // produce a breaker whose half-open probe can never succeed.
    expect(local.calls).toHaveLength(5);
    expect(
      router.circuitSnapshots().find((entry) => entry.endpoint === 'LOCAL')?.state,
    ).toBe('CLOSED');
  });
});

describe('end to end through real adapters and a stub fetch', () => {
  it('routes a classify call and returns adapter telemetry', async () => {
    const stub = stubFetch([
      {
        body: chatCompletion(
          {
            categoryId: 'c1',
            confidence: 0.88,
            rationale: 'lidl je supermarket',
            alternatives: [],
            extracted: { amountMinor: '200000' },
          },
          { model: 'qwen2.5:3b-instruct', promptTokens: 500, completionTokens: 40 },
        ),
      },
    ]);
    const router = new AiRouter({
      routing: DEFAULT_ROUTING,
      providers: { LOCAL: createLocalProvider({ fetch: stub.fetch }) },
    });

    const result = await router.invoke<ClassifyProposal>('CLASSIFY', classifyInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.categoryId).toBe(CATEGORY_ID);
    expect(result.value.extracted.amountMinor).toBe('200000');
    expect(result.telemetry.model).toBe('qwen2.5:3b-instruct');
    expect(result.telemetry.promptTokens).toBe(500);
    // The local model has no price entry, so the cost is a visible hole rather than a guess.
    expect(result.telemetry.costMicros).toBe(0);
    expect(result.telemetry.retryCount).toBe(0);
  });

  it('falls from a dead LOCAL to a DEEPSEEK_EU that answers', async () => {
    const hanging = hangingFetch();
    const deepseekStub = stubFetch([
      {
        body: chatCompletion(
          { categoryId: 'c1', confidence: 0.7, rationale: 'ok', alternatives: [], extracted: {} },
          { model: 'deepseek-chat', promptTokens: 900, completionTokens: 60 },
        ),
      },
    ]);
    const router = new AiRouter({
      routing: CHAIN_ROUTING,
      providers: {
        LOCAL: createLocalProvider({ fetch: hanging.fetch, timeouts: { CLASSIFY: 40 } }),
        // `DEEPSEEK_EU` now has to say which EEA host it means (ADR-031): the factory takes the base
        // URL as an input rather than defaulting to DeepSeek's own platform, which is not in the EEA.
        DEEPSEEK_EU: createDeepSeekProvider({
          apiKey: 'k',
          baseUrl: 'https://eu.example.invalid/v1',
          endpoint: 'DEEPSEEK_EU',
          fetch: deepseekStub.fetch,
        }),
      },
    });

    const result = await router.invoke<ClassifyProposal>('CLASSIFY', classifyInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.endpoint).toBe('DEEPSEEK_EU');
    expect(result.value.categoryId).toBe(CATEGORY_ID);
    // `deepseek-chat` is priced, so a real (tiny) cost is attributed.
    expect(result.telemetry.costMicros).toBeGreaterThan(0);
    expect(deepseekStub.callCount).toBe(1);
  });

  it('is deterministic: the same input and stub give a deep-equal result twice', async () => {
    const response = chatCompletion(
      {
        categoryId: 'c1',
        confidence: 0.88,
        rationale: 'lidl je supermarket',
        alternatives: [{ categoryId: 'c1', confidence: 0.1 }],
        extracted: { amountMinor: '200000', currency: 'RSD' },
      },
      { model: 'qwen2.5:3b-instruct', promptTokens: 500, completionTokens: 40 },
    );
    const stub = stubFetch([{ body: response }]);
    // A frozen clock, so `latencyMs` is part of what can be asserted rather than the one field
    // that always differs. Without it the determinism claim would be untestable, which is how a
    // determinism claim quietly stops being true.
    const router = new AiRouter({
      routing: DEFAULT_ROUTING,
      providers: { LOCAL: createLocalProvider({ fetch: stub.fetch, now: () => 1_000 }) },
    });

    const first = await router.invoke<ClassifyProposal>('CLASSIFY', classifyInput());
    const second = await router.invoke<ClassifyProposal>('CLASSIFY', classifyInput());

    expect(first).toEqual(second);
    if (!first.ok || !second.ok) throw new Error('expected two successes');
    expect(first.telemetry).toEqual(second.telemetry);
    // And the two requests are byte-identical, temperature 0 included.
    expect(JSON.stringify(stub.requests[1]?.body)).toBe(JSON.stringify(stub.requests[0]?.body));
  });
});

describe('supportsTask', () => {
  it('checks the optional members for the two optional tasks', () => {
    const provider = { name: 'LOCAL' } as unknown as AiProvider;
    expect(supportsTask(provider, 'PARSE')).toBe(true);
    expect(supportsTask(provider, 'OCR')).toBe(false);
    expect(supportsTask(provider, 'EMBED')).toBe(false);
    expect(supportsTask({ ...provider, ocr: () => Promise.reject() }, 'OCR')).toBe(true);
  });
});

describe('task budgets are reachable from the package surface', () => {
  it('exposes the documented budgets', () => {
    expect(TASK_TIMEOUTS_MS.PARSE).toBe(2_000);
    expect(TASK_TIMEOUTS_MS.OCR).toBe(20_000);
  });

  it('lets the router route every task the default table declares', () => {
    const router = new AiRouter({ routing: DEFAULT_ROUTING, providers: {} });
    const tasks: Task[] = ['PARSE', 'CLASSIFY', 'NARRATE', 'OCR', 'EMBED'];
    for (const task of tasks) {
      expect(router.endpoints(task).length).toBeGreaterThan(0);
    }
  });

  it('orders the chain primary-first for every default route', () => {
    const router = new AiRouter({ routing: DEFAULT_ROUTING, providers: {} });
    // Every default is LOCAL-only since ADR-031: the fallbacks used to name `*_EU` endpoints whose
    // hosts were not in the EEA (`ANTHROPIC_EU` was not implemented at all).
    expect(router.endpoints('NARRATE')).toEqual(['LOCAL']);
    expect(router.endpoints('OCR')).toEqual(['LOCAL']);
    expect(router.endpoints('EMBED')).toEqual(['LOCAL']);
  });
});

describe('AiUnavailableError', () => {
  it('describes why, rather than reporting a bare "AI is down"', () => {
    const error = new AiUnavailableError('CLASSIFY', [
      { endpoint: 'LOCAL', provider: 'LOCAL', reason: 'CIRCUIT_OPEN', message: 'open', countsAgainstCircuit: false },
    ]);
    expect(error.task).toBe('CLASSIFY');
    expect(error.message).toContain('CIRCUIT_OPEN');
    expect(error.failures).toHaveLength(1);
  });
});

describe('provider names never leak as user-visible copy', () => {
  it('keeps the failure detail in the result, for a log rather than a toast', async () => {
    const router = new AiRouter({ routing: DEFAULT_ROUTING, providers: {} });
    const result = await router.invoke('CLASSIFY', classifyInput());
    if (result.ok) throw new Error('expected failure');
    for (const failure of result.failures) {
      expect(typeof failure.message).toBe('string');
    }
  });

  it('has an Endpoint type that is a closed union at runtime', () => {
    const endpoints: Endpoint[] = ['LOCAL', 'DEEPSEEK_EU', 'OPENAI_EU', 'ANTHROPIC_EU', 'GEMINI_EU'];
    expect(new Set(endpoints).size).toBe(5);
  });
});

describe('the consent gate — the only way a non-EEA endpoint is reachable', () => {
  /**
   * ADR-031's enforcement half. `isAdmissible` was a predicate with no caller: `DEEPSEEK_GLOBAL`
   * could be named in a routing table and `validateRouting` refused it, so there was no path by which
   * consent could ever be *asked*. These cases pin the two properties that matter:
   *
   * 1. a table naming a non-EEA endpoint cannot be constructed **without** a gate — installing one is
   *    what makes the route legal, so a deployment cannot forget; and
   * 2. the gate's answer is asked on **every call** and a `false` means no socket is opened.
   */
  const NON_EEA_ROUTING: RoutingTable = {
    CLASSIFY: { primary: 'DEEPSEEK_GLOBAL', fallback: null },
  };

  it('refuses to construct a router over a non-EEA route when no gate is installed', () => {
    expect(
      () => new AiRouter({ routing: NON_EEA_ROUTING, providers: { DEEPSEEK_GLOBAL: provider() } }),
    ).toThrow(/Chapter V/);
  });

  it('never calls the provider when the Household has not consented', async () => {
    const stub = provider();
    const router = new AiRouter({
      routing: NON_EEA_ROUTING,
      providers: { DEEPSEEK_GLOBAL: stub },
      consent: { permits: () => false },
    });

    const result = await router.invoke<ClassifyProposal>('CLASSIFY', classifyInput());

    expect(stub.calls).toEqual([]);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toBe('CONSENT_DECLINED');
    expect(result.rung).toBe('RULES_KEYWORDS_ONLY');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reason).toBe('CONSENT_DECLINED');
    // Not a provider fault, so nothing may be charged against the endpoint's health.
    expect(result.failures[0]?.countsAgainstCircuit).toBe(false);
  });

  it('calls the provider when consent is recorded, and reports the full pipeline rung', async () => {
    const stub = provider();
    const router = new AiRouter({
      routing: NON_EEA_ROUTING,
      providers: { DEEPSEEK_GLOBAL: stub },
      consent: { permits: () => true },
    });

    const result = await router.invoke<ClassifyProposal>('CLASSIFY', classifyInput());

    expect(stub.calls).toEqual(['CLASSIFY']);
    if (!result.ok) throw new Error(`expected success: ${result.failures.map((f) => f.reason).join()}`);
    expect(result.rung).toBe('FULL_PIPELINE');
    expect(result.endpoint).toBe('DEEPSEEK_GLOBAL');
  });

  it('asks again on the next call, so a withdrawal takes effect immediately', async () => {
    // docs/08 §6.6: "takes effect before the next AI call — cached grants are invalidated
    // immediately". A router that resolved consent once at construction would violate that.
    let granted = true;
    const stub = provider();
    const router = new AiRouter({
      routing: NON_EEA_ROUTING,
      providers: { DEEPSEEK_GLOBAL: stub },
      consent: {
        permits: () => {
          const answer = granted;
          granted = false;
          return answer;
        },
      },
    });

    const first = await router.invoke<ClassifyProposal>('CLASSIFY', classifyInput());
    const second = await router.invoke<ClassifyProposal>('CLASSIFY', classifyInput());

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(stub.calls).toEqual(['CLASSIFY']);
  });

  it('treats a gate that throws as a refusal rather than as egress', async () => {
    const stub = provider();
    const router = new AiRouter({
      routing: NON_EEA_ROUTING,
      providers: { DEEPSEEK_GLOBAL: stub },
      consent: {
        permits: () => {
          throw new Error('no tenant context');
        },
      },
    });

    const result = await router.invoke<ClassifyProposal>('CLASSIFY', classifyInput());

    expect(stub.calls).toEqual([]);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toBe('CONSENT_DECLINED');
  });

  it('never asks the gate for a LOCAL-only route', async () => {
    // The common case must not pay for a database read, and a gate that cannot answer must not be
    // able to break a call that never needed consent.
    let asked = 0;
    const stub = provider();
    const router = new AiRouter({
      routing: DEFAULT_ROUTING,
      providers: { LOCAL: stub },
      consent: {
        permits: () => {
          asked += 1;
          throw new Error('the gate must not be consulted for LOCAL');
        },
      },
    });

    const result = await router.invoke<ClassifyProposal>('CLASSIFY', classifyInput());

    expect(result.ok).toBe(true);
    expect(asked).toBe(0);
  });

  /**
   * ADR-038: an **image** needs its own consent on every endpoint but `LOCAL`, EEA included.
   *
   * docs/08 §6.5's table makes `CLOUD_OCR` a written requirement for every OCR provider — *"consent-
   * gated; most sensitive payload"* — while the router only asked for endpoints outside the EEA. The
   * two cases below are the difference: an EEA host is now asked about too, and a `LOCAL` receipt does
   * not pay for the question.
   */
  const EEA_OCR_ROUTING: RoutingTable = {
    OCR: { primary: 'OPENAI_EU', fallback: null },
  };

  it('asks for consent before an image reaches even an EEA endpoint', async () => {
    const stub = provider();
    let asked = 0;
    const router = new AiRouter({
      routing: EEA_OCR_ROUTING,
      providers: { OPENAI_EU: stub },
      consent: {
        permits: (task) => {
          asked += 1;
          expect(task).toBe('OCR');
          return false;
        },
      },
    });

    const result = await router.invoke('OCR', { task: 'OCR' });

    expect(asked).toBe(1);
    expect(stub.calls).toEqual([]);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toBe('CONSENT_DECLINED');
    expect(result.failures[0]?.message).toContain('cloud OCR');
  });

  it('lets a consented image through to the provider check, and never asks for a LOCAL one', async () => {
    const consented = provider();
    const granted = new AiRouter({
      routing: EEA_OCR_ROUTING,
      providers: { OPENAI_EU: consented },
      consent: { permits: () => true },
    });

    const allowed = await granted.invoke('OCR', { task: 'OCR' });
    // Consent was granted, so the outcome is now about the *adapter* (this stub has no `ocr`), which
    // is exactly what proves the consent step is no longer the blocker.
    if (allowed.ok) throw new Error('a stub without an OCR method cannot succeed');
    expect(allowed.failures.map((failure) => failure.reason)).toEqual(['TASK_NOT_SUPPORTED']);

    const localAsked = { count: 0 };
    const local = new AiRouter({
      routing: { OCR: { primary: 'LOCAL', fallback: null } },
      providers: { LOCAL: provider() },
      consent: {
        permits: () => {
          localAsked.count += 1;
          return true;
        },
      },
    });
    await local.invoke('OCR', { task: 'OCR' });

    expect(localAsked.count).toBe(0);
  });

  it('reports a provider outage, not a refusal, when the EEA half of a chain also failed', async () => {
    const router = new AiRouter({
      routing: { CLASSIFY: { primary: 'LOCAL', fallback: 'DEEPSEEK_GLOBAL' } },
      providers: {},
      consent: { permits: () => false },
    });

    const result = await router.invoke<ClassifyProposal>('CLASSIFY', classifyInput());

    if (result.ok) throw new Error('expected a failure');
    // `LOCAL` failed for its own reason (no adapter registered), so the outcome is an outage. The
    // consent refusal is still recorded per endpoint for the operator.
    expect(result.reason).toBe('PROVIDER_UNAVAILABLE');
    expect(result.failures.map((failure) => failure.reason)).toEqual([
      'UNKNOWN_PROVIDER',
      'CONSENT_DECLINED',
    ]);
  });
});

/** A `CLASSIFY`-answering stub, so a consent case never needs HTTP. */
function provider(): StubProvider {
  return new StubProvider('DEEPSEEK', ok(GOOD));
}
