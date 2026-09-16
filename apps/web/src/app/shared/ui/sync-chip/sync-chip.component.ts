/**
 * The header's sync chip: the queue's count, at every size class, one tap from its tray.
 *
 * ADR-026 decision 1 corrects docs/07 §6's "badge count on the nav": docs/02 §2.3 keeps the review slot
 * as the **only** badged destination, so a queue that is usually empty must not dilute it. The chip
 * renders only while something is queued and links to `/pending` — a route with no nav slot, the same
 * shape as `/notifications`. It sits in the shell header (docs/02 §2.2), which is drawn for every
 * authenticated route at every width, so a pending capture is never hidden behind a breakpoint.
 *
 * @module apps/web/src/app/shared/ui/sync-chip
 */
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { I18nService } from '../../../core/i18n/i18n.service';
import { SyncService } from '../../../core/offline/sync.service';

@Component({
  selector: 'fm-sync-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    @if (sync.pendingCount() > 0) {
      <a
        class="chip"
        routerLink="/pending"
        routerLinkActive="chip--active"
        [attr.aria-label]="label()"
      >
        {{ i18n.t('sync.chip', { count: sync.pendingCount() }) }}
      </a>
    }
  `,
  styles: [
    `
      /* Wrapping text rather than a fixed label: at 320 px the header has three other controls and a
         chip that refuses to shrink pushes the whole bar into horizontal scroll (docs/02 §9). */
      .chip {
        display: inline-flex;
        align-items: center;
        max-inline-size: 100%;
        padding: var(--space-1) var(--space-2);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        color: var(--color-text-muted);
        font-size: var(--text-xs);
        line-height: 1.2;
        text-decoration: none;
        overflow-wrap: anywhere;
      }
      .chip:hover,
      .chip--active {
        color: var(--color-text);
        border-color: var(--color-text-muted);
      }
    `,
  ],
})
export class SyncChipComponent {
  readonly i18n = inject(I18nService);
  readonly sync = inject(SyncService);

  /**
   * The link's accessible name. The visible text already carries the count, but a screen reader reads
   * "Čeka slanje (3)" as a phrase; the label says what the count belongs to (docs/02 §2.3's rule that
   * a count is spoken, not only drawn).
   */
  label(): string {
    const count = this.sync.pendingCount();
    return this.i18n.t('sync.chipLabel', { count });
  }
}
