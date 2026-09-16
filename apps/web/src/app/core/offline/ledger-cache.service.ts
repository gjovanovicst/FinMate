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

  /** Cache a successful read. Called after the server answered, never on a timer. */
  async writeRows(rows: readonly TransactionSnapshotSource[], today: string): Promise<void> {
    const record: LedgerSnapshot = { syncedAt: new Date().toISOString(), rows: selectLedgerRows(rows, today) };
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

  /** Forget the provenance this page was showing, when the store is wiped. */
  reset(): void {
    this.staleAtSignal.set(null);
  }
}
