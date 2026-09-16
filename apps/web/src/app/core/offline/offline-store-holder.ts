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
 * {@link generation} is a **signal**, and the backing is invalidated when the key provider's own
 * {@link OfflineKeyProvider.durability} changes, because a consumer that caches a repository has to be
 * told (R-27(a)). Before that, the switch happened only when a *data* consumer happened to call
 * `repository()` after the unlock, and the queue's consumer caches its outbox — so an offline capture
 * could be written to the in-memory backing for the life of the page and be lost on reload with nothing
 * on screen saying so.
 *
 * See ADR-027 decisions 1 and 6, ADR-025 decisions 3 and 6, docs/02 §4.2 and docs/05 §7.
 *
 * @module apps/web/src/app/core/offline
 */
import { Injectable, effect, inject, signal } from '@angular/core';

import { OFFLINE_KEY_PROVIDER } from './offline-key-provider';
import { createOfflineStore, type OfflineRepository } from './offline-store';

@Injectable({ providedIn: 'root' })
export class OfflineStoreHolder {
  private readonly keyProvider = inject(OFFLINE_KEY_PROVIDER);
  private repositoryRef: OfflineRepository | null = null;
  private builtFor: boolean | null = null;
  private readonly generationSignal = signal(0);

  /**
   * Which backing this page is on, as a counter — a signal because a consumer must **react** to it.
   *
   * A consumer that caches something derived from a repository — the outbox caches its `seq` counter —
   * compares this and rebuilds, so a switch cannot leave a queue allocating sequence numbers seeded from
   * a store that is no longer the one in use. A signal rather than a plain getter (R-27(a)): a cached
   * consumer that only *compares* on its next call can be asleep when the change happens, which is
   * exactly how the queue stayed on the in-memory backing.
   */
  readonly generation = this.generationSignal.asReadonly();

  constructor() {
    // Watch the provider's durability. An `effect` rather than a callback the app lock calls: the state
    // has four exits (an armed install's unlock, `lock()`, `purge()`, a failed install read) and a
    // transition a caller forgets is a store that silently stops persisting.
    //
    // Only a **change** invalidates. An effect's first run happens on the next tick, and invalidating
    // there would throw away a backing whose contents are the only copy — an in-memory store cannot be
    // rebuilt from disk. (The dashboard's mounted spec is what caught that: it seeds a snapshot before
    // the first change detection, and the tick discarded it.)
    const durability = this.keyProvider.durability;
    if (durability !== undefined) {
      let seen = durability();
      effect(() => {
        const now = durability();
        if (now === seen) return;
        seen = now;
        this.invalidate();
      });
    }
  }

  /**
   * The repository this page uses, built for the key provider's current durability.
   *
   * `async` because the provider has to answer `persistent` first: the app lock reads one IndexedDB
   * record at bootstrap to learn whether this install has a lock, and building the backing before that
   * answer arrives would silently choose the in-memory store and quietly stop persisting for the page.
   *
   * The `builtFor` comparison stays even though {@link generation} now reacts to the same fact: a
   * provider with no `durability` signal (a spec's stub, a session-only install) still gets the lazy
   * rebuild, and the two together make "the backing matches the durability" true for every caller
   * rather than only for the ones that watch.
   */
  async repository(): Promise<OfflineRepository> {
    await this.keyProvider.ready?.();
    const persistent = this.keyProvider.persistent;
    if (this.repositoryRef === null || this.builtFor !== persistent) {
      this.repositoryRef = createOfflineStore(this.keyProvider);
      this.builtFor = persistent;
      this.generationSignal.update((value) => value + 1);
    }
    return this.repositoryRef;
  }

  /**
   * Drop the cached backing, so the next `repository()` picks one for the current durability.
   *
   * Called by the durability watch above, never by hand: a caller that invalidated without the state
   * having changed would throw away a repository whose writes are still the ones on screen.
   */
  private invalidate(): void {
    this.repositoryRef = null;
    this.builtFor = null;
    this.generationSignal.update((value) => value + 1);
  }
}
