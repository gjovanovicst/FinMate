/**
 * The outbox: capture mutations queue locally, flush in order, and are never silently dropped.
 *
 * ADR-016 fixed the semantics (client-generated ids, an `idempotencyKey` on every write, a queue
 * flushed in order) and ADR-025 decision 7 fixed the rules this file implements: a monotonic `seq`
 * per entry, whole entries sent in `seq` order, a stop at the first **retryable** failure so order is
 * preserved, a **refusal** marked rejected because it needs a person rather than a retry, and a replay
 * that is safe because the keys were minted when the row was created (I-10).
 *
 * The outbox knows nothing about transport: `flush(send)` is handed a function, so it never builds a
 * document and never touches the network. Even the failure type is structural (see
 * {@link GraphQLFailure}) — a queue that had to import the GraphQL client in order to recognise a
 * refusal would depend on Angular's `HttpClient` for no reason.
 *
 * See ADR-016, ADR-025 decisions 6–7, docs/05 §7 and docs/10 §8.3.
 *
 * @module apps/web/src/app/core/offline
 */
import {
  PENDING_CAPTURE_TTL_MS,
  type EncryptedStoreName,
  type OfflineRepository,
} from './offline-store';

export type OutboxStatus = 'pending' | 'sent' | 'rejected';

/**
 * One queued mutation.
 *
 * `variables` are passed to the server byte-for-byte as they were enqueued. Money inside them is
 * minor units **as strings** (ADR-003) and the outbox must never parse or arithmetic them — it is a
 * queue, not a calculator.
 */
export interface OutboxEntry {
  readonly seq: number;
  readonly enqueuedAt: string;
  readonly document: string;
  readonly variables: Record<string, unknown>;
  readonly status: OutboxStatus;
  readonly error?: string;
}

/**
 * The failure shape this classifier recognises, typed **structurally** rather than imported.
 *
 * The real error is `GraphQLRequestError` in `core/graphql/graphql.client.ts`, but that module imports
 * Angular's `HttpClient`; importing the class would make a transport-free queue depend on the transport
 * implementation, and would drag Angular into this module's own spec, which is a plain Node test. The
 * shape is pinned to the real class by a compile-time assertion in `outbox.spec.ts`, so the two cannot
 * drift without a type error.
 */
export interface GraphQLFailureDetail {
  readonly message?: string;
  readonly code?: string;
  readonly retryable?: boolean;
}

export interface GraphQLFailure {
  readonly status: number;
  /** Present because the real error extends `Error`; the tray shows this rather than a code. */
  readonly message?: string;
  readonly errors: readonly GraphQLFailureDetail[];
}

/** Recognise anything shaped like the app's GraphQL failure, without importing its class. */
export function isGraphQLFailure(value: unknown): value is GraphQLFailure {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { readonly status?: unknown; readonly errors?: unknown };
  return typeof candidate.status === 'number' && Array.isArray(candidate.errors);
}

/** Injected transport. Resolves on success and rejects with the app's own error type. */
export type OutboxSend = (
  document: string,
  variables: Record<string, unknown>,
) => Promise<void>;

/** What one flush did, so a tray can say "3 sent, 1 needs you" without re-reading the queue. */
export interface FlushResult {
  readonly sent: number;
  readonly rejected: number;
  /** The entry that stopped the flush, or `null` when the queue drained. */
  readonly stoppedAt: OutboxEntry | null;
}

const OUTBOX_STORE: EncryptedStoreName = 'outbox';

/** GraphQL codes that mean "a person must change something" — retrying sends the same refusal. */
const REFUSAL_CODES = new Set([
  'VALIDATION_FAILED',
  'BAD_USER_INPUT',
  'GRAPHQL_VALIDATION_FAILED',
  'GRAPHQL_PARSE_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'QUOTA_EXCEEDED',
]);

/** Codes that are the server's problem, so the same request may succeed later. */
const RETRYABLE_CODES = new Set(['INTERNAL', 'RATE_LIMITED', 'AI_UNAVAILABLE', 'SERVICE_UNAVAILABLE']);

/**
 * Classify a failure from `send`.
 *
 * Pure and exported so it can be tested directly (docs/10 §8.3's offline table). It matches the real
 * error **structurally** ({@link GraphQLFailure}) rather than by `instanceof`, and additionally treats
 * a timeout (`TimeoutError`/`AbortError`) and a fetch-level `TypeError` as retryable, because those are
 * how a genuinely offline client fails. Anything unrecognised is retryable: the queue stops and
 * surfaces it, which is R-20's "never silently dropped", whereas guessing "refused" would park a live
 * capture behind a tray that claims a person must fix it.
 */
export function isRetryable(error: unknown): boolean {
  if (isGraphQLFailure(error)) {
    if (error.status === 0 || error.status >= 500) return true; // offline, DNS, 5xx
    if (error.status === 408 || error.status === 429) return true; // timeout, throttled
    if (error.status >= 400) return false; // every other 4xx is a refusal

    for (const item of error.errors) {
      // `code` is optional in the structural shape: a malformed error body with no code must not
      // decide anything, it falls through to the `retryable` flag and then to the retry default.
      const code = item.code;
      if (code === undefined) continue;
      if (REFUSAL_CODES.has(code)) return false;
      if (RETRYABLE_CODES.has(code)) return true;
    }
    // HTTP 200 carrying a code we do not know: trust the server's own `retryable` flag.
    return error.errors[0]?.retryable ?? true;
  }

  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return true;
  }
  // `fetch` rejects with a `TypeError` when the network is unavailable.
  if (error instanceof TypeError) return true;
  return true;
}

