/**
 * The sync service: the app's one handle on the outbox, and the flush policy around it.
 *
 * ADR-026 decides what this file is. The **tray is a route reached from the header's sync chip**
 * (decision 1), the queue carries whole `captureCommit` batches plus a client-only `meta` so the diff
 * can be built (decision 2), every entry records its attempts and a capped backoff (decision 3), and
 * the diff is a comparison of the queued preview with the server's own answer, never applied silently
 * (decision 5). ADR-025 decision 7 is the layer underneath: an ordered, idempotent flush that stops at
 * the first retryable failure.
 *
 * Three things are deliberately **not** here:
 *
 *  - **Leader-tab election.** With a session-only key (ADR-025 decision 3) two tabs cannot see each
 *    other's queue, so there is nothing to lead; ADR-026 decision 4 defers it to the persistent store.
 *  - **A retry timer.** Flushes run on app start, on `online` and on `visibilitychange` (docs/07 §6).
 *    {@link nextAttemptDelay} is the policy the tray displays, not a scheduled callback — a background
 *    timer in a PWA is a promise iOS does not keep (ADR-025 decision 6).
 *  - **Queued edits.** Nothing queues an edit yet; the money-field conflict diff is task 4.2.7.
 *
 * See ADR-026, ADR-025 decisions 3 and 7, docs/05 §7, docs/07 §6 and docs/02 §4.3.
 *
 * @module apps/web/src/app/core/offline
 */
import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';

import { GraphqlClient } from '../graphql/graphql.client';
import { OFFLINE_KEY_PROVIDER } from './offline-key-provider';
import { createOfflineStore } from './offline-store';
import {
  Outbox,
  type FlushResult,
  type GraphQLFailureDetail,
  type OutboxEntry,
} from './outbox';
import type { CaptureCommitInput, CapturePreviewRow, SyncDiff } from './sync.types';
import {
  previewIndex,
  queueDump,
  type QueuedPreview,
} from './sync.view';

/**
 * The atomic write, queued whole (docs/06 §5.2.1).
 *
 * The selection is the **superset** the queue and the capture screen need between them: the screen
 * reads the duplicate suspects and the review count, while the diff reads each committed row's
 * category and its decision source. One document means a queued retry and a live commit cannot drift
 * apart in what they ask the server for.
 */
export const CAPTURE_COMMIT = /* GraphQL */ `
  mutation CaptureCommit($input: CaptureCommitInput!) {
    captureCommit(input: $input) {
      __typename
      ... on CaptureCommitSuccessModel {
        replayed
        reviewQueueCount
        committed {
          clientRowId
          wasReplayed
          transaction {
            id
            categoryId
            categorySource
          }
          classification {
            categoryId
            decidedBy
          }
        }
        duplicateSuspects {
          clientRowId
          transactionId
          existingTransactionId
          similarity
          matchedOn
          existingTransaction {
            id
            description
            occurredLocalDate
            amount
          }
        }
      }
      ... on CaptureCommitRejectedModel {
        code
        message
        rejected {
          clientRowId
          code
          message
          field
        }
      }
    }
  }
`;

/**
 * Category names, for naming a category the server chose that the local preview never saw.
 *
 * `captureCommit` returns a `categoryId`, not a category object (the wire model carries no nested
 * Category), so the diff reads the names from the same `categories` query the composer already uses.
 * It is fetched lazily — only when a row actually changed — and cached for the session; a failure
 * leaves the id in place rather than holding up the flush.
 */
const CATEGORY_NAMES = /* GraphQL */ `
  query SyncCategoryNames {
    categories {
      id
      name
    }
  }
`;

interface CommitResponse {
  readonly captureCommit: {
    readonly __typename: string;
    readonly replayed?: boolean;
    readonly reviewQueueCount?: number;
    readonly committed?: readonly {
      readonly clientRowId: string;
      readonly wasReplayed: boolean;
      readonly transaction: {
        readonly id: string;
        readonly categoryId?: string | null;
        readonly categorySource?: string | null;
      };
      readonly classification?: {
        readonly categoryId?: string | null;
        readonly decidedBy?: string | null;
      } | null;
    }[];
    readonly code?: string;
    readonly message?: string;
  };
}

interface CategoryNamesResponse {
  readonly categories: readonly { readonly id: string; readonly name: string }[];
}

