/**
 * Whether the browser believes it has a network, as a signal.
 *
 * The app needs this for one honest sentence: a page that cannot reach the server should say so before a
 * person taps a control that will fail. Every screen already has an error state for a failed call, but an
 * error after the fact reads as a bug; a banner before it reads as the state of the world.
 *
 * **`navigator.onLine` is a weak signal and is treated as one.** It is `true` behind a captive portal and
 * `true` on a LAN with no route out, so it can only ever *lower* confidence: `online` false means
 * "definitely nothing will work", `online` true means "ask the server and find out". Nothing that decides
 * whether to send or persist may branch on it — `SyncService` flushes on the real attempt and the outbox
 * classifies the real answer (ADR-025 decision 7). This signal only chooses copy.
 *
 * It exists as its own service rather than as a field on `SyncService` because the banner belongs to the
 * *shell*, which must render it while locked, while signed out, and on an install that never armed the
 * lock — three states in which `SyncService` is not the thing being described.
 *
 * @module apps/web/src/app/core/connectivity
 */
import { DOCUMENT, DestroyRef, Injectable, inject, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ConnectivityService {
  private readonly onlineSignal = signal(true);

  /** `false` only when the browser says there is no network at all. */
  readonly online = this.onlineSignal.asReadonly();

  constructor() {
    const view = inject(DOCUMENT)?.defaultView ?? null;
    // A spec (or a non-browser renderer) is free to provide a minimal document. A missing event target
    // must degrade to "always online", never to a boot failure — the same guard `SyncService` uses.
    if (view === null || typeof view.addEventListener !== 'function') return;

    // Seeded from the current value, because a page loaded *while* offline never receives the `offline`
    // event: the state is already true at first render and no transition announces it.
    this.onlineSignal.set(view.navigator?.onLine !== false);

    const goOnline = (): void => this.onlineSignal.set(true);
    const goOffline = (): void => this.onlineSignal.set(false);

    view.addEventListener('online', goOnline);
    view.addEventListener('offline', goOffline);

    inject(DestroyRef).onDestroy(() => {
      view.removeEventListener('online', goOnline);
      view.removeEventListener('offline', goOffline);
    });
  }
}
