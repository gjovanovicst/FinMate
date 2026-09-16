/**
 * The app's one offline store, held so that every offline feature shares it.
 *
 * ADR-027 decision 6 makes the snapshot and the queue the same record set: `purge()` is a single call
 * that has to clear both, the expiry sweep runs once when the store opens, and there is one in-memory
 * map. That is only true if `SyncService` and the snapshot service inject the same repository, so this
 * holder is the one place `createOfflineStore` is called. The alternative — each service building its
 * own — gives the app two purges, two sweeps and, while the key is session-only (ADR-025 decision 3),
 * two maps that silently disagree about what is stored.
 *
 * The backing is still built on first use rather than in a field: a screen that never syncs and never
 * reads a snapshot never opens anything.
 *
 * See ADR-027 decisions 1 and 6, ADR-025 decisions 3 and 6, docs/02 §4.2 and docs/05 §7.
 *
 * @module apps/web/src/app/core/offline
 */
import { Injectable, inject } from '@angular/core';

import { OFFLINE_KEY_PROVIDER } from './offline-key-provider';
import { createOfflineStore, type OfflineRepository } from './offline-store';

@Injectable({ providedIn: 'root' })
export class OfflineStoreHolder {
  private readonly keyProvider = inject(OFFLINE_KEY_PROVIDER);
  private repositoryRef: OfflineRepository | null = null;

  /** The one repository this page uses. Built once, then reused by every offline consumer. */
  repository(): OfflineRepository {
    this.repositoryRef ??= createOfflineStore(this.keyProvider);
    return this.repositoryRef;
  }
}
