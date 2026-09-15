/**
 * Shared test doubles for the offline suite.
 *
 * Every spec in this package injects one of these instead of touching the network. That is not only
 * hygiene: every API key in `.env` is empty and CI has none, so a spec that made a real request
 * would fail for a reason unrelated to the code under test. A stub `fetch` also lets a spec inspect
 * the **exact request body** — which is how the redaction, temperature-0 and structured-output
 * contracts are asserted rather than assumed.
 *
 * @module @finmate/ai
 */

import type { FetchLike } from '../transport';

/** The two members of `Response` the transport actually reads. */
interface StubResponseLike {
  readonly status: number;
  text(): Promise<string>;
}

export interface RecordedRequest {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: Record<string, unknown>;
}

export interface StubFetch {
  readonly fetch: FetchLike;
  readonly requests: readonly RecordedRequest[];
  /** The last recorded request, for the common single-call assertion. */
  readonly lastRequest: RecordedRequest;
  readonly callCount: number;
}

export interface StubResponseInit {
  readonly status?: number;
  /** Sent as the raw body. A string is used verbatim; anything else is JSON-serialised. */
  readonly body?: unknown;
}

/** Parse a JSON request body back into the shape a spec asserts against. */
export function jsonBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

/** A well-formed chat-completions body whose assistant message is `content`, JSON-encoded. */
export function chatCompletion(
  content: unknown,
  options: { model?: string; promptTokens?: number; completionTokens?: number } = {},
): string {
  return JSON.stringify({
    model: options.model ?? 'test-model',
    choices: [{ message: { role: 'assistant', content: JSON.stringify(content) } }],
    usage: {
      prompt_tokens: options.promptTokens ?? 100,
      completion_tokens: options.completionTokens ?? 50,
    },
  });
}

/** A well-formed embeddings body. */
export function embeddingResponse(vectors: readonly number[][]): string {
  return JSON.stringify({
    model: 'embed-model',
    data: vectors.map((embedding) => ({ embedding })),
    usage: { prompt_tokens: 10, completion_tokens: 0 },
  });
}

/** A fetch stub. `responses` are consumed in order; the last one repeats. */
export function stubFetch(responses: readonly StubResponseInit[]): StubFetch {
  const requests: RecordedRequest[] = [];
  let index = 0;

  const fetchImpl: FetchLike = async (url, init) => {
    requests.push({ url, init, body: jsonBody(init) });
    const chosen = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;
    const status = chosen.status ?? 200;
    const text =
      typeof chosen.body === 'string'
        ? chosen.body
        : chosen.body === undefined
          ? ''
          : JSON.stringify(chosen.body);

    const response: StubResponseLike = { status, text: async () => text };
    return response as Response;
  };

  return {
    fetch: fetchImpl,
    requests,
    get lastRequest() {
      const last = requests[requests.length - 1];
      if (last === undefined) throw new Error('no request was recorded');
      return last;
    },
    get callCount() {
      return requests.length;
    },
  };
}

/** A fetch stub that never settles until the abort signal fires — for the timeout-budget spec. */
export function hangingFetch(): { readonly fetch: FetchLike; readonly callCount: () => number } {
  let calls = 0;
  const fetchImpl: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      calls += 1;
      init.signal?.addEventListener('abort', () => {
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        reject(error);
      });
    });
  return { fetch: fetchImpl, callCount: () => calls };
}

/** A fetch stub that rejects immediately, as a refused connection does. */
export function refusingFetch(message = 'fetch failed'): {
  readonly fetch: FetchLike;
  readonly callCount: () => number;
} {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    throw new TypeError(message);
  };
  return { fetch: fetchImpl, callCount: () => calls };
}

/** A counter clock, so a cooldown is tested by moving time rather than by sleeping. */
export function counterClock(start = 1_000_000): {
  readonly now: () => number;
  readonly advance: (ms: number) => void;
} {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}
