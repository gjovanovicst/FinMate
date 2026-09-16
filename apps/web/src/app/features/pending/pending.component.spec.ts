// @vitest-environment jsdom
// FIRST import, deliberately: it loads the JIT compiler before any other Angular import (docs/15 §9).
import { initAngularTesting } from '@web-test/angular-testing';

import { computed, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OutboxEntry } from '../../core/offline/outbox';
import { SyncService } from '../../core/offline/sync.service';
import type { SyncConflict, SyncDiff } from '../../core/offline/sync.types';
import { PendingComponent } from './pending.component';

initAngularTesting();

/**
 * The tray, mounted.
 *
 * docs/10 §8.3's retry-tray and conflict-diff rows: a failed flush surfaces with a retry and is never
 * silently dropped, and a server-side re-classification renders as a before/after diff with its own
 * *Zašto* line rather than being applied quietly (ADR-026 decision 5).
 *
 * The service is stubbed so the screen's own contract is what is asserted — the queue's behaviour is
 * `sync.service.spec.ts`'s subject.
 */
function entry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    seq: 1,
    enqueuedAt: '2026-09-14T10:00:00.000Z',
    document: 'mutation CaptureCommit',
    variables: { input: { rows: [{ clientRowId: 'r1', description: 'Lidl' }] } },
    status: 'pending',
    attempts: 0,
    ...overrides,
  };
}

interface Mounted {
  readonly fixture: ReturnType<typeof TestBed.createComponent<PendingComponent>>;
  readonly retry: ReturnType<typeof vi.fn>;
  readonly discard: ReturnType<typeof vi.fn>;
  readonly retryAll: ReturnType<typeof vi.fn>;
  readonly exportAsText: ReturnType<typeof vi.fn>;
}

async function mount(args: {
  readonly pending?: readonly OutboxEntry[];
  readonly rejected?: readonly OutboxEntry[];
  readonly diffs?: readonly SyncDiff[];
  readonly conflicts?: readonly SyncConflict[];
}): Promise<Mounted> {
  const pending = signal<readonly OutboxEntry[]>(args.pending ?? []);
  const rejected = signal<readonly OutboxEntry[]>(args.rejected ?? []);
  const diffs = signal<readonly SyncDiff[]>(args.diffs ?? []);
  const retry = vi.fn().mockResolvedValue(undefined);
  const discard = vi.fn().mockResolvedValue(undefined);
  const retryAll = vi.fn().mockResolvedValue(undefined);
  const exportAsText = vi.fn().mockReturnValue('{"pending":[]}');

  const conflicts = signal<readonly SyncConflict[]>(args.conflicts ?? []);

  const stub = {
    pending,
    rejected,
    diffs,
    conflicts,
    pendingCount: computed(() => pending().length),
    busy: signal(false),
    lastError: signal<string | null>(null),
    refresh: vi.fn().mockResolvedValue(undefined),
    retry,
    discard,
    retryAll,
    exportAsText,
  };

  TestBed.configureTestingModule({
    imports: [PendingComponent],
    providers: [
      provideZonelessChangeDetection(),
      { provide: SyncService, useValue: stub as unknown as SyncService },
    ],
  });

  const fixture = TestBed.createComponent(PendingComponent);
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, retry, discard, retryAll, exportAsText };
}

function text(fixture: Mounted['fixture']): string {
  return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

function button(fixture: Mounted['fixture'], label: string): HTMLButtonElement {
  const found = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).find(
    (candidate) => (candidate.textContent ?? '').includes(label),
  );
  if (!found) throw new Error(`no button labelled ${label}`);
  return found;
}

