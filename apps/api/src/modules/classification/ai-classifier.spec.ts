import { describe, expect, it } from 'vitest';

import { AiRouter, createDeepSeekProvider, type ClassifyInput, type FetchLike } from '@finmate/ai';

import { RoutedAiClassifier } from './ai-classifier';
import { promptFor } from './classify-prompt';

/**
 * The classify call, composed as it actually ships — `apps/api`'s prompt through `packages/ai`'s
 * adapter.
 *
 * ## Why this spec exists
 *
 * The first time a real provider was wired, every AI answer came back `categoryId: null` — on
 * fragments a model should have categorised easily. Nothing was wrong with the model, the router, the
 * residency rule or the validation. **The prompt contained the category list twice**: once with real
 * UUIDs, rendered by `promptFor` in this module, and once with `packages/ai`'s opaque placeholders
 * (`c1`, `c2`, …), rendered by the adapter because it is the layer that owns the id substitution. The
 * model was told "choose a category ONLY from the provided list of ids", shown two disjoint id
 * vocabularies, and answered with one of the real ids — which `resolveId` correctly refused, because
 * the map only knows placeholders.
 *
 * Every existing test passed. `packages/ai`'s adapter specs build their own `user` string, so they
 * never saw a caller-rendered list; `apps/api`'s tests asserted the prompt `promptFor` produced, and
 * never the request that shipped. Typecheck, lint and `web:build` cannot see inside a prompt. The bug
 * lived exactly in the composition, so the regression guard has to live there too.
 *
 * The three assertions below are the invariant: **one list, placeholders only, and an answer in that
 * vocabulary resolves.**
 */
const CATEGORY_A = '01a0ab93-d449-7000-813e-4aee2266a3c5';
const CATEGORY_B = '01a0ab93-d462-7000-9a3a-5792f81830e2';

/** A DeepSeek adapter over a recording `fetch`, answering with a fixed JSON body. */
function shipping(answer: string): { fetch: FetchLike; user: () => string } {
  let captured = '';
  const fetchImpl: FetchLike = (_url, init) => {
    const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
    captured = body.messages.find((message) => message.role === 'user')?.content ?? '';
    const response = JSON.stringify({
      model: 'deepseek-chat',
      choices: [{ message: { role: 'assistant', content: answer } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    return Promise.resolve({ status: 200, text: () => Promise.resolve(response) } as unknown as Response);
  };
  return { fetch: fetchImpl, user: () => captured };
}

function classifierOver(fetchImpl: FetchLike): RoutedAiClassifier {
  return new RoutedAiClassifier(
    new AiRouter({
      routing: { CLASSIFY: { primary: 'DEEPSEEK_GLOBAL', fallback: null } },
      providers: {
        DEEPSEEK_GLOBAL: createDeepSeekProvider({
          endpoint: 'DEEPSEEK_GLOBAL',
          apiKey: 'sk-test',
          fetch: fetchImpl,
        }),
      },
      consent: { permits: () => true },
    }),
  );
}

function request(): Parameters<RoutedAiClassifier['classify']>[0] {
  return {
    fragment: {
      rawText: 'Pica 1200',
      description: 'Pica 1200',
      amountMinor: 120000n,
      currency: 'RSD',
      kind: 'EXPENSE',
      occurredOn: null,
    } as never,
    keywordCandidates: [],
    categories: [
      { id: CATEGORY_A, name: 'Hrana / Supermarket' },
      { id: CATEGORY_B, name: 'Hrana / Restoran' },
    ],
    household: { currency: 'RSD', locale: 'sr-Latn-RS' } as never,
    locale: 'sr-Latn-RS',
  };
}

describe('promptFor — instructions only, never the payload', () => {
  it('renders no category id, no category list and no fragment', () => {
    const prompt = promptFor();

    // The category list, the entity names and the input are the adapter's to render: it substitutes
    // the ids, so only it can render a list the model may legally answer with.
    expect(`${prompt.system}\n${prompt.user}`).not.toMatch(/Household categories/);
    expect(`${prompt.system}\n${prompt.user}`).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(`${prompt.system}\n${prompt.user}`).not.toMatch(/\bInput:/);
    // The rule that constrains the model to the list stays: the contract is unchanged, only its
    // rendering moved.
    expect(prompt.system).toMatch(/ONLY from the provided list of ids/);
  });
});

describe('the shipped classify message', () => {
  it('carries exactly one category list, and it is the placeholder list', async () => {
    const stub = shipping(JSON.stringify({ categoryId: 'c1', confidence: 0.9, rationale: 'x', alternatives: [], extracted: {} }));

    await classifierOver(stub.fetch).classify(request());
    const user = stub.user();

    expect(user.match(/Household categories/g)).toHaveLength(1);
    expect(user).toContain('c1 | Hrana / Supermarket');
    expect(user).toContain('c2 | Hrana / Restoran');
    // A real id in the outbound message is the defect, whatever the model does with it.
    expect(user).not.toContain(CATEGORY_A);
    expect(user).not.toContain(CATEGORY_B);
    expect(user.match(/Input:/g)).toHaveLength(1);
  });

  it('resolves the placeholder the model answered with back to the real category', async () => {
    const stub = shipping(
      JSON.stringify({
        categoryId: 'c2',
        confidence: 0.91,
        rationale: 'restoran',
        alternatives: [],
        extracted: {},
      }),
    );

    const result = await classifierOver(stub.fetch).classify(request());

    if ('unavailable' in result) throw new Error(`unexpected outage: ${result.reason}`);
    expect(result.categoryId).toBe(CATEGORY_B);
    expect(result.rawConfidence).toBeCloseTo(0.91, 2);
  });

  it('still nulls a category the closed list never carried', async () => {
    // The other half of the invariant: removing the duplicate must not weaken §6.2's closed-list
    // check. A placeholder that was never issued cannot resolve.
    const stub = shipping(
      JSON.stringify({
        categoryId: 'c99',
        confidence: 0.99,
        rationale: 'invented',
        alternatives: [],
        extracted: {},
      }),
    );

    const result = await classifierOver(stub.fetch).classify(request());

    if ('unavailable' in result) throw new Error(`unexpected outage: ${result.reason}`);
    expect(result.categoryId).toBeNull();
  });

  it('sends the fragment once, redacted and delimited', async () => {
    const stub = shipping(JSON.stringify({ categoryId: 'c1', confidence: 0.9, rationale: 'x', alternatives: [], extracted: {} }));

    await classifierOver(stub.fetch).classify(request());
    const user = stub.user();

    expect(user.match(/Pica 1200/g)).toHaveLength(1);
    // docs/08 §6.9 defence 3: the one user-controlled part of the prompt is delimited as data.
    expect(user).toMatch(/<untrusted>[\s\S]*Pica 1200[\s\S]*<\/untrusted>/);
  });
});

// `ClassifyInput` is re-exported so a reader can see the wire shape the assertions above are about.
export type { ClassifyInput };
