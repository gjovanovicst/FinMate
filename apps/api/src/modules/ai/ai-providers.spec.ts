import { Logger } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';

import type { ClassifyInput, ClassifyProposal, FetchLike } from '@finmate/ai';

import { loadConfig } from '../../config/config';
import { UNCONFIGURED_AI_CLASSIFIER } from '../classification/ai-classifier';
import { UNCONFIGURED_EMBEDDINGS } from '../classification/embedding-provider';
import { UNCONFIGURED_NARRATOR } from '../assistant/assistant-narrator';
import { UNCONFIGURED_ROUTER } from '../assistant/assistant-router';
import { UNCONFIGURED_OCR } from '../receipts/ocr';
import { toAiEgressModels } from './ai-egress.model';
import { assembleAi, makeAiSeams } from './ai-providers';

/**
 * The AI composition root — ADR-031 decision 6.
 *
 * The two properties worth a spec are not "the wiring runs":
 *
 * 1. **Inert means inert.** A deployment with no usable endpoint constructs no router, registers no
 *    adapter and keeps every `UNCONFIGURED_*` seam, so nothing changes for the pipeline and no socket
 *    is opened on the capture path. That is the shipped `.env.example`, and it must be asserted
 *    rather than assumed — "no provider configured" and "a provider configured at a dead address"
 *    look identical from the outside and are not.
 * 2. **A configured non-EEA endpoint with a live key still sends nothing without consent.** The key
 *    exists (`.env`), so the failure mode this spec exists to exclude is real: a root that registers
 *    an adapter and lets the router call it would put Household free text on a Chapter V transfer with
 *    no consent record anywhere.
 *
 * Everything below is offline. The one case that reaches a "provider" uses a stub `fetch`, which is
 * also how the request is inspected: the URL and the `Authorization` header are asserted, not assumed.
 */
const BASE_ENV = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'a-development-secret-long-enough-to-pass',
  NODE_ENV: 'development',
} as const;

beforeAll(() => {
  // `makeAiSeams` logs its route table, which is the point of it in production and noise here.
  Logger.overrideLogger(false);
});

interface Stub {
  readonly fetch: FetchLike;
  readonly urls: string[];
  readonly authorizations: (string | null)[];
}

