/**
 * The header's combined offline chip: the queue's count and the snapshot's provenance, at every size.
 *
 * ADR-026 decision 1 corrects docs/07 §6's "badge count on the nav": docs/02 §2.3 keeps the review slot
 * as the **only** badged destination, so a queue that is usually empty must not dilute it. ADR-027
 * decision 5 completes the chip docs/02 §2.2 draws — the *same* element carries both states: the
 * pending half is `Čeka slanje (n)` and links to `/pending`, the stale half is `podaci od <time>` and
 * is a **disclosure, not a link**. It renders nothing while neither holds, and it sits in the shell
 * header (docs/02 §2.2), which is drawn for every authenticated route at every width, so neither a
 * pending capture nor a stale figure is ever hidden behind a breakpoint.
 *
 * @module apps/web/src/app/shared/ui/sync-chip
 */
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { I18nService } from '../../../core/i18n/i18n.service';
import { SnapshotService } from '../../../core/offline/snapshot.service';
import { syncedAtLabel } from '../../../core/offline/sync.view';
import { SyncService } from '../../../core/offline/sync.service';

@Component({
  selector: 'fm-sync-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    @if (sync.pendingCount() > 0 || staleLabel() !== null) {
      <span class="chip">
        @if (sync.pendingCount() > 0) {
          <a
            class="chip__pending"
            routerLink="/pending"
            routerLinkActive="chip--active"
            [attr.aria-label]="label()"
          >
            {{ i18n.t('sync.chip', { count: sync.pendingCount() }) }}
          </a>
        }
        @if (staleLabel(); as asOf) {
          @if (sync.pendingCount() > 0) {
            <span class="chip__gap" aria-hidden="true">·</span>
          }
          <span class="chip__stale">{{ i18n.t('money.asOf', { time: asOf }) }}</span>
        }
      </span>
    }
  `,
  styles: [
    `
      /* Wrapping text rather than a fixed label: at 320 px the header has three other controls and a
         chip that refuses to shrink pushes the whole bar into horizontal scroll (docs/02 §9). */
      .chip {
        display: inline-flex;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--space-1);
        max-inline-size: 100%;
        padding: var(--space-1) var(--space-2);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        color: var(--color-text-muted);
        font-size: var(--text-xs);
        line-height: 1.2;
        overflow-wrap: anywhere;
      }
      /* The pending half is the link to the tray (ADR-026 decision 1). */
      .chip__pending {
        color: inherit;
        text-decoration: none;
      }
      .chip__pending:hover,
      .chip__pending.chip--active {
        color: var(--color-text);
        text-decoration: underline;
      }
      /* The stale half is a disclosure: it says when the figures are from, and goes nowhere. */
      .chip__stale {
        color: inherit;
        font-style: italic;
      }
    `,
  ],
})
export class SyncChipComponent {
  readonly i18n = inject(I18nService);
  readonly sync = inject(SyncService);
  private readonly snapshot = inject(SnapshotService);

  /** The snapshot's `podaci od <time>` time, or `null` while the figures on screen are live. */
  readonly staleLabel = computed(() => {
    const syncedAt = this.snapshot.staleAt();
    return syncedAt === null ? null : syncedAtLabel(syncedAt, this.i18n.tag());
  });

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
