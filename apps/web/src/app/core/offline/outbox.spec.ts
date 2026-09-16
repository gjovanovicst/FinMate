import { describe, expect, it, vi } from 'vitest';

// `import type` only: the annotation is erased, so no Angular code is loaded into this Node-only spec
// while the compiler still links the real class to the structural shape below.
import type { GraphQLRequestError } from '../graphql/graphql.client';

import { InMemoryOfflineStore } from './offline-store';
import {
  kindOf,
  BACKOFF_CAP_MS,
  Outbox,
  isRetryable,
  nextAttemptDelay,
  type GraphQLFailure,
  type OutboxSend,
} from './outbox';

/**
 * The real error whose *shape* {@link GraphQLFailure} models. The import above is a type-only import,
 * so nothing Angular is loaded at runtime, while the assignment below still makes the compiler check
 * the two against each other: if `GraphQLRequestError` ever stops having a numeric `status` and an
 * `errors` array, this file stops type-checking instead of the classifier quietly treating every
 * failure as retryable.
 */
type RealGraphQLFailure = GraphQLRequestError;
type ShapeIsPinned = RealGraphQLFailure extends GraphQLFailure ? true : never;

const shapeIsPinned: ShapeIsPinned = true;

/**
 * The queue's contract, straight from docs/10 §8.3's offline table (the rows that belong to the
 * outbox, not to a screen): flushed in order, deduped on replay, and never silently dropped.
 *
 * The store is the in-memory backing here — an outbox test must not depend on IndexedDB's timing —
 * while the repository's own durability and encryption are asserted in `offline-store.spec.ts`.
 */
function failure(status: number, code?: string, retryable = false): GraphQLFailure {
  return {
    status,
    message: 'refused',
    errors: code === undefined ? [] : [{ message: 'refused', code, retryable }],
  };
}

function refusal(code: string): GraphQLFailure {
  // GraphQL reports failures in the body with HTTP 200, which is why the code decides, not the status.
  return failure(200, code);
}

function serverFault(): GraphQLFailure {
  return failure(500, 'INTERNAL', true);
}

function queued(): Outbox {
  return new Outbox(new InMemoryOfflineStore());
}

