/**
 * Which tab flushes the queue — ADR-026 decision 4, which deferred the answer to this task.
 *
 * With the app lock on, one IndexedDB backs every tab, so two tabs can both see the same queue and both
 * try to send it. The outbox is idempotent (`idempotencyKey`, I-10) so a double send is not data loss —
 * but it is two HTTP batches, two `seq` counters racing, and a `busy` flag in one tab that is wrong about
 * the other. A mutex around the pass is the smallest correct answer, and the Web Locks API is the
 * platform's own: `ifAvailable` means the loser *skips* instead of queueing behind the winner and
 * sending the same entries a moment later.
 *
 * Without Web Locks (Safari before 15.4, and every Node test) it runs: ADR-025's implementation notes
 * already record that capture from one tab is the supported configuration, and a lock that cannot be
 * taken must not mean a queue that never drains.
 *
 * See ADR-026 decision 4, ADR-025's implementation notes, docs/07 §6.
 *
 * @module apps/web/src/app/core/offline
 */

/** One name for the whole app, so a second tab is excluded by the same string. */
export const FLUSH_LOCK_NAME = 'finmate:offline-flush';

/**
 * Run `send` under the flush lock, or return `null` when another tab holds it.
 *
 * `locks` is passed in rather than read from the global so a spec can drive both branches without a
 * browser; the caller reads `navigator.locks` once.
 */
export async function withFlushLock<T>(
  locks: LockManager | undefined,
  send: () => Promise<T>,
): Promise<T | null> {
  if (locks === undefined) return send();
  return locks.request(FLUSH_LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, async (lock) =>
    lock === null ? null : send(),
  );
}
