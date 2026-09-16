/**
 * The shapes the pending-sync queue and the tray share, kept free of Angular and of the transport.
 *
 * These exist as their own module because two directions need them: the capture screen builds a
 * `captureCommit` payload (a feature), the queue stores it verbatim (core), and the tray renders it.
 * A type both a feature and a core service name is a contract, not a detail of either — and keeping
 * it pure is what lets `sync.view.spec.ts` assert the queue's rendering without a DOM.
 *
 * `CaptureCommitInput` is docs/06 §5.2.1's input exactly: it is what the outbox stores as `variables`
 * under the `input` key, and what a replay sends unchanged. Money inside it is minor units **as
 * strings** (ADR-003) and nothing here parses or arithmetic it.
 *
 * See ADR-026, docs/02 §4.3 and docs/07 §6.
 *
 * @module apps/web/src/app/core/offline
 */

/** One row of `captureCommit`'s `rows` argument (docs/06 §5.2.1). */
export interface CaptureCommitRowInput {
  readonly clientRowId: string;
  readonly idempotencyKey: string;
  readonly clientId: string;
  readonly kind: 'EXPENSE' | 'INCOME';
  readonly amount: { readonly amountMinor: string; readonly currency: string };
  readonly categoryId: string | null;
  readonly description: string;
  readonly occurredOn: string | null;
  readonly acceptedProposalId: string | null;
  /**
   * The entities the preview resolved, echoed back so the committed row records them.
   *
   * The server resolution is returned in the proposal and is **not** re-derived at commit time, so
   * these are the only source. A row the server classified itself therefore still needs them sent
   * back — which is why they come from the proposal rather than from the row's own state.
   */
  readonly merchantId: string | null;
  readonly counterpartyId: string | null;
  readonly confirmDespiteLowConfidence: boolean;
}

/**
 * One whole `captureCommit` call, queued as a unit.
 *
 * A batch is queued rather than a row because the API commits the batch atomically — a queue of rows
 * would let offline captures interleave with an online one and change the order the ledger sees.
 */
export interface CaptureCommitInput {
  readonly parseId: string | null;
  readonly rows: readonly CaptureCommitRowInput[];
  readonly defaultAccountId: string | null;
  readonly occurredLocalDate: string | null;
  readonly discardProposalIds: readonly string[];
  readonly allowAi: boolean;
}

/**
 * One row of the local preview, as the diff needs it.
 *
 * This is the **client-only** half ADR-026 decision 2 adds to the queue: the category the user was
 * shown offline, so a server-side re-classification can be compared rather than merely applied. It
 * carries no money — a diff is about the category, and the amount was already exact locally.
 */
export interface CapturePreviewRow {
  readonly clientRowId: string;
  readonly rawText: string;
  readonly localCategoryId: string | null;
  readonly localCategoryName: string | null;
}

/**
 * One explainable difference between a queued preview and the server's own answer (ADR-026 decision 5,
 * docs/02 §4.3 point 3).
 *
 * `why` is the server's decision source for that row's classification (`ClassificationDecision.decidedBy`,
 * or the Transaction's `categorySource` when no decision row is linked). There is no free-text
 * rationale on `captureCommit`'s response — the preview's `rationale` is not part of the commit result —
 * so the source is rendered through the existing `capture.provenance.*` words rather than invented here.
 */
export interface SyncDiff {
  /** The queue entry the changed row came from. */
  readonly seq: number;
  readonly rawText: string;
  readonly localCategoryId: string | null;
  readonly localCategoryName: string | null;
  readonly serverCategoryId: string | null;
  readonly serverCategoryName: string | null;
  readonly why: string;
}