describe('isRetryable', () => {
  it('keeps the structural failure shape in step with the real error class', () => {
    expect(shapeIsPinned).toBe(true);
  });

  it('retries a network failure, a timeout and a 5xx', () => {
    expect(isRetryable(failure(0))).toBe(true); // offline — status 0
    expect(isRetryable(failure(503))).toBe(true);

    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    expect(isRetryable(timeout)).toBe(true);

    // How `fetch` fails when the network is unavailable.
    expect(isRetryable(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('does not retry a GraphQL validation or user-input error', () => {
    expect(isRetryable(refusal('VALIDATION_FAILED'))).toBe(false);
    expect(isRetryable(refusal('BAD_USER_INPUT'))).toBe(false);
  });

  it('retries an unauthenticated response rather than parking the entry (ADR-033)', () => {
    // A `401` is a session state the user can fix by signing in, so a queued capture must survive it —
    // parking it as *cannot be sent* would lose work for a reason that is not the row's.
    expect(isRetryable(failure(401, 'UNAUTHENTICATED'))).toBe(true);
    // The same code in a `200` body (GraphQL-over-200), which is the other shape it arrives in.
    expect(
      isRetryable({ status: 200, errors: [{ code: 'UNAUTHENTICATED', message: 'Sign in.', retryable: false }] }),
    ).toBe(true);
  });

  it('does not retry any other 4xx', () => {
    expect(isRetryable(failure(404, 'NOT_FOUND'))).toBe(false);
    expect(isRetryable(failure(409, 'CONFLICT'))).toBe(false);
    expect(isRetryable(failure(403, 'FORBIDDEN'))).toBe(false);
  });
});

describe('nextAttemptDelay', () => {
  // ADR-026 decision 3: 2 s base, doubling, 60 s cap — the policy the tray displays.
  it('starts at two seconds and doubles', () => {
    expect(nextAttemptDelay(0)).toBe(2_000);
    expect(nextAttemptDelay(1)).toBe(4_000);
    expect(nextAttemptDelay(2)).toBe(8_000);
    expect(nextAttemptDelay(4)).toBe(32_000);
  });

  it('caps at sixty seconds however many times it has failed', () => {
    expect(nextAttemptDelay(5)).toBe(BACKOFF_CAP_MS);
    expect(nextAttemptDelay(50)).toBe(BACKOFF_CAP_MS);
    expect(nextAttemptDelay(Number.POSITIVE_INFINITY)).toBe(BACKOFF_CAP_MS);
  });

  it('never returns a negative or fractional delay', () => {
    expect(nextAttemptDelay(-3)).toBe(2_000);
    expect(nextAttemptDelay(1.9)).toBe(4_000);
  });
});

describe('Outbox', () => {
  it('Outbox flush order: sends whole entries in seq order', async () => {
    const outbox = queued();
    await outbox.enqueue('mutation One', { row: '1' });
    await outbox.enqueue('mutation Two', { row: '2' });
    await outbox.enqueue('mutation Three', { row: '3' });

    const order: string[] = [];
    const send = vi.fn<OutboxSend>(async (document) => {
      order.push(document);
    });

    const result = await outbox.flush(send);

    expect(order).toEqual(['mutation One', 'mutation Two', 'mutation Three']);
    expect(result).toEqual({ sent: 3, rejected: 0, stoppedAt: null });
    expect(await outbox.pending()).toEqual([]);
  });

  it('stops at a retryable failure and leaves it and every later entry pending', async () => {
    const outbox = queued();
    await outbox.enqueue('mutation One', {});
    await outbox.enqueue('mutation Two', {});
    await outbox.enqueue('mutation Three', {});

    const send = vi
      .fn<OutboxSend>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(serverFault());

    const result = await outbox.flush(send);

    expect(result.sent).toBe(1);
    expect(result.stoppedAt?.document).toBe('mutation Two');
    expect((await outbox.pending()).map((entry) => entry.document)).toEqual([
      'mutation Two',
      'mutation Three',
    ]);
  });

  it('records the attempt and the last error on a retryable failure (ADR-026 decision 3)', async () => {
    const outbox = queued();
    await outbox.enqueue('mutation One', {});

    const down = vi.fn<OutboxSend>().mockRejectedValue(serverFault());
    await outbox.flush(down);
    await outbox.flush(down);

    const [entry] = await outbox.pending();
    expect(entry?.status).toBe('pending');
    expect(entry?.attempts).toBe(2);
    // The tray renders this as "2 attempts, last: ..." — the server's own message, not a code.
    expect(entry?.error).toBe('refused');

    // A success still deletes the entry, attempts and all.
    await outbox.flush(vi.fn<OutboxSend>().mockResolvedValue(undefined));
    expect(await outbox.pending()).toEqual([]);
  });

  it('does not re-enter: a second concurrent flush joins the one in flight', async () => {
    const outbox = queued();
    await outbox.enqueue('mutation One', {});
    await outbox.enqueue('mutation Two', {});

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn<OutboxSend>(async () => {
      await gate;
    });

    const first = outbox.flush(send);
    const second = outbox.flush(send);
    release();
    await Promise.all([first, second]);

    // Without the guard each call would drain the queue and send twice per entry.
    expect(send).toHaveBeenCalledTimes(2);
    expect(await outbox.pending()).toEqual([]);
  });

  it('stores client-only meta and never sends it', async () => {
    const outbox = queued();
    const entry = await outbox.enqueue(
      'mutation One',
      { row: '1' },
      { preview: [{ clientRowId: 'r1' }] },
    );

    expect(entry.attempts).toBe(0);
    expect(entry.meta).toEqual({ preview: [{ clientRowId: 'r1' }] });

    const send = vi.fn<OutboxSend>(async () => {});
    await outbox.flush(send);
    // Exactly the two transport arguments: the preview stays client-side (ADR-026 decision 2).
    expect(send).toHaveBeenCalledWith('mutation One', { row: '1' });
  });

  it('marks a refusal rejected and carries on with the rest', async () => {
    const outbox = queued();
    await outbox.enqueue('mutation One', {});
    await outbox.enqueue('mutation Two', {});
    await outbox.enqueue('mutation Three', {});

    const send = vi
      .fn<OutboxSend>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(refusal('VALIDATION_FAILED'))
      .mockResolvedValueOnce(undefined);

    const result = await outbox.flush(send);

    expect(send).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ sent: 2, rejected: 1, stoppedAt: null });
    expect(await outbox.pending()).toEqual([]);

    const rejected = await outbox.rejected();
    expect(rejected.map((entry) => entry.document)).toEqual(['mutation Two']);
    expect(rejected[0]?.error).toBe('refused');
  });

  it('retry(seq) returns a refused entry to pending', async () => {
    const outbox = queued();
    await outbox.enqueue('mutation One', {});
    await outbox.flush(vi.fn<OutboxSend>().mockRejectedValue(refusal('BAD_USER_INPUT')));

    const refused = (await outbox.rejected())[0];
    expect(refused).toBeDefined();
    if (!refused) throw new Error('expected a refused entry');
    await outbox.retry(refused.seq);

    expect(await outbox.rejected()).toEqual([]);
    const pending = await outbox.pending();
    expect(pending.map((entry) => entry.document)).toEqual(['mutation One']);
    expect(pending[0]?.error).toBeUndefined();
  });

  it('discard(seq) drops an entry without sending it', async () => {
    const outbox = queued();
    const entry = await outbox.enqueue('mutation One', {});

    await outbox.discard(entry.seq);

    expect(await outbox.pending()).toEqual([]);
  });

  it('keeps insertion order for two enqueues in the same millisecond', async () => {
    const outbox = queued();

    const [first, second] = await Promise.all([
      outbox.enqueue('mutation A', {}),
      outbox.enqueue('mutation B', {}),
    ]);

    expect(first.seq).toBeLessThan(second.seq);
    expect((await outbox.pending()).map((entry) => entry.document)).toEqual([
      'mutation A',
      'mutation B',
    ]);
  });

  it('Dedupe on replay: a replayed entry sends identical variables', async () => {
    const outbox = queued();
    const variables = {
      rows: [
        { clientRowId: 'row-1', idempotencyKey: 'idem-1', amountMinor: '200000', kind: 'EXPENSE' },
      ],
    };
    const send = vi.fn<OutboxSend>().mockResolvedValue(undefined);

    await outbox.enqueue('mutation captureCommit', variables);
    await outbox.flush(send);

    // The response was lost, so the same capture is queued again with its original keys — which is
    // exactly what a retry after a reload does.
    await outbox.enqueue('mutation captureCommit', variables);
    await outbox.flush(send);

    expect(send).toHaveBeenCalledTimes(2);
    const firstCall = send.mock.calls[0];
    const secondCall = send.mock.calls[1];
    expect(secondCall).toEqual(firstCall);
    if (!secondCall) throw new Error('expected a second send');

    const replayed = secondCall[1];
    const rows = replayed['rows'] as readonly { clientRowId: string; idempotencyKey: string }[];
    expect(rows[0]?.clientRowId).toBe('row-1');
    expect(rows[0]?.idempotencyKey).toBe('idem-1');
    // The server collapses the replay on (household, idempotencyKey) — I-10, `replayed: true` — which
    // is what makes a second identical send safe instead of a duplicate.
  });

  it('passes minor units through as strings and never does arithmetic on them', async () => {
    const outbox = queued();
    const beyondSafeInteger = '123456789012345678901234567890';
    await outbox.enqueue('mutation captureCommit', {
      amount: { amountMinor: beyondSafeInteger, currency: 'RSD' },
    });

    const send = vi.fn<OutboxSend>().mockResolvedValue(undefined);
    await outbox.flush(send);

    const call = send.mock.calls[0];
    if (!call) throw new Error('expected the send to have been called');

    const variables = call[1];
    const amount = variables['amount'] as { amountMinor: string };
    expect(typeof amount.amountMinor).toBe('string');
    expect(amount.amountMinor).toBe(beyondSafeInteger);
  });

  it('remembers what an entry IS, and reads an older one as a capture', async () => {
    const outbox = queued();
    // Task 4.2.7 queues edits as well as captures (ADR-030), so the flush needs to know which.
    const edit = await outbox.enqueue('mutation UpdateTransaction', { input: { id: 't' } }, {}, 'edit');
    const capture = await outbox.enqueue('mutation CaptureCommit', { input: {} });

    expect(kindOf(edit)).toBe('edit');
    expect(kindOf(capture)).toBe('capture');
    // An entry written before the field existed is a capture, because that is all 4.2.3 could queue.
    expect(kindOf({})).toBe('capture');
    expect((await outbox.pending()).map(kindOf)).toEqual(['edit', 'capture']);
  });
});