/**
 * A `CaptureCommitRejectedModel` result, re-thrown so the outbox parks the entry as "cannot be sent".
 *
 * It is shaped like the app's GraphQL failure ({@link GraphQLFailureDetail}) so the queue's own
 * structural classifier recognises it as a **refusal** without this module and the outbox sharing a
 * class: `status: 200` is honest (GraphQL reports the refusal in the body) and the code is a refusal
 * code, so `isRetryable` returns false and `describe` keeps the server's own message. Retrying a
 * refusal sends the identical refusal forever, which is exactly what the tray must not do.
 */
export class SyncRefusedError extends Error {
  readonly status = 200;
  readonly errors: readonly GraphQLFailureDetail[];

  constructor(message: string) {
    super(message);
    this.name = 'SyncRefusedError';
    this.errors = [{ message, code: 'BAD_USER_INPUT', retryable: false }];
  }
}

@Injectable({ providedIn: 'root' })
export class SyncService {
  private readonly graphql = inject(GraphqlClient);
  private readonly keyProvider = inject(OFFLINE_KEY_PROVIDER);
  private readonly documentRef = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  /** Built on first use, never in a field initialiser — a screen that never syncs never opens a store. */
  private outboxRef: Outbox | null = null;

  private readonly pendingSignal = signal<readonly OutboxEntry[]>([]);
  private readonly rejectedSignal = signal<readonly OutboxEntry[]>([]);
  private readonly busySignal = signal(false);
  private readonly lastErrorSignal = signal<string | null>(null);
  private readonly diffsSignal = signal<readonly SyncDiff[]>([]);
  private names: ReadonlyMap<string, string> | null = null;

  readonly pending = this.pendingSignal.asReadonly();
  readonly rejected = this.rejectedSignal.asReadonly();
  readonly pendingCount = computed(() => this.pendingSignal().length);
  readonly busy = this.busySignal.asReadonly();
  readonly lastError = this.lastErrorSignal.asReadonly();
  readonly diffs = this.diffsSignal.asReadonly();