describe('PendingComponent (mounted)', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('shows the empty state, and says the count is zero out loud', async () => {
    const mounted = await mount({});
    expect(text(mounted.fixture)).toContain('Nothing is waiting to be sent');
    expect(text(mounted.fixture)).toContain('0 waiting to send, 0 refused');
    // The tray is a status region: a count that changes under the user is announced (docs/02 §2.3).
    expect((mounted.fixture.nativeElement as HTMLElement).querySelector('[role="status"]')).not.toBeNull();
  });

  it('renders a queued entry with its raw input, attempt count and last error', async () => {
    const mounted = await mount({
      pending: [
        entry({
          attempts: 2,
          error: 'Failed to fetch',
          meta: {
            preview: [
              {
                clientRowId: 'r1',
                rawText: 'Lidl 2000',
                localCategoryId: 'cat-food',
                localCategoryName: 'Hrana',
              },
            ],
          },
        }),
      ],
    });
    const rendered = text(mounted.fixture);

    expect(rendered).toContain('Lidl 2000');
    expect(rendered).toContain('2 attempts');
    expect(rendered).toContain('Failed to fetch');
    expect(rendered).toContain('1 waiting to send, 0 refused');
    // The backoff the policy intends before the next attempt (ADR-026 decision 3): two failures is a
    // four-second base doubled twice.
    expect(rendered).toContain('8 s');
    expect(button(mounted.fixture, 'Try again')).toBeDefined();
    expect(button(mounted.fixture, 'Discard')).toBeDefined();
  });

  it('renders a refused entry as cannot-be-sent and keeps the server message', async () => {
    const mounted = await mount({
      rejected: [entry({ status: 'rejected', error: 'Category not found.' })],
    });
    const rendered = text(mounted.fixture);

    expect(rendered).toContain('The server refused these');
    expect(rendered).toContain('Cannot be sent');
    expect(rendered).toContain('Category not found.');
  });

  it('renders a re-classification as before and after, with the server reason', async () => {
    const mounted = await mount({
      diffs: [
        {
          seq: 1,
          rawText: 'Lidl 2000',
          localCategoryId: 'cat-food',
          localCategoryName: 'Hrana',
          serverCategoryId: 'cat-fuel',
          serverCategoryName: 'Gorivo',
          why: 'KEYWORD',
        },
      ],
    });
    const rendered = text(mounted.fixture);

    expect(rendered).toContain('Review the differences (1)');
    expect(rendered).toContain('Lidl 2000');
    expect(rendered).toContain('Hrana');
    expect(rendered).toContain('Gorivo');
    expect(rendered).toContain('Why: Keyword match');
  });

  it('falls back to the category id when the server name could not be resolved', async () => {
    const mounted = await mount({
      diffs: [
        {
          seq: 1,
          rawText: 'Lidl 2000',
          localCategoryId: null,
          localCategoryName: null,
          serverCategoryId: 'cat-fuel',
          serverCategoryName: null,
          why: 'DEFAULT',
        },
      ],
    });
    const rendered = text(mounted.fixture);

    expect(rendered).toContain('cat-fuel');
    expect(rendered).toContain('No category');
    // An unmapped source shows the server's own token rather than a guessed word.
    expect(rendered).toContain('Why: DEFAULT');
  });

  it('reveals the plain-text dump when asked to export', async () => {
    const mounted = await mount({ pending: [entry()] });
    expect((mounted.fixture.nativeElement as HTMLElement).querySelector('textarea')).toBeNull();

    button(mounted.fixture, 'Export as text').click();
    mounted.fixture.detectChanges();

    const area = (mounted.fixture.nativeElement as HTMLElement).querySelector('textarea');
    expect(area?.value).toBe('{"pending":[]}');
    expect(mounted.exportAsText).toHaveBeenCalledTimes(1);
  });

  it('retries and discards the row it belongs to', async () => {
    const mounted = await mount({ pending: [entry({ seq: 4 })] });

    button(mounted.fixture, 'Try again').click();
    await mounted.fixture.whenStable();
    expect(mounted.retry).toHaveBeenCalledWith(4);

    button(mounted.fixture, 'Discard').click();
    await mounted.fixture.whenStable();
    expect(mounted.discard).toHaveBeenCalledWith(4);
  });

  it('renders a refused edit as the two versions and before → after, with no invented reason', async () => {
    const { fixture } = await mount({
      conflicts: [
      {
        seq: 4,
        transactionId: 'tx-9',
        editedVersion: 6,
        serverVersion: 7,
        changes: [
          { field: 'amount', before: '200000', after: '250000' },
          { field: 'description', before: 'Lidl 2000', after: 'Lidl 2500' },
        ],
      },
      ],
    });

    const rendered = text(fixture);
    expect(rendered).toContain('The server refused these edits');
    // The whole explanation the API supports: the two versions.
    expect(rendered).toContain('version 6');
    expect(rendered).toContain('version 7');
    // The fields are labelled, never raw GraphQL names, and both sides are shown as they came.
    expect(rendered).toContain('Amount');
    expect(rendered).toContain('200000');
    expect(rendered).toContain('250000');
    expect(rendered).toContain('Description');
    // No "why" line: a conflict is not a classification decision, so quoting one would be invented.
    expect(rendered).not.toContain('Zašto');
  });

  it('says in words when a conflict changed none of the fields the user edited', async () => {
    const { fixture } = await mount({
      conflicts: [{ seq: 4, transactionId: 'tx-9', editedVersion: 6, serverVersion: 7, changes: [] }],
    });

    expect(text(fixture)).toContain('the row moved');
  });
});
