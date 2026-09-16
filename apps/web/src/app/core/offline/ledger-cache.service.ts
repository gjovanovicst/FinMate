/**
 * The ledger-rows cache: the last few weeks of Transactions, in the same encrypted store as everything
 * else offline (task 4.2.8, ADR-025 decision 5, ADR-027).
 *
 * ADR-027's ⚠️ column said what was missing rather than what shipped: *"Only the dashboard serves from a
 * snapshot. The ledger-rows cache the matrix's Ledger snapshot row wants is a separate record and is not
 * built; `/transactions` is still online-only."* This is that record — a **separate key in the same
 * store**, because ADR-027 decision 6 makes the snapshot and the queue one record set so one `purge()`
 * clears both.
 *
 * ## What is kept, and what is deliberately not
 *
 * `toSnapshotRow`'s whitelist is the whole story: an amount, a kind, a date, a description and a
 * category's id and name. No `note`, no `rawInput`, no counterparty note, and **no row id** — which has
 * a visible consequence the screen must not hide: a cached row cannot be drilled into, because there is
 * nothing to link to. Adding an id is a data-minimisation decision (docs/08 §3.9), not a convenience,
 * and it is recorded here rather than slipped in.
 *
 * Two more consequences fall out of the same whitelist, and **4.2.8b's screen has to live with both**:
 *
 * 1. **A split Transaction caches as `category: null`** — it has no single Category, and the whitelist
 *    holds one. So `null` means *either* "uncategorised" *or* "divided", and the cached list must claim
 *    neither: it renders the category when there is one and nothing when there is not. Live rows can
 *    tell the two apart (`splits.length > 0`), cached rows cannot, and a screen that guessed would say
 *    "no category" about a row with three.
 * 2. **`status` and `needsReview` are not cached**, so a cached list cannot show a review flag or a
 *    pending/void status. It is a summary of what was recorded, not a copy of the ledger screen.
 *
 * The window is ADR-025's "current period plus 45 days", capped, selected by `selectLedgerRows`, and the
 * TTL is the snapshot's own 24 h.
 *
 * ## Why its own `staleAt`
 *
 * A screen that serves cached rows has to say when they are from, and the header chip's stale half is
 * the *dashboard's* provenance (ADR-027 decision 5). Sharing one signal would let a cached transaction
 * list make the dashboard's figures look fresher than they are. Two records, two signals, one store.
 *
 * @module apps/web/src/app/core/offline
 */
import { Injectable, inject, signal } from '@angular/core';

import {
  SNAPSHOT_TTL_MS,
  selectLedgerRows,
  type SnapshotRow,
  type TransactionSnapshotSource,
} from './offline-store';
import { OfflineStoreHolder } from './offline-store-holder';

/** The `snapshot` store's ledger record. One key, beside the dashboard's. */
export const LEDGER_SNAPSHOT_KEY = 'ledger';

/** What sits under {@link LEDGER_SNAPSHOT_KEY}. */
export interface LedgerSnapshot {
  readonly syncedAt: string;
  /**
   * The ledger currency the rows are denominated in (ADR-011: exactly one per Household).
   *
   * On the **record** and not on each row, because it is a property of the Household's ledger rather
   * than of a Transaction — and because a currency code is not part of the row whitelist docs/08 §3.9
   * minimises. Without it a cached row cannot be rendered at all: `fm-money` takes `Money`, and
   * `Money` carries its currency (ADR-003). Discovered the moment the first screen tried to serve
   * these rows.
   */
  readonly currency: string;
  readonly rows: readonly SnapshotRow[];
}

@Injectable({ providedIn: 'root' })
export class LedgerCacheService {
  private readonly stores = inject(OfflineStoreHolder);

  private readonly staleAtSignal = signal<string | null>(null);

  /**
   * When the rows currently on screen came from the cache, or `null` when they are live.
   *
   * Set by {@link readRows} and cleared by {@link writeRows}, so a caller cannot render cached rows
   * without the label that says so — the same rule ADR-027 decision 2 applies to the dashboard.
   */
  readonly staleAt = this.staleAtSignal.asReadonly();

  /**
   * Cache a successful read. Called after the server answered, never on a timer.
   *
   * **Only an unfiltered read may be cached.** A search, a date range or a `needsReview` filter
   * produces a *subset*, and a subset cached under this key would be served later as the Household's
   * ledger — the screen would show four rows for a month and say nothing about the other ninety. The
   * caller owns that rule because only it knows its filters (`hasActiveFilters`), and
   * `transactions.component.ts` is where it is enforced.
   */
  async writeRows(
    rows: readonly TransactionSnapshotSource[],
    today: string,
    currency: string,
  ): Promise<void> {
    const record: LedgerSnapshot = {
      syncedAt: new Date().toISOString(),
      currency,
      rows: selectLedgerRows(rows, today),
    };
    await (await this.stores.repository()).put(
      'snapshot',
      LEDGER_SNAPSHOT_KEY,
      record,
      SNAPSHOT_TTL_MS,
    );
    this.staleAtSignal.set(null);
  }

  /** The cached rows, or `null`. Reading them is what marks them stale. */
  async readRows(): Promise<LedgerSnapshot | null> {
    const repository = await this.stores.repository();
    const record = await repository.get<LedgerSnapshot>('snapshot', LEDGER_SNAPSHOT_KEY);
    this.staleAtSignal.set(record?.syncedAt ?? null);
    return record ?? null;
  }

  /**
   * Forget the provenance this page was showing.
   *
   * Two triggers, and a caller must hit one of them or the label can outlive the rows it describes:
   * the store is wiped (the case this method was written for), or a **live read supersedes** a cached
   * one — a successful refresh after an offline visit, including a refresh that could not write a new
   * record because the user had a filter on. {@link writeRows} clears it too; this is the path for the
   * success that writes nothing.
   */
  reset(): void {
    this.staleAtSignal.set(null);
  }
}
