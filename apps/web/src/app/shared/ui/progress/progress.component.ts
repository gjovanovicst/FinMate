import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** The four tones a bar may carry. brand is the default because most bars are progress, not a warning. */
export type ProgressTone = 'brand' | 'success' | 'danger' | 'warning' | 'hero';

/**
 * A progress bar.
 *
 * The **value is a ratio, never money** (ADR-003): the backend computes every figure this draws and
 * hands over a Float where a ratio is what it means (SavingGoalModel.progress, BudgetModel.usedRatio,
 * CategorySpendModel.shareOfTotal). Nothing in the client divides two amounts to fill this bar.
 *
 * A ratio above 1 is possible and is deliberately **not** clamped for the caller's benefit: an overspent
 * budget really is over 100 %, the bar fills, and the number beside it is what says by how much. Capping
 * the width while showing the true figure is the honest combination; capping the figure would not be.
 */
@Component({
  selector: 'fm-progress',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      class="track"
      [class.track--hero]="tone() === 'hero'"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      [attr.aria-valuenow]="percent()"
      [attr.aria-label]="label()"
    >
      <span class="bar" [class]="'bar--' + tone()" [style.inline-size.%]="percent()"></span>
    </span>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .track {
        display: block;
        block-size: 0.5rem;
        border-radius: var(--radius-pill);
        background: var(--color-surface-sunken);
        overflow: hidden;
      }
      /* Inside the gradient hero card the track has to be a translucent white: --color-surface-sunken
         is a page colour and reads as a black slot on a violet card. */
      .track--hero {
        background: rgb(255 255 255 / 26%);
      }
      .bar {
        display: block;
        block-size: 100%;
        border-radius: inherit;
        background: var(--color-primary);
        transition: inline-size var(--motion-base) ease;
      }
      .bar--success {
        background: var(--color-success);
      }
      .bar--danger {
        background: var(--color-danger);
      }
      .bar--warning {
        background: var(--color-warning);
      }
      .bar--hero {
        background: #ffffff;
      }
    `,
  ],
})
export class ProgressComponent {
  /** 0…1. Values above 1 fill the bar; negative values are treated as zero. */
  readonly value = input.required<number>();

  readonly tone = input<ProgressTone>('brand');

  /** The accessible name. A bare bar announces "50 %" with no idea what of. */
  readonly label = input.required<string>();

  readonly percent = computed(() => Math.round(Math.min(Math.max(this.value(), 0), 1) * 100));
}