/**
 * The queue itself, backed by the offline store.
 *
 * The sequence counter is seeded from the durable maximum on first use and then incremented
 * **synchronously** before any `await`, so two Confirm presses in the same millisecond cannot share a
 * `seq` and a reload cannot reuse one. (A second tab sharing the database is not a supported capture
 * configuration — ADR-016's model is deliberately not collaborative-grade.)
 */
export class Outbox {
  private seeded: Promise<void> | null = null;
  private nextSeq = 0;

  constructor(private readonly store: OfflineRepository) {}

  /** Queue one mutation. Returns the entry, so a caller can surface its `seq` immediately. */
  async enqueue(document: string, variables: Record<string, unknown>): Promise<OutboxEntry> {
    await this.seed();
    const seq = ++this.nextSeq;
    const entry: OutboxEntry = {
      seq,
      enqueuedAt: new Date().toISOString(),
      document,
      variables,
      status: 'pending',
    };
    await this.store.put(OUTBOX_STORE, keyFor(seq), entry, PENDING_CAPTURE_TTL_MS);
    return entry;
  }

  /** Entries still owed to the server, oldest first. */
  async pending(): Promise<OutboxEntry[]> {
    return bySeq((await this.all()).filter((entry) => entry.status === 'pending'));
  }

  /** Entries the server refused. They wait for a person, not for a retry. */
  async rejected(): Promise<OutboxEntry[]> {
    return bySeq((await this.all()).filter((entry) => entry.status === 'rejected'));
  }

  /** Put a refused entry back in the queue. */
  async retry(seq: number): Promise<void> {
    const entry = await this.store.get<OutboxEntry>(OUTBOX_STORE, keyFor(seq));
    if (!entry) return;
    const next: OutboxEntry = {
      seq: entry.seq,
      enqueuedAt: entry.enqueuedAt,
      document: entry.document,
      variables: entry.variables,
      status: 'pending',
    };
    await this.store.put(OUTBOX_STORE, keyFor(seq), next, remainingTtl(entry));
  }

  /** Drop an entry without sending it. */
  async discard(seq: number): Promise<void> {
    await this.store.remove(OUTBOX_STORE, keyFor(seq));
  }

  /**
   * Send queued entries in `seq` order.
   *
   * A success removes the entry; a refusal marks it rejected and the flush carries on; a retryable
   * failure stops the flush and leaves it and everything after it pending, so the queue's order is
   * never reordered by a partial failure.
   */
  async flush(send: OutboxSend): Promise<FlushResult> {
    let sent = 0;
    let rejected = 0;

    for (const entry of await this.pending()) {
      try {
        // The variables go out exactly as stored. The `idempotencyKey`/`clientRowId` inside them were
        // minted when the row was created and are never regenerated, so if this call actually landed
        // and the response was lost, the server collapses the replay (I-10, `replayed: true`).
        await send(entry.document, entry.variables);
        await this.store.remove(OUTBOX_STORE, keyFor(entry.seq));
        sent += 1;
      } catch (error) {
        if (isRetryable(error)) {
          return { sent, rejected, stoppedAt: entry };
        }
        await this.store.put(
          OUTBOX_STORE,
          keyFor(entry.seq),
          { ...entry, status: 'rejected', error: describe(error) },
          // Keep the original 30-day window rather than restarting it on every refusal.
          remainingTtl(entry),
        );
        rejected += 1;
      }
    }

    return { sent, rejected, stoppedAt: null };
  }

  private async all(): Promise<OutboxEntry[]> {
    return this.store.list<OutboxEntry>(OUTBOX_STORE);
  }

  private seed(): Promise<void> {
    // A failed seed must not be memoized: a transient IndexedDB error would otherwise wedge every
    // later `enqueue` for the life of the page.
    this.seeded ??= (async () => {
      this.nextSeq = (await this.all()).reduce((max, entry) => Math.max(max, entry.seq), 0);
    })().catch((error: unknown) => {
      this.seeded = null;
      throw error;
    });
    return this.seeded;
  }
}

function keyFor(seq: number): string {
  return String(seq);
}

function bySeq(entries: OutboxEntry[]): OutboxEntry[] {
  return [...entries].sort((left, right) => left.seq - right.seq);
}

function remainingTtl(entry: OutboxEntry): number {
  const elapsed = Date.now() - Date.parse(entry.enqueuedAt);
  return Number.isFinite(elapsed)
    ? Math.max(0, PENDING_CAPTURE_TTL_MS - elapsed)
    : PENDING_CAPTURE_TTL_MS;
}

/**
 * The sentence a tray can show for a refused entry.
 *
 * The server's own message wins: a refusal already says what is wrong with the row ("Line 1 has no
 * category"), and that is more useful than a code or a generic apology.
 */
function describe(error: unknown): string {
  if (isGraphQLFailure(error)) {
    return error.errors[0]?.message ?? error.message ?? 'The server refused this entry.';
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
