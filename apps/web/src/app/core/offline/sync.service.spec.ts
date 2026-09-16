// @vitest-environment jsdom
// `GraphqlClient` injects `HttpClient`, which needs the browser DOCUMENT, and the service itself
// injects DOCUMENT for its flush triggers — so this spec needs a DOM, not only the JIT compiler.
import { initAngularTesting } from '@web-test/angular-testing';

import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GraphqlClient } from '../graphql/graphql.client';
import { OFFLINE_KEY_PROVIDER } from './offline-key-provider';
import { SyncService } from './sync.service';
import type { CaptureCommitInput, CapturePreviewRow } from './sync.types';

initAngularTesting();

/**
 * The sync service, mounted against a stubbed transport.
 *
 * docs/10 §8.3's four offline rows that belong here: the queue survives a failed flush and surfaces it,
 * a success clears the entry, a replay is not a duplicate, and — the row this task adds — a server-side
 * re-classification becomes a **reviewable diff** rather than a silent clobber.
 *
 * The store is the in-memory backing (`persistent: false`), which is also what the app gets until the
 * app lock ships (ADR-025 decision 3): a queue that survives a network failure but not a reload.
 */
const INPUT: CaptureCommitInput = {
  parseId: 'parse-1',
  rows: [
    {
      clientRowId: 'r1',
      idempotencyKey: 'i1',
      clientId: 'c1',
      kind: 'EXPENSE',
      amount: { amountMinor: '200000', currency: 'RSD' },
      categoryId: null,
      description: 'Lidl',
      occurredOn: '2026-09-14',
      acceptedProposalId: 'p1',
      merchantId: null,
      counterpartyId: null,
      confirmDespiteLowConfidence: false,
    },
  ],
  defaultAccountId: 'acct-1',
  occurredLocalDate: null,
  discardProposalIds: [],
  allowAi: true,
};

const PREVIEW: readonly CapturePreviewRow[] = [
  { clientRowId: 'r1', rawText: 'Lidl 2000', localCategoryId: 'cat-food', localCategoryName: 'Hrana' },
];

const ACCEPTED = {
  captureCommit: {
    __typename: 'CaptureCommitSuccessModel',
    replayed: false,
    reviewQueueCount: 0,
    committed: [
      {
        clientRowId: 'r1',
        wasReplayed: false,
        transaction: { id: 'tx-1', categoryId: 'cat-fuel', categorySource: 'KEYWORD' },
        classification: { categoryId: 'cat-fuel', decidedBy: 'KEYWORD' },
      },
    ],
    duplicateSuspects: [],
  },
};

const REFUSED = {
  captureCommit: {
    __typename: 'CaptureCommitRejectedModel',
    code: 'VALIDATION_FAILED',
    message: '1 row(s) could not be committed, so none were.',
    rejected: [
      {
        clientRowId: 'r1',
        code: 'VALIDATION_FAILED',
        message: 'Amount is required.',
        field: 'amount',
      },
    ],
  },
};

/** How a genuinely offline client fails: no HTTP status, so the outbox classifies it retryable. */
const OFFLINE = { status: 0, message: 'Failed to fetch', errors: [] };

let commitResult: unknown = ACCEPTED;

function mount(): { service: SyncService; query: ReturnType<typeof vi.fn> } {
  commitResult = ACCEPTED;
  const query = vi.fn((document: string) => {
    if (document.includes('SyncCategoryNames')) {
      return Promise.resolve({ categories: [{ id: 'cat-fuel', name: 'Gorivo' }] });
    }
    // A genuine offline failure rejects rather than answering; the outbox classifies it.
    if (commitResult === OFFLINE) return Promise.reject(OFFLINE);
    return Promise.resolve(commitResult);
  }) as ReturnType<typeof vi.fn>;

  TestBed.configureTestingModule({
    providers: [
      { provide: GraphqlClient, useValue: { query } as unknown as GraphqlClient },
      {
        provide: OFFLINE_KEY_PROVIDER,
        // The in-memory backing never asks for this key (ADR-025 decision 3).
        useValue: { persistent: false, dataKey: () => Promise.reject(new Error('not used')) },
      },
    ],
  });

  return { service: TestBed.inject(SyncService), query };
}

