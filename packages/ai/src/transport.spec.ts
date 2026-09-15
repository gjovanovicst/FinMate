/**
 * Transport: the timeout budget, the single retry, and the transient/permanent line.
 *
 * docs/04 §9 — "Timeouts (2 s parse/classify, 8 s narrate, 20 s OCR) with one retry on transient
 * failure only."
 *
 * Both sides of the line are asserted, because the expensive mistake is asymmetric: *not* retrying a
 * 429 degrades a user for no reason, and *retrying* a 401 is how a process gets rate-limited for
 * nothing (and can look like a credential-stuffing attempt to a provider).
 *
 * @module @finmate/ai
 */

import { describe, expect, it } from 'vitest';

import { AiRequestError, AiTransientError } from './errors';
import {
  HttpTransport,
  errorCodeForStatus,
  isNonRetryableStatus,
  isSuccess,
  isTransientStatus,
} from './transport';
import { hangingFetch, refusingFetch, stubFetch } from './testing/stubs';

const REQUEST = {
  url: 'https://example.invalid/chat/completions',
  method: 'POST' as const,
  headers: { 'content-type': 'application/json' },
  body: { model: 'm' },
};

function identity(response: { json: unknown }): unknown {
  return response.json;
}

describe('isTransientStatus — the whole of the line', () => {
  it('is transient for 429, 408, 425 and every 5xx', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504, 599]) {
      expect(isTransientStatus(status)).toBe(true);
    }
  });

  it('is NOT transient for 400, 401, 403 or 422', () => {
    for (const status of [400, 401, 403, 422]) {
      expect(isTransientStatus(status)).toBe(false);
      expect(isNonRetryableStatus(status)).toBe(true);
    }
  });

  it('is not transient for any other 4xx, or for a 3xx that fetch did not follow', () => {
    for (const status of [301, 302, 404, 405, 409, 418, 451]) {
      expect(isTransientStatus(status)).toBe(false);
      expect(isNonRetryableStatus(status)).toBe(true);
    }
  });

  it('treats 2xx as success on neither failure list', () => {
    for (const status of [200, 201, 204, 299]) {
      expect(isSuccess(status)).toBe(true);
      expect(isTransientStatus(status)).toBe(false);
      expect(isNonRetryableStatus(status)).toBe(false);
    }
  });

  it('maps each status to the error code the caller branches on', () => {
    expect(errorCodeForStatus(429)).toBe('TRANSIENT_HTTP');
    expect(errorCodeForStatus(503)).toBe('TRANSIENT_HTTP');
    expect(errorCodeForStatus(401)).toBe('NON_RETRYABLE_HTTP');
  });
});

describe('a success', () => {
  it('returns the parsed body with no retry', async () => {
    const stub = stubFetch([{ body: { ok: true } }]);
    const transport = new HttpTransport(stub.fetch);

    const result = await transport.post('LOCAL', 'm', { ...REQUEST, timeoutMs: 2_000 }, identity);

    expect(result.value).toEqual({ ok: true });
    expect(result.attempt.retryCount).toBe(0);
    expect(stub.callCount).toBe(1);
    expect(stub.lastRequest.url).toBe(REQUEST.url);
  });

  it('parses a non-JSON body as null rather than throwing in the transport', async () => {
    const stub = stubFetch([{ body: 'not json at all' }]);
    const transport = new HttpTransport(stub.fetch);
    const result = await transport.post('LOCAL', 'm', { ...REQUEST, timeoutMs: 2_000 }, identity);
    expect(result.value).toBeNull();
  });
});

describe('a transient failure retries exactly once', () => {
  it('retries a 429 and succeeds on the second attempt', async () => {
    const stub = stubFetch([{ status: 429, body: { error: 'slow down' } }, { body: { ok: true } }]);
    const transport = new HttpTransport(stub.fetch);

    const result = await transport.post('LOCAL', 'm', { ...REQUEST, timeoutMs: 2_000 }, identity);

    expect(result.value).toEqual({ ok: true });
    expect(result.attempt.retryCount).toBe(1);
    expect(stub.callCount).toBe(2);
  });

  it('retries a 503 and succeeds on the second attempt', async () => {
    const stub = stubFetch([{ status: 503 }, { body: { ok: true } }]);
    const transport = new HttpTransport(stub.fetch);
    const result = await transport.post('LOCAL', 'm', { ...REQUEST, timeoutMs: 2_000 }, identity);
    expect(result.attempt.retryCount).toBe(1);
  });

  it('retries a refused connection and succeeds on the second attempt', async () => {
    let calls = 0;
    const transport = new HttpTransport(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return { status: 200, text: async () => JSON.stringify({ ok: true }) } as Response;
    });

    const result = await transport.post('LOCAL', 'm', { ...REQUEST, timeoutMs: 2_000 }, identity);
    expect(result.value).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('gives up after exactly one retry, not more', async () => {
    const stub = stubFetch([{ status: 500 }]);
    const transport = new HttpTransport(stub.fetch);

    await expect(
      transport.post('LOCAL', 'm', { ...REQUEST, timeoutMs: 2_000 }, identity),
    ).rejects.toBeInstanceOf(AiTransientError);
    expect(stub.callCount).toBe(2);
  });

  it('reports how many attempts were made', async () => {
    const stub = stubFetch([{ status: 500 }]);
    const transport = new HttpTransport(stub.fetch);

    try {
      await transport.post('LOCAL', 'm', { ...REQUEST, timeoutMs: 2_000 }, identity);
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AiTransientError);
      const transient = error as AiTransientError;
      expect(transient.code).toBe('TRANSIENT_HTTP');
      expect(transient.attempts).toBe(2);
      expect(transient.status).toBe(500);
    }
  });

  it('names a refused connection CONNECTION_FAILED', async () => {
    const refusing = refusingFetch();
    const transport = new HttpTransport(refusing.fetch);

    await expect(
      transport.post('LOCAL', 'm', { ...REQUEST, timeoutMs: 2_000 }, identity),
    ).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
    expect(refusing.callCount()).toBe(2);
  });
});

