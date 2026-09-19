import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { I18nService } from '../../../core/i18n/i18n.service';
import type { TranslationKey } from '../../../core/i18n/translations';

/**
 * The list-shaped loading skeleton: a shimmering avatar disc with two text lines beside it.
 *
 * It exists because the app had two ways to say "a read is in flight" and neither was good. Most
 * screens printed `<p class="muted">Loading…</p>` — a sentence where the answer is about to be, which
 * makes the page jump when the rows land (docs/09 §8 asks for the state, not a placeholder for it).
 * Two screens hand-rolled their own skeleton, so the same idea shipped twice with different spacing.
 * A shared component is the ADR-039 argument applied to loading: the row it stands in for has an
 * avatar on the screens that have one, and the disc is what makes the placeholder read as a row
 * rather than as a broken paragraph.
 *
 * What it is **not**: a decoration that outlives its request. `ui-avatar-loader` renders only while
 * `loading()` is true in the caller — a skeleton shown after the answer arrived is a lie with a nicer
 * costume (`styles.css`'s own note on `.fm-skeleton`). It owns no data and knows nothing about what
 * it is waiting for, which is what lets one component serve the ledger, the merchant list and the
 * analytics panels without a variant per screen.
 *
 * The animation is `.fm-skeleton`'s global shimmer, so `prefers-reduced-motion` (styles.css) already
 * stills it; nothing here needs its own media query.
 */
@Component({
  selector: 'fm-avatar-loader',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="loader" role="status">
      <!-- The words, for a screen reader. The discs are aria-hidden: a skeleton is a picture of
           content, and announcing five of them is noise. -->
      <span class="fm-visually-hidden">{{ i18n.t(labelKey()) }}</span>
      <ul class="rows" aria-hidden="true">
        @for (placeholder of placeholders(); track placeholder) {
          <li class="row" [class.row--card]="variant() === 'card'">
            <span
              class="disc fm-skeleton"
              [style.inline-size.px]="size()"
              [style.block-size.px]="size()"
            ></span>
            <span class="lines">
              <span class="line fm-skeleton" [style.inline-size.%]="nameWidth(placeholder)"></span>
              <span
                class="line line--meta fm-skeleton"
                [style.inline-size.%]="metaWidth(placeholder)"
              ></span>
            </span>
          </li>
        }
      </ul>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .rows {
        display: grid;
        gap: var(--space-3);
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .row {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        min-inline-size: 0;
      }
      /* The card variant is for a screen whose loaded rows are each their own surface (accounts,
         budgets, notifications): a bare row there would promise a layout the answer does not have. */
      .row--card {
        padding: var(--space-4);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        background: var(--color-surface-raised);
      }
      .disc {
        flex: none;
        /* The avatar's own radius, so the placeholder and the disc it anticipates share a silhouette. */
        border-radius: var(--radius-md);
      }
      .lines {
        display: grid;
        gap: var(--space-2);
        flex: 1;
        min-inline-size: 0;
      }
      .line {
        block-size: 0.7rem;
        border-radius: var(--radius-pill);
      }
      .line--meta {
        block-size: 0.6rem;
      }
    `,
  ],
})
export class AvatarLoaderComponent {
  readonly i18n = inject(I18nService);

  /** How many placeholder rows to draw. Clamped: a caller asking for 500 is a bug, not a request. */
  readonly rows = input(5);

  /** The disc's size in px, matched to the `fm-avatar` it stands in for. */
  readonly size = input(36);

  /** `card` when each loaded row is its own surface; `plain` when the rows share one. */
  readonly variant = input<'plain' | 'card'>('plain');

  /**
   * The spoken status.
   *
   * Defaults to the generic key, and a caller with a more specific sentence ("Reading the queue…")
   * passes its own — the words were already written, and a downgrade to "Loading…" would be a
   * regression in what a screen-reader user is told.
   */
  readonly labelKey = input<TranslationKey>('loader.rows');

  protected readonly placeholders = computed(() => {
    const count = Math.min(Math.max(Math.trunc(this.rows()), 1), 12);
    return Array.from({ length: count }, (_, index) => index);
  });

  /**
   * Deterministic line widths.
   *
   * Two identical rows look like a table; a little variation looks like content. It is computed from
   * the index rather than `Math.random()` on purpose: a random width would change on every change
   * detection pass, so the skeleton would twitch while it waits.
   */
  protected nameWidth(index: number): number {
    return 52 + ((index * 17) % 34);
  }

  protected metaWidth(index: number): number {
    return 28 + ((index * 11) % 22);
  }
}
