import { Injectable, inject, signal } from '@angular/core';

import { GraphqlClient } from '../graphql/graphql.client';

/**
 * The blocking-lane count, shared by the shell's badge and the review screen.
 *
 * docs/02 §2.3 makes the count a shell concern: it is drawn in the nav, it is the only badged slot,
 * and it must be visible from every screen. The shell and the screen therefore cannot each own a
 * copy — the screen resolves rows, and a badge that did not hear about it would keep advertising work
 * that is already done.
 *
 * ## Why there is no subscription and no polling
 *
 * docs/02 §2.3 asks for *"a GraphQL subscription on the count; optimistic decrement when the client
 * resolves a row."* The subscription is **not built** (no realtime layer exists in this build). Two
 * cheaper mechanisms cover the same need:
 *
 *  - a resolution returns `reviewQueueCount` — the authoritative post-write count — and
 *    {@link setCount} applies it, so the badge is exact at the moment it matters;
 *  - the shell re-reads on navigation, which is what the API's own description invites ("a scoped
 *    COUNT, so the shell can ask on every screen without loading rows").
 *
 * Neither is optimistic-then-reconciled, and that is an improvement rather than a shortcut: a
 * decrement guessed before the write would be wrong whenever `applyToSimilar` swept peers, which
 * resolves more than one row per action.
 *
 * @module apps/web/src/app/core/review
 */
@Injectable({ providedIn: 'root' })
export class ReviewQueueStore {
  private readonly graphql = inject(GraphqlClient);

  private readonly countSignal = signal(0);

  /** The blocking-lane count (invariant I-8). Never negative, never a guess. */
  readonly count = this.countSignal.asReadonly();

  /**
   * `true` once the queue has been emptied by a resolution **in this session** — the one-shot toast
   * docs/02 §2.3 allows ("shows one toast, once per session. No celebration loop.").
   *
   * Session-scoped on purpose: an empty queue on load is the normal steady state, and announcing it
   * on every sign-in would be a notification about nothing.
   */
  private celebrated = false;

  /** Re-read the count. Failures are deliberately silent — a badge is not worth an error banner. */
  async refresh(): Promise<void> {
    try {
      const data = await this.graphql.query<{ reviewQueueCount: number }>(REVIEW_QUEUE_COUNT);
      this.countSignal.set(Math.max(0, data.reviewQueueCount));
    } catch {
      // The next navigation retries. An unreadable count leaves the previous value on screen rather
      // than flashing the badge away, which would read as "queue cleared" when it may not be.
    }
  }

  /**
   * Apply a count the server just returned, and report whether the queue *became* empty.
   *
   * The "became" matters: this returns `true` only for the transition, so the caller can show the
   * toast without also having to remember the previous value.
   */
  setCount(next: number): boolean {
    const value = Math.max(0, next);
    const previous = this.countSignal();
    this.countSignal.set(value);

    if (value === 0 && previous > 0 && !this.celebrated) {
      this.celebrated = true;
      return true;
    }
    return false;
  }
}

const REVIEW_QUEUE_COUNT = /* GraphQL */ `
  query ReviewQueueCount {
    reviewQueueCount
  }
`;
