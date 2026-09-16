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
  private builtFor: boolean | null = null;
  private generationRef = 0;

  /**
   * The repository this page uses, built for the key provider's current durability.
   *
   * `async` because the provider has to answer `persistent` first: the app lock reads one IndexedDB
   * record at bootstrap to learn whether this install has a lock, and building the backing before that
   * answer arrives would silently choose the in-memory store and quietly stop persisting for the page.
   *
   * The backing is **rebuilt when durability changes** — unlocking the lock switches the store from
   * memory to IndexedDB, and locking it switches back. That is the honest reading of ADR-025 decision 3:
   * while locked there is no key in memory, so there is nothing on disk this page may read, and the
   * store it sees is empty.
   */
  async repository(): Promise<OfflineRepository> {
    await this.keyProvider.ready?.();
    const persistent = this.keyProvider.persistent;
    if (this.repositoryRef === null || this.builtFor !== persistent) {
      this.repositoryRef = createOfflineStore(this.keyProvider);
      this.builtFor = persistent;
      this.generationRef += 1;
    }
    return this.repositoryRef;
  }

  /**
   * Bumped whenever the backing is replaced.
   *
   * A consumer that caches something derived from a repository — the outbox caches its `seq` counter —
   * compares this and rebuilds, so a switch cannot leave a queue allocating sequence numbers seeded
   * from a store that is no longer the one in use.
   */
  generation(): number {
    return this.generationRef;
  }
}