  constructor() {
    const document = this.documentRef;
    // Optional on `defaultView` because a spec is free to provide a minimal document; a missing
    // window must degrade to "no flush triggers", never to a boot failure.
    const view = document?.defaultView ?? null;
    const onOnline = (): void => {
      void this.flushNow();
    };
    const onVisibility = (): void => {
      // `visible` only: a queue that drained every time a tab was hidden would retry while the user is
      // elsewhere, which is the flush they did not ask for.
      if (document.visibilityState === 'visible') void this.flushNow();
    };

    // Guarded because these are the two globals a spec (or a non-browser renderer) is free to leave
    // minimal, and a missing event target must not break the app's boot.
    if (view !== null && typeof view.addEventListener === 'function') {
      view.addEventListener('online', onOnline);
    }
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    this.destroyRef.onDestroy(() => {
      if (view !== null && typeof view.removeEventListener === 'function') {
        view.removeEventListener('online', onOnline);
      }
      if (typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    });

    // App start (ADR-026 decision 3). Deliberately not awaited: every consumer is a signal.
    void this.flushNow();
  }

  /**
   * Queue one whole commit, with the local preview alongside it in `meta`.
   *
   * Called by the capture screen when `captureCommit` fails **retryably**, so the batch the user
   * confirmed goes out later with the same `idempotencyKey`s it was built with (I-10). The rows are
   * stored as the diff's "before" side; the variables are exactly what the server will receive.
   */
  async enqueueCapture(
    input: CaptureCommitInput,
    rows: readonly CapturePreviewRow[],
  ): Promise<OutboxEntry> {
    const entry = await this.outbox().enqueue(CAPTURE_COMMIT, { input }, { preview: rows });
    await this.refresh();
    return entry;
  }

  /**
   * Send everything queued, in `seq` order.
   *
   * `busy` covers the whole pass so the tray and the chip can say so, and the outbox itself refuses to
   * re-enter: a second trigger while one is in flight joins it rather than double-sending.
   */
  async flushNow(): Promise<FlushResult | null> {
    this.busySignal.set(true);
    this.lastErrorSignal.set(null);
    try {
      const outbox = this.outbox();
      const index = previewIndex(await outbox.pending());
      const collected: SyncDiff[] = [];
      const result = await outbox.flush((document, variables) =>
        this.transport(document, variables, index, collected),
      );

      if (collected.length > 0) {
        this.diffsSignal.update((current) => [...current, ...collected]);
      }
      if (result.stoppedAt?.error !== undefined) {
        this.lastErrorSignal.set(result.stoppedAt.error);
      }
      await this.refresh();
      return result;
    } catch (error) {
      // A failure to *read* the queue (a store that will not open) is the only thing that reaches
      // here: per-entry failures are the outbox's to classify and the tray's to show.
      this.lastErrorSignal.set(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      this.busySignal.set(false);
    }
  }

  /** Put one entry back in the queue and try again — the tray's per-row *Pokušaj ponovo*. */
  async retry(seq: number): Promise<void> {
    await this.outbox().retry(seq);
    await this.refresh();
    await this.flushNow();
  }

  /** Drop one entry without sending it. The only action that loses a capture, so it is never implicit. */
  async discard(seq: number): Promise<void> {
    await this.outbox().discard(seq);
    await this.refresh();
  }

  /** Put every refused entry back and drain the queue — the tray's *Pokušaj sve*. */
  async retryAll(): Promise<void> {
    const outbox = this.outbox();
    for (const entry of await outbox.rejected()) {
      await outbox.retry(entry.seq);
    }
    await this.refresh();
    await this.flushNow();
  }

  /** The whole queue as plain text (docs/07 §6's escape hatch). Data, so nothing here is translated. */
  exportAsText(): string {
    return queueDump(this.pendingSignal(), this.rejectedSignal(), new Date().toISOString());
  }

  /** Re-read both lists. Called after every queue operation so the tray and the chip are never stale. */
  async refresh(): Promise<void> {
    try {
      const outbox = this.outbox();
      const [pending, rejected] = await Promise.all([outbox.pending(), outbox.rejected()]);
      this.pendingSignal.set(pending);
      this.rejectedSignal.set(rejected);
    } catch {
      // A queue that cannot be read keeps its last known contents on screen rather than emptying it,
      // which would read as "sent" when nothing was.
    }
  }

  /**
   * One `graphql.query` call, wrapped so the outbox sees only "sent" or "threw".
   *
   * The refusal arm is converted here and nowhere else: an accepted arm builds the diff, and a network
   * or server failure propagates untouched so the outbox's classifier decides whether to retry.
   */
  private async transport(
    document: string,
    variables: Record<string, unknown>,
    index: ReadonlyMap<string, QueuedPreview>,
    collected: SyncDiff[],
  ): Promise<void> {
    const response = await this.graphql.query<CommitResponse>(document, variables);
    const result = response.captureCommit;

    if (result.__typename === 'CaptureCommitRejectedModel') {
      // The whole batch is refused together (docs/06 §5.2.1), so the message describes all of it.
      throw new SyncRefusedError(result.message ?? '');
    }

    for (const committed of result.committed ?? []) {
      const queued = index.get(committed.clientRowId);
      if (queued === undefined) continue;

      const serverCategoryId = committed.transaction.categoryId ?? null;
      // Only a row the server actually classified differently produces an entry (ADR-026 decision 5).
      if (serverCategoryId === queued.row.localCategoryId) continue;

      collected.push({
        seq: queued.seq,
        rawText: queued.row.rawText,
        localCategoryId: queued.row.localCategoryId,
        localCategoryName: queued.row.localCategoryName,
        serverCategoryId,
        serverCategoryName: await this.nameOf(serverCategoryId),
        why: committed.classification?.decidedBy ?? committed.transaction.categorySource ?? 'NONE',
      });
    }
  }

  private async nameOf(categoryId: string | null): Promise<string | null> {
    if (categoryId === null) return null;
    return (await this.categoryNames()).get(categoryId) ?? null;
  }

  private async categoryNames(): Promise<ReadonlyMap<string, string>> {
    if (this.names !== null) return this.names;
    try {
      const data = await this.graphql.query<CategoryNamesResponse>(CATEGORY_NAMES);
      this.names = new Map(data.categories.map((category) => [category.id, category.name]));
    } catch {
      // A name is a nicety on a diff whose ids are already enough to act on; do not fail the flush for it.
      this.names = new Map();
    }
    return this.names;
  }

  private outbox(): Outbox {
    this.outboxRef ??= new Outbox(createOfflineStore(this.keyProvider));
    return this.outboxRef;
  }
}