/** A recording `fetch` that answers like DeepSeek's chat-completions endpoint. */
function stubFetch(): Stub {
  const urls: string[] = [];
  const authorizations: (string | null)[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    urls.push(String(url));
    const headers = (init.headers ?? {}) as Record<string, string>;
    authorizations.push(headers['Authorization'] ?? headers['authorization'] ?? null);
    const body = JSON.stringify({
      model: 'deepseek-chat',
      choices: [
        {
          message: {
            role: 'assistant',
            content: JSON.stringify({
              categoryId: null,
              confidence: 0.42,
              rationale: 'stub',
              alternatives: [],
              extracted: {},
            }),
          },
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 6 },
    });
    return Promise.resolve({
      status: 200,
      text: () => Promise.resolve(body),
    } as unknown as Response);
  };
  return { fetch: fetchImpl, urls, authorizations };
}

function classifyInput(): ClassifyInput {
  return {
    task: 'CLASSIFY',
    templateId: 'classify.serbian-household',
    version: '1',
    baseUrl: '',
    system: 's',
    user: 'u',
    locale: 'sr-Latn-RS',
    fragment: { text: 'Lidl 2000', amountMinor: '200000', currency: 'RSD', occurredOn: null },
    categories: [{ id: '0190f2c1-1111-7000-8000-000000000001', path: 'Hrana' }],
  };
}

describe('assembleAi — inert when nothing is configured', () => {
  it('routes nothing when every primary is LOCAL and no local model is claimed', () => {
    // This is the shipped `.env.example`, and the state of every deployment that has no model.
    const config = loadConfig({ ...BASE_ENV });
    const assembly = assembleAi(config, stubFetch().fetch);

    expect(assembly.routedTasks).toEqual([]);
    expect(assembly.routing).toEqual({});
    expect(assembly.providers).toEqual({});
    // Every skip has a reason an operator can act on, not a bare "disabled". `ROUTE` is here from the
    // start (ADR-036) — its `LOCAL` default is what keeps the rung dark rather than merely off.
    expect(assembly.skipped.map((skip) => skip.task)).toEqual([
      'PARSE',
      'CLASSIFY',
      'NARRATE',
      'OCR',
      'ROUTE',
    ]);
    expect(assembly.skipped[0]?.reason).toContain('LOCAL_AI_BASE_URL');
  });

  it('keeps every seam honest and builds no router', () => {
    const seams = makeAiSeams(loadConfig({ ...BASE_ENV }), stubFetch().fetch, {
      permits: () => true,
    });

    expect(seams.router).toBeNull();
    expect(seams.classifier).toBe(UNCONFIGURED_AI_CLASSIFIER);
    expect(seams.narrator).toBe(UNCONFIGURED_NARRATOR);
    expect(seams.ocr).toBe(UNCONFIGURED_OCR);
    // ADR-036's rung is present as a seam and inert, so a caller can inject it unconditionally.
    expect(seams.questionRouter).toBe(UNCONFIGURED_ROUTER);
    // Nothing is routed, so there is nothing a caller could reach and nothing to disclose.
    expect(seams.calledTasks).toEqual([]);
    // Rung 5 needs a model and a width, not a host (ADR-021); it stays inert even with a local host.
    expect(seams.embeddings).toBe(UNCONFIGURED_EMBEDDINGS);
  });
});

describe('assembleAi — a usable endpoint produces the real seams', () => {
  it('routes LOCAL once a local model is claimed, and constructs one adapter', () => {
    const config = loadConfig({ ...BASE_ENV, LOCAL_AI_BASE_URL: 'http://localhost:11434' });
    const seams = makeAiSeams(config, stubFetch().fetch, { permits: () => true });

    expect(seams.assembly.routedTasks).toEqual(['PARSE', 'CLASSIFY', 'NARRATE', 'OCR', 'ROUTE']);
    expect(Object.keys(seams.assembly.providers)).toEqual(['LOCAL']);
    expect(seams.router).not.toBeNull();
    expect(seams.classifier).not.toBe(UNCONFIGURED_AI_CLASSIFIER);
    expect(seams.narrator).not.toBe(UNCONFIGURED_NARRATOR);
    expect(seams.ocr).not.toBe(UNCONFIGURED_OCR);
    // A routed `ROUTE` builds the real seam — its caller arrives in C-2, and the seam exists first so
    // that integration is an injection rather than a feature.
    expect(seams.questionRouter).not.toBe(UNCONFIGURED_ROUTER);
    expect(seams.questionRouter.available).toBe(true);
    // `PARSE` is routed and no seam invokes it: a typed fragment is parsed by `packages/nlp`, on this
    // node. The four that follow are the tasks with a caller (docs/08 §6.6's disclosure) — `ROUTE`
    // joined them in C-2, when both planners began injecting the seam, and it is listed here because
    // *that* is the moment it became egress a person can consent to.
    expect(seams.calledTasks).toEqual(['CLASSIFY', 'NARRATE', 'OCR', 'ROUTE']);
  });

  it('routes a task nothing calls, and keeps it out of the consent disclosure', () => {
    // The measured defect (`4.3.7`): `AI_PARSE_PRIMARY` was validated, routed and disclosed, so a
    // deployment could ask a Household to consent to a non-EEA transfer for a task no code performs.
    // With PARSE pointed at a non-EEA endpoint and the called task staying local, the disclosure must
    // contain no consent-requiring row at all — and therefore no sheet is owed.
    const config = loadConfig({
      ...BASE_ENV,
      AI_PARSE_PRIMARY: 'DEEPSEEK_GLOBAL',
      AI_CLASSIFY_PRIMARY: 'LOCAL',
      DEEPSEEK_API_KEY: 'sk-test-not-a-real-key',
      LOCAL_AI_BASE_URL: 'http://localhost:11434',
    });
    const seams = makeAiSeams(config, stubFetch().fetch, { permits: () => true });

    expect(seams.assembly.routedTasks).toEqual(['PARSE', 'CLASSIFY', 'NARRATE', 'OCR', 'ROUTE']);
    // `ROUTE` rides the local host here, so it is disclosed and needs no consent.
    expect(seams.calledTasks).toEqual(['CLASSIFY', 'NARRATE', 'OCR', 'ROUTE']);

    // Every routed task but `PARSE` rides the local host, so the only non-EEA row the routing table
    // could produce is the one nothing calls — and the disclosure has none.
    const rows = toAiEgressModels(seams.assembly, seams.calledTasks);
    expect(rows.map((row) => row.task)).toEqual(['CLASSIFY', 'NARRATE', 'OCR', 'ROUTE']);
    expect(rows.some((row) => row.requiresConsent)).toBe(false);
  });

  it('routes DEEPSEEK_GLOBAL once a key exists, and names the endpoint truthfully', () => {
    const config = loadConfig({
      ...BASE_ENV,
      AI_CLASSIFY_PRIMARY: 'DEEPSEEK_GLOBAL',
      DEEPSEEK_API_KEY: 'sk-test-not-a-real-key',
    });
    const assembly = assembleAi(config, stubFetch().fetch);

    expect(assembly.routedTasks).toEqual(['CLASSIFY']);
    expect(assembly.routing['CLASSIFY']).toEqual({ primary: 'DEEPSEEK_GLOBAL', fallback: null });
    expect(Object.keys(assembly.providers)).toEqual(['DEEPSEEK_GLOBAL']);
  });

  it('refuses to route DEEPSEEK_GLOBAL with no key, and says so', () => {
    const config = loadConfig({ ...BASE_ENV, AI_CLASSIFY_PRIMARY: 'DEEPSEEK_GLOBAL' });
    const assembly = assembleAi(config, stubFetch().fetch);

    expect(assembly.routedTasks).toEqual([]);
    const skip = assembly.skipped.find((entry) => entry.task === 'CLASSIFY');
    expect(skip?.reason).toContain('DEEPSEEK_API_KEY');
  });

  it('refuses an endpoint that has no adapter, even when its EEA host is configured', () => {
    // `ANTHROPIC_EU` passes the boot guard (it names a host) and still has no wire implementation, so
    // routing it would be a configuration that looks live and can only fail at the first question.
    const config = loadConfig({
      ...BASE_ENV,
      AI_NARRATE_PRIMARY: 'ANTHROPIC_EU',
      ANTHROPIC_EU_BASE_URL: 'https://anthropic.eu.example.invalid',
    });
    const assembly = assembleAi(config, stubFetch().fetch);

    expect(assembly.routedTasks).toEqual([]);
    expect(assembly.skipped.find((entry) => entry.task === 'NARRATE')?.reason).toContain(
      'no adapter exists',
    );
  });
});

describe('the composition root reaches a socket only with consent', () => {
  const configured = (): ReturnType<typeof loadConfig> =>
    loadConfig({
      ...BASE_ENV,
      AI_CLASSIFY_PRIMARY: 'DEEPSEEK_GLOBAL',
      DEEPSEEK_API_KEY: 'sk-test-not-a-real-key',
    });

  it('sends nothing, and reports why, when the Household has not consented', async () => {
    const stub = stubFetch();
    const seams = makeAiSeams(configured(), stub.fetch, { permits: () => false });

    const result = await seams.router?.invoke<ClassifyProposal>('CLASSIFY', classifyInput());

    expect(stub.urls).toEqual([]);
    expect(result?.ok).toBe(false);
    if (result === undefined || result.ok) throw new Error('expected a refusal');
    expect(result.reason).toBe('CONSENT_DECLINED');
  });

  it('calls DeepSeek with the configured key when consent is recorded', async () => {
    const stub = stubFetch();
    const seams = makeAiSeams(configured(), stub.fetch, { permits: () => true });

    const result = await seams.router?.invoke<ClassifyProposal>('CLASSIFY', classifyInput());

    expect(stub.urls).toEqual(['https://api.deepseek.com/chat/completions']);
    expect(stub.authorizations[0]).toBe('Bearer sk-test-not-a-real-key');
    expect(result?.ok).toBe(true);
    if (result === undefined || !result.ok) throw new Error('expected a call');
    // Cost telemetry travels out of the router so the caller can write `classification_decisions`.
    expect(result.telemetry.model).toBe('deepseek-chat');
  });
});

/**
 * OCR is the one task whose *adapter capability* is a configuration, and ADR-037 is why.
 *
 * A factory serves a task by listing a model for it, so before this task **no deployment could read a
 * receipt**: `LOCAL` had a vision model but no runtime was wired, and a cloud endpoint had never been
 * given one. Measured live on three real camera captures — `extractReceipt` answered
 * `AI_UNAVAILABLE:no-provider-configured`, and `aiEgress` listed neither the task nor a destination.
 *
 * The properties below are the ones that make the fix honest rather than merely present: a cloud
 * endpoint needs a model *named by an operator* (no default that picks a vendor — ADR-031's rule, one
 * layer down), a text-only endpoint never gets one (DeepSeek's platform serves no vision model, so
 * configuring it must be a logged skip rather than a first-receipt failure), and the model that ships
 * is the model that was configured.
 */
describe('OCR is served only by a model somebody named (ADR-037)', () => {
  interface OcrStub extends Stub {
    readonly bodies: string[];
  }

  /** A recording `fetch` that answers like a vision model and keeps the request body. */
  function ocrStub(): OcrStub {
    const stub = stubFetch();
    const bodies: string[] = [];
    const fetchImpl: FetchLike = (url, init) => {
      bodies.push(String(init.body ?? ''));
      return stub.fetch(url, init);
    };
    return { ...stub, fetch: fetchImpl, bodies };
  }

  /** The classify-shaped stub body is not an OCR answer; this is. */
  function ocrBody(): string {
    return JSON.stringify({
      model: 'stub-vision',
      choices: [
        {
          message: {
            role: 'assistant',
            content: JSON.stringify({
              lines: [{ text: 'Mleko 179,00', amountMinor: '17900' }],
              totalMinor: '17900',
              currency: 'RSD',
              occurredOn: '2026-09-18',
              merchantName: 'Maxi',
              confidence: 0.91,
            }),
          },
        },
      ],
      usage: { prompt_tokens: 900, completion_tokens: 40 },
    });
  }

  /** A stub whose *response* is an OCR result, still recording what was sent. */
  function ocrAnsweringStub(): OcrStub {
    const bodies: string[] = [];
    const urls: string[] = [];
    const fetchImpl: FetchLike = (url, init) => {
      urls.push(String(url));
      bodies.push(String(init.body ?? ''));
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve(ocrBody()),
      } as unknown as Response);
    };
    return { fetch: fetchImpl, urls, authorizations: [], bodies };
  }

  const CLOUD = {
    OPENAI_EU_BASE_URL: 'https://vision.eu.example.invalid/v1',
    OPENAI_API_KEY: 'sk-test-not-a-real-key',
  } as const;

  it('is unrouted on a cloud endpoint until an operator names a model', () => {
    const assembly = assembleAi(
      loadConfig({ ...BASE_ENV, ...CLOUD, AI_OCR_PRIMARY: 'OPENAI_EU' }),
      ocrStub().fetch,
    );

    expect(assembly.routedTasks).not.toContain('OCR');
    // The reason has to say what to do, because there is something to do.
    expect(assembly.skipped.find((entry) => entry.task === 'OCR')?.reason).toContain('AI_OCR_MODEL');
  });

  it('routes to OPENAI_EU once a model is named, and sends that model with the image', async () => {
    const stub = ocrAnsweringStub();
    const config = loadConfig({
      ...BASE_ENV,
      ...CLOUD,
      AI_OCR_PRIMARY: 'OPENAI_EU',
      AI_OCR_MODEL: 'gpt-4o-mini',
    });
    const seams = makeAiSeams(config, stub.fetch, { permits: () => true });

    expect(seams.assembly.routing['OCR']).toEqual({ primary: 'OPENAI_EU', fallback: null });
    expect(seams.ocr).not.toBe(UNCONFIGURED_OCR);
    expect(seams.ocr.available).toBe(true);
    // OCR is a caller now, so it is disclosed — the consent sheet can ask about the image.
    expect(seams.calledTasks).toContain('OCR');

    const outcome = await seams.ocr.read({
      imageBase64: 'aGVsbG8=',
      mimeType: 'image/jpeg',
      locale: 'sr-Latn',
    });

    expect(outcome.ok).toBe(true);
    const sent = JSON.parse(stub.bodies[0] ?? '{}') as { model?: string; messages?: unknown };
    expect(sent.model).toBe('gpt-4o-mini');
    // The image travels inline as a data URL: no third-party fetch, and nothing to leak by URL.
    expect(JSON.stringify(sent.messages)).toContain('data:image/jpeg;base64,aGVsbG8=');
  });

  it('never routes OCR to a text-only endpoint, even with a key and a model named', () => {
    // DeepSeek's platform serves no vision model. Naming one must be a logged skip, not a route that
    // fails on the first receipt — the shape docs/04 §9 warns about.
    const assembly = assembleAi(
      loadConfig({
        ...BASE_ENV,
        AI_OCR_PRIMARY: 'DEEPSEEK_GLOBAL',
        AI_OCR_MODEL: 'deepseek-vl',
        // …and the endpoint's own task is routed, so the skip below is about OCR and not about the host.
        AI_CLASSIFY_PRIMARY: 'DEEPSEEK_GLOBAL',
        DEEPSEEK_API_KEY: 'sk-test-not-a-real-key',
      }),
      ocrStub().fetch,
    );

    expect(assembly.routedTasks).not.toContain('OCR');
    expect(assembly.skipped.find((entry) => entry.task === 'OCR')?.reason).toContain('vision');
    // …and the task it *can* serve still routes, so the skip is about the task and not the endpoint.
    expect(assembly.routedTasks).toContain('CLASSIFY');
  });

  it('runs on LOCAL with no model key, and lets AI_OCR_MODEL replace the compiled-in one', async () => {
    // The sidecar's vision model is part of the local deployment (docs/11 §2), so a local receipt works
    // with no key at all; the key exists to *replace* it, which is the case asserted here.
    const plain = assembleAi(
      loadConfig({ ...BASE_ENV, LOCAL_AI_BASE_URL: 'http://localhost:11434' }),
      ocrStub().fetch,
    );
    expect(plain.routedTasks).toContain('OCR');

    const stub = ocrAnsweringStub();
    const seams = makeAiSeams(
      loadConfig({
        ...BASE_ENV,
        LOCAL_AI_BASE_URL: 'http://localhost:11434',
        AI_OCR_MODEL: 'qwen2.5vl:7b',
      }),
      stub.fetch,
      { permits: () => true },
    );

    await seams.ocr.read({ imageBase64: 'aGVsbG8=', mimeType: 'image/jpeg', locale: 'sr-Latn' });
    const sent = JSON.parse(stub.bodies[0] ?? '{}') as { model?: string };
    expect(sent.model).toBe('qwen2.5vl:7b');
  });
});
