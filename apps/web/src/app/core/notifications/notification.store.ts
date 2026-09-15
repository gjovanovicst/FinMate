import { Injectable, inject, signal } from '@angular/core';

import { GraphqlClient } from '../graphql/graphql.client';

/**
 * The unread-notification count, shared by the shell's bell and the notification centre.
 *
 * Same shape and the same reasoning as `ReviewQueueStore`: the count is a shell concern (docs/02 §2.2
 * draws 🔔 in the header on both layouts), so the bell and the screen cannot each own a copy — a screen
 * that marks rows read must be able to tell the bell, and a bell that did not hear about it would keep
 * advertising notifications the user has already seen.
 *
 * ## Why there is no subscription
 *
 * `notificationReceived` is declared in docs/06 §6 and **not built**: the API has no pub/sub transport.
 * Two cheaper mechanisms cover it — a mark-read returns the authoritative count, which
 * {@link setCount} applies, and the shell re-reads on navigation.
 *
 * @module apps/web/src/app/core/notifications
 */
@Injectable({ providedIn: 'root' })
export class NotificationStore {
  private readonly graphql = inject(GraphqlClient);

  private readonly countSignal = signal(0);

  /** Unread notifications for the signed-in user. Never negative, never a guess. */
  readonly count = this.countSignal.asReadonly();

  /** Re-read the count. Failures are deliberately silent — a bell is not worth an error banner. */
  async refresh(): Promise<void> {
    try {
      const data = await this.graphql.query<{ unreadNotificationCount: number }>(UNREAD_COUNT);
      this.countSignal.set(Math.max(0, data.unreadNotificationCount));
    } catch {
      // The next navigation retries; leaving the previous value is better than flashing the bell away,
      // which would read as "you are all caught up" when that may not be true.
    }
  }

  /**
   * Apply a count the server just returned.
   *
   * Called by `markNotificationRead` (which returns the new count, so the bell never needs a second
   * round trip) and by `markAllNotificationsRead` (0 by construction).
   */
  setCount(next: number): void {
    this.countSignal.set(Math.max(0, next));
  }
}

const UNREAD_COUNT = /* GraphQL */ `
  query UnreadNotificationCount {
    unreadNotificationCount
  }
`;