describe('a non-retryable failure does not retry', () => {
  for (const status of [400, 401, 403, 422]) {
    it(`does not retry HTTP ${status}`, async () => {
      const stub = stubFetch([{ status, body: { error: 'nope' } }]);
      const transport = new HttpTransport(stub.fetch);

      await expect(
        transport.post('LOCAL', 'm', { ...REQUEST, timeoutMs: 2_000 }, identity),
      ).rejects.toBeInstanceOf(AiRequestError);
      // The whole point: exactly one request left the process.
      expect(stub.callCount).toBe(1);
    });
  }

  it('carries the status and the code for a 401', async () => {
    const stub = stubFetch([{ status: 401, body: { error: { message: 'invalid api key' } } }]);
    const transport = new HttpTransport(stub.fetch);

    try {
      await transport.post('DEEPSEEK', 'm', { ...REQUEST, timeoutMs: 2_000 }, identity);
      throw new Error('expected a throw');
    } catch (error) {
      const requestError = error as AiRequestError;
      expect(requestError).toBeInstanceOf(AiRequestError);
      expect(requestError.code).toBe('NON_RETRYABLE_HTTP');
      expect(requestError.status).toBe(401);
      expect(requestError.message).toContain('401');
    }
  });

  it('does not retry a malformed 2xx body either — a schema break is not a transport failure', async () => {
    const stub = stubFetch([{ body: 'not json' }]);
    const transport = new HttpTransport(stub.fetch);

    await expect(
      transport.post('LOCAL', 'm', { ...REQUEST, timeoutMs: 2_000 }, () => {
        throw new AiRequestError('MALFORMED_RESPONSE', 'bad shape', 'LOCAL', null);
      }),
    ).rejects.toBeInstanceOf(AiRequestError);
    expect(stub.callCount).toBe(1);
  });
});

describe('the timeout budget covers the task, retry included', () => {
  it('aborts a hanging request inside the documented budget', async () => {
    const hanging = hangingFetch();
    const transport = new HttpTransport(hanging.fetch);

    const startedAt = Date.now();
    await expect(
      transport.post('LOCAL', 'm', { ...REQUEST, timeoutMs: 150 }, identity),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });

    // The attempt was aborted at ~150 ms, not at some default socket timeout.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('names an abort TIMEOUT rather than CONNECTION_FAILED', async () => {
    const hanging = hangingFetch();
    const transport = new HttpTransport(hanging.fetch);

    try {
      await transport.post('LOCAL', 'm', { ...REQUEST, timeoutMs: 60 }, identity);
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AiTransientError);
      const transient = error as AiTransientError;
      expect(transient.code).toBe('TIMEOUT');
      expect(transient.message).toContain('60 ms budget');
    }
  });

  it('does not attempt a retry once the whole budget is spent', async () => {
    // A clock that leaps 50 ms per read: the pre-attempt check sees the budget already gone.
    let current = 0;
    const hanging = hangingFetch();
    const transport = new HttpTransport(hanging.fetch, () => {
      const value = current;
      current += 50;
      return value;
    });

    await expect(
      transport.post('LOCAL', 'm', { ...REQUEST, timeoutMs: 10 }, identity),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    // Zero attempts left the process: the budget was gone before the first one could start.
    expect(hanging.callCount()).toBe(0);
  });

  it('passes an AbortSignal to fetch so a hung socket is actually cancelled', async () => {
    const stub = stubFetch([{ body: { ok: true } }]);
    const transport = new HttpTransport(stub.fetch);
    await transport.post('LOCAL', 'm', { ...REQUEST, timeoutMs: 2_000 }, identity);
    expect(stub.lastRequest.init.signal).toBeInstanceOf(AbortSignal);
  });
});