/** The construction flush is deliberately not awaited, so let its microtasks (and a macrotask) run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('SyncService', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('queues a failed capture and surfaces it as the chip count', async () => {
    const { service } = mount();
    await settle();

    await service.enqueueCapture(INPUT, PREVIEW);

    expect(service.pendingCount()).toBe(1);
    const [entry] = service.pending();
    expect(entry?.attempts).toBe(0);
    // The local preview rides along in meta, and is never part of what the server receives.
    expect(entry?.meta).toEqual({ preview: PREVIEW });
  });

  it('builds a before/after diff when the server classifies a queued row differently', async () => {
    const { service } = mount();
    await settle();
    await service.enqueueCapture(INPUT, PREVIEW);

    await service.flushNow();

    expect(service.pending()).toEqual([]);
    const [diff] = service.diffs();
    expect(diff?.seq).toBe(1);
    expect(diff?.rawText).toBe('Lidl 2000');
    expect(diff?.localCategoryName).toBe('Hrana');
    expect(diff?.serverCategoryId).toBe('cat-fuel');
    // Named from the categories query, because the commit response carries only an id.
    expect(diff?.serverCategoryName).toBe('Gorivo');
    expect(diff?.why).toBe('KEYWORD');
  });

  it('produces no diff when the server kept the category the preview showed', async () => {
    const { service, query } = mount();
    await settle();
    commitResult = {
      captureCommit: {
        ...ACCEPTED.captureCommit,
        committed: [
          {
            clientRowId: 'r1',
            wasReplayed: false,
            transaction: { id: 'tx-1', categoryId: 'cat-food', categorySource: 'AI' },
            classification: { categoryId: 'cat-food', decidedBy: 'AI' },
          },
        ],
      },
    };
    await service.enqueueCapture(INPUT, PREVIEW);

    await service.flushNow();

    expect(service.pending()).toEqual([]);
    expect(service.diffs()).toEqual([]);
    // No difference means no reason to name a category, so the extra query is not even made.
    expect(query.mock.calls.some((call) => String(call[0]).includes('SyncCategoryNames'))).toBe(false);
  });

  it('parks a refused batch as cannot-be-sent with the server message, and never retries it', async () => {
    const { service } = mount();
    await settle();
    commitResult = REFUSED;
    await service.enqueueCapture(INPUT, PREVIEW);

    const result = await service.flushNow();

    expect(result?.rejected).toBe(1);
    expect(service.pending()).toEqual([]);
    const [entry] = service.rejected();
    expect(entry?.status).toBe('rejected');
    expect(entry?.error).toBe('1 row(s) could not be committed, so none were.');
    // A refusal is not a retryable stop: it must not read as "the network is down".
    expect(service.lastError()).toBeNull();
  });

  it('keeps a retryable failure queued with its attempt count and last error', async () => {
    const { service, query } = mount();
    await settle();
    commitResult = OFFLINE;
    await service.enqueueCapture(INPUT, PREVIEW);

    await service.flushNow();

    const [entry] = service.pending();
    expect(entry?.status).toBe('pending');
    expect(entry?.attempts).toBe(1);
    expect(service.lastError()).toBe('Failed to fetch');
    expect(service.diffs()).toEqual([]);
    expect(query).toHaveBeenCalled();
  });

  it('retry(seq) puts a refused entry back and sends it again', async () => {
    const { service } = mount();
    await settle();
    commitResult = REFUSED;
    await service.enqueueCapture(INPUT, PREVIEW);
    await service.flushNow();
    const [refused] = service.rejected();
    if (!refused) throw new Error('expected a refused entry');

    commitResult = ACCEPTED;
    await service.retry(refused.seq);

    expect(service.rejected()).toEqual([]);
    expect(service.pending()).toEqual([]);
  });

  it('flushNow does not re-enter while one is in flight', async () => {
    const { service, query } = mount();
    await settle();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    query.mockImplementation(async (document: string) => {
      if (String(document).includes('SyncCategoryNames')) return { categories: [] };
      await gate;
      return commitResult;
    });
    await service.enqueueCapture(INPUT, PREVIEW);

    const first = service.flushNow();
    const second = service.flushNow();
    release();
    await Promise.all([first, second]);

    // One commit for one queued batch: the second trigger joined the first rather than re-sending.
    const commits = query.mock.calls.filter((call) => String(call[0]).includes('CaptureCommit'));
    expect(commits).toHaveLength(1);
  });

  it('drains on the window online event (docs/07 §6)', async () => {
    const { service } = mount();
    await settle();
    await service.enqueueCapture(INPUT, PREVIEW);

    window.dispatchEvent(new Event('online'));
    await settle();

    expect(service.pending()).toEqual([]);
  });

  it('exports the queue as plain text and discards on request', async () => {
    const { service } = mount();
    await settle();
    await service.enqueueCapture(INPUT, PREVIEW);

    const dumped = service.exportAsText();
    expect(JSON.parse(dumped)).toMatchObject({ pending: [{ seq: 1 }] });
    expect(dumped).toContain('Lidl 2000');

    const [entry] = service.pending();
    if (!entry) throw new Error('expected a queued entry');
    await service.discard(entry.seq);
    expect(service.pendingCount()).toBe(0);
  });
});
