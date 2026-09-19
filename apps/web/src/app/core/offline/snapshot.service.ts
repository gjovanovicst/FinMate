/**
 * The dashboard snapshot: the server's own figures, cached so an offline read is labelled rather than
 * fabricated.
 *
 * ADR-027 decides this file. The snapshot is a **per-read-model** record — `{ syncedAt, figures }`
 * where `figures` is the `Dashboard` payload verbatim (decision 1) — because docs/07 §6's matrix
 * forbids recomputing safe-to-spend client-side, so the only honest offline figure is the number the
 * server last computed. It is written **after a successful read, never on a timer** (decision 6) and
 * it expires with the store's own 24 h snapshot TTL (ADR-025 decision 6), so an expired record reads
 * as "none" and the dashboard keeps its honest error state (decision 3: never fabricate).
 *
 * {@link SnapshotService.staleAt} is the provenance the header chip and the dashboard both read. It is
 * set by {@link SnapshotService.readDashboard} itself, so a caller cannot serve cached figures without
 * the signal that says they are stale, and cleared only by a live write.
 *
 * See ADR-027, ADR-025 decisions 3 and 6, docs/02 §4.2 and docs/10 §8.3.
 *
 * @module apps/web/src/app/core/offline
 */
import { Injectable, inject, signal } from '@angular/core';

import { SNAPSHOT_TTL_MS } from './offline-store';
import { OfflineStoreHolder } from './offline-store-holder';

/** The snapshot store's one dashboard record. */
export const DASHBOARD_SNAPSHOT_KEY = 'dashboard';

/**
 * The wire Money shape (docs/06 §1) as it is stored.
 *
 * Spelled out rather than imported from the UI layer: this record is core data, and its only job is
 * to hold exactly what the server sent — `amountMinor` stays a string so nothing can round it, and
 * nothing here parses or formats it (ADR-003).
 */
export interface SnapshotMoney {
  readonly amountMinor: string;
  readonly currency: string;
}

/**
 * The `Dashboard` GraphQL payload, field for field — every selection the dashboard query makes.
 *
 * This is the server's own answer, so nothing in the snapshot layer computes, converts or defaults a
 * figure: `paceIsReliable` is a server decision and a `null` budget means the server chose not to
 * offer a safe-to-spend figure, and both are rendered exactly as cached (ADR-027 decision 3).
 */
export interface DashboardFigures {
  readonly today: string;
  /**
   * The Household's own month, as the server named it.
   *
   * Carried in the snapshot because ADR-039's panels need a range and the range has to be the server's
   * calendar rather than the browser's (docs/03 §3.2). A cached reading of them keeps its own period, so
   * an offline dashboard labels the month its figures are actually about.
   */
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly daysElapsed: number;
  readonly daysInMonth: number;
  readonly safeToSpendToday: SnapshotMoney;
  readonly available: SnapshotMoney;
  readonly isOverspent: boolean;
  readonly spentThisMonth: SnapshotMoney;
  readonly incomeThisMonth: SnapshotMoney;
  readonly monthlyBudget: SnapshotMoney | null;
  readonly projectedTotal: SnapshotMoney;
  readonly projectedOverrun: SnapshotMoney | null;
  readonly paceIsReliable: boolean;
  readonly needsReviewCount: number;
}

/** What sits in the `snapshot` store under {@link DASHBOARD_SNAPSHOT_KEY}. */
export interface DashboardSnapshot {
  readonly syncedAt: string;
  readonly figures: DashboardFigures;
}

@Injectable({ providedIn: 'root' })
export class SnapshotService {
  private readonly stores = inject(OfflineStoreHolder);

  private readonly staleAtSignal = signal<string | null>(null);

  /**
   * When the figures currently on screen came from the snapshot, or `null` when they are live.
   *
   * The header chip reads this (ADR-027 decision 5) and the dashboard reads it for its `podaci od`
   * line (decision 4). It is written only here, so the two cannot disagree about the same moment.
   */
  readonly staleAt = this.staleAtSignal.asReadonly();

  /**
   * Cache a successful live read.
   *
   * Called by the dashboard after the server answered — never by a timer (ADR-027 decision 6). A
   * successful read is live by definition, so this also clears {@link staleAt}.
   */
  async writeDashboard(figures: DashboardFigures): Promise<void> {
    const record: DashboardSnapshot = { syncedAt: new Date().toISOString(), figures };
    await (await this.stores.repository()).put(
      'snapshot',
      DASHBOARD_SNAPSHOT_KEY,
      record,
      SNAPSHOT_TTL_MS,
    );
    this.staleAtSignal.set(null);
  }

  /**
   * The cached dashboard, or `null` when there is none or it has expired.
   *
   * The store filters expiry on every read (ADR-025 decision 6), so an expired record is simply
   * absent here. The read is what marks the figures stale: returning a record without setting
   * {@link staleAt} would be a way to render a cached figure unlabelled, which ADR-027 decision 2
   * exists to prevent. A miss clears it instead — there is nothing to label.
   */
  async readDashboard(): Promise<DashboardSnapshot | null> {
    const repository = await this.stores.repository();
    const record = await repository.get<DashboardSnapshot>('snapshot', DASHBOARD_SNAPSHOT_KEY);
    this.staleAtSignal.set(record?.syncedAt ?? null);
    return record ?? null;
  }

  /**
   * Forget the provenance this page was showing.
   *
   * Called when the store is wiped — a sign-out, a revoke, turning the lock off. `purge()` clears the
   * records, but {@link staleAt} is a signal: without this the header chip would keep saying *"podaci
   * od 08:12"* about a snapshot that no longer exists, which is worse than saying nothing (ADR-027
   * decision 5).
   */
  reset(): void {
    this.staleAtSignal.set(null);
  }
}
