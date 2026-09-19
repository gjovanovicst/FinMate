import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';

/**
 * One plotted series.
 *
 * token is a CSS colour token name — --chart-income, --chart-1 — so the chart follows the theme
 * instead of freezing a hex value, and the two themes' ramps stay the token layer's business.
 */
export interface BarSeries {
  readonly key: string;
  readonly label: string;
  readonly token: string;
}

/**
 * One x-axis bucket.
 *
 * values[].value is a **drawing coordinate**, and display is what a reader sees. The split is
 * deliberate: the chart scales by the maximum, which is arithmetic on a magnitude, while every figure a
 * person reads is a string the caller already formatted (ADR-003 — currency is formatted in exactly one
 * place, and it is not here).
 */
export interface BarBucket {
  readonly label: string;
  readonly shortLabel: string;
  /** One sentence naming the bucket and every value in it, for a reader who cannot see the bars. */
  readonly ariaLabel: string;
  readonly values: readonly { readonly key: string; readonly value: number; readonly display: string }[];
}

/**
 * The grouped income/expense chart.
 *
 * Two bars per bucket, one axis, one tooltip — the shape the dashboard's "Monthly overview" needs. It is
 * deliberately the mockup's visual grammar: green income beside violet expense and a tooltip that names
 * the bucket and both figures.
 *
 * ## Interaction, and why the keyboard half is not optional
 *
 * The tooltip follows the pointer **and** the keyboard. Each bucket is a focusable group carrying its own
 * accessible label, so a keyboard user hears the same two figures the tooltip shows — a chart that can
 * only be read with a mouse is a chart that half the users cannot read at all. The tooltip is decoration
 * on top of that label, which is why it is role="presentation".
 */
@Component({
  selector: 'fm-bar-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <figure class="chart">
      @if (series().length > 0) {
        <figcaption class="legend">
          @for (item of series(); track item.key) {
            <span class="legend__item">
              <span class="legend__dot" [style.background]="'var(' + item.token + ')'"></span>
              {{ item.label }}
            </span>
          }
        </figcaption>
      }

      <div class="plot" [style.min-block-size.px]="height()">
        @for (line of gridLines; track line) {
          <span class="plot__grid" [style.inset-block-start.%]="line"></span>
        }

        <div class="bars">
          @for (bucket of drawn(); track bucket.label; let index = $index) {
            <div
              class="bucket"
              tabindex="0"
              role="group"
              [attr.aria-label]="bucket.ariaLabel"
              (pointerenter)="hovered.set(index)"
              (pointerleave)="clear(index)"
              (focus)="hovered.set(index)"
              (blur)="clear(index)"
            >
              @for (bar of bucket.bars; track bar.key) {
                <span
                  class="bar"
                  [style.block-size.%]="bar.height"
                  [style.background]="'var(' + bar.token + ')'"
                ></span>
              }

              @if (hovered() === index) {
                <span class="tip" role="presentation">
                  <span class="tip__label">{{ bucket.label }}</span>
                  @for (row of bucket.tooltip; track row.key) {
                    <span class="tip__row">
                      <span class="tip__dot" [style.background]="'var(' + row.token + ')'"></span>
                      {{ row.label }}
                    </span>
                  }
                </span>
              }
            </div>
          }
        </div>
      </div>

      <div class="axis" aria-hidden="true">
        @for (bucket of drawn(); track bucket.label; let index = $index) {
          <!-- Only every nth bucket is labelled. Thirty daily buckets in a 500 px plot is a label every
               17 px, which renders as a smear of clipped digits (measured on the 1280 px capture); the
               tick mode is what the reference's own axis does. Every bucket still has its exact figure
               in its accessible label and its tooltip. -->
          <span class="axis__label">{{ labelled(index) ? bucket.shortLabel : '' }}</span>
        }
      </div>
    </figure>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .chart {
        margin: 0;
        display: grid;
        /* The legend, the plot, the axis. The plot takes the free height, so a card that is taller than
           the plot's floor shows taller bars rather than a band of empty card below them — which is what
           the dashboard's 1920 px capture showed, with the donut panel beside it setting the row height. */
        grid-template-rows: auto minmax(0, 1fr) auto;
        block-size: 100%;
        gap: var(--space-3);
      }
      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-4);
        justify-content: flex-end;
        font-size: var(--text-xs);
        color: var(--color-text-muted);
      }
      .legend__item {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
      }
      .legend__dot {
        inline-size: 0.5rem;
        block-size: 0.5rem;
        border-radius: var(--radius-pill);
      }
      .plot {
        position: relative;
        display: grid;
        align-items: end;
        /* Grown by the row above; min-block-size comes from the height input, so a caller still
           states the floor it wants and the card decides whether there is more to give. */
        min-block-size: 6rem;
      }
      /* The axis floor: without it a chart whose bars all sit at 0 looks identical to an empty one. */
      .plot::after {
        content: '';
        position: absolute;
        inset-block-end: 0;
        inset-inline: 0;
        block-size: 1px;
        background: var(--chart-grid);
      }
      .plot__grid {
        position: absolute;
        inset-inline: 0;
        block-size: 1px;
        background: var(--chart-grid);
      }
      .bars {
        position: relative;
        display: flex;
        align-items: end;
        gap: 2px;
        block-size: 100%;
      }
      .bucket {
        position: relative;
        display: flex;
        align-items: end;
        justify-content: center;
        gap: 2px;
        flex: 1 1 0;
        min-inline-size: 0;
        block-size: 100%;
        border-radius: var(--radius-xs);
      }
      /* A focus ring on a bar column, not on the whole chart: the ring marks which bucket is being read,
         which is the same thing the tooltip marks. */
      .bucket:focus-visible {
        box-shadow: var(--focus-ring);
      }
      .bar {
        inline-size: 42%;
        max-inline-size: 0.5rem;
        min-block-size: 2px;
        border-radius: var(--radius-xs) var(--radius-xs) 2px 2px;
        transition: block-size var(--motion-base) ease;
      }
      .tip {
        position: absolute;
        inset-block-end: calc(100% + var(--space-2));
        inset-inline-start: 50%;
        transform: translateX(-50%);
        z-index: 2;
        display: grid;
        gap: 2px;
        padding: var(--space-2) var(--space-3);
        background: var(--chart-tooltip-bg);
        color: var(--chart-tooltip-ink);
        border-radius: var(--radius-sm);
        box-shadow: var(--shadow-2);
        font-size: var(--text-xs);
        white-space: nowrap;
        pointer-events: none;
      }
      .tip__label {
        font-weight: var(--weight-semibold);
      }
      .tip__row {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .tip__dot {
        inline-size: 0.4rem;
        block-size: 0.4rem;
        border-radius: var(--radius-pill);
      }
      .axis {
        display: flex;
        gap: 2px;
        color: var(--chart-axis);
        font-size: var(--text-xs);
      }
      .axis__label {
        flex: 1 1 0;
        min-inline-size: 0;
        text-align: center;
        /* No overflow: hidden here. A labelled tick sits under its own bucket, and hiding the overflow
           clipped "10" to "1" — the axis read as a smear of single digits (measured on the 1280 px
           capture). An unlabelled bucket renders an empty span, so the ticks that remain have room. */
        white-space: nowrap;
      }
    `,
  ],
})
export class BarChartComponent {
  readonly buckets = input.required<readonly BarBucket[]>();

  readonly series = input<readonly BarSeries[]>([]);

  readonly height = input(180);

  /** 0–100, where the gridlines sit. Four lines reads as a scale; more reads as a grid. */
  protected readonly gridLines = [0, 25, 50, 75];

  protected readonly hovered = signal<number | null>(null);

  /**
   * Whether a bucket's tick is drawn.
   *
   * At most ~8 ticks across the plot: the labels are read as a scale, not as thirty values. The step is
   * computed from the bucket count rather than fixed, so a 7-day week labels every day and a 31-day
   * month labels every fifth.
   */
  protected labelled(index: number): boolean {
    const count = this.buckets().length;
    if (count <= 10) return true;
    const step = Math.ceil(count / 8);
    return index % step === 0;
  }

  protected clear(index: number): void {
    if (this.hovered() === index) this.hovered.set(null);
  }

  /**
   * The buckets with geometry attached.
   *
   * The maximum is taken across **every** value of every bucket, so the two series in a group share one
   * scale and a bar cannot be compared against a differently-scaled neighbour. A series that is entirely
   * zero draws its 2 px floor rather than collapsing, so a month with no income still shows the expense
   * bars beside an empty column instead of hiding them.
   */
  protected readonly drawn = computed(() => {
    const max = Math.max(
      0,
      ...this.buckets().flatMap((bucket) => bucket.values.map((value) => value.value)),
    );
    const tokens = new Map(this.series().map((item) => [item.key, item.token]));
    const labels = new Map(this.series().map((item) => [item.key, item.label]));

    return this.buckets().map((bucket) => ({
      label: bucket.label,
      shortLabel: bucket.shortLabel,
      ariaLabel: bucket.ariaLabel,
      bars: bucket.values.map((value) => ({
        key: value.key,
        token: tokens.get(value.key) ?? '--chart-1',
        height: max === 0 ? 0 : (value.value / max) * 100,
      })),
      tooltip: bucket.values.map((value) => ({
        key: value.key,
        token: tokens.get(value.key) ?? '--chart-1',
        label: `${labels.get(value.key) ?? value.key}: ${value.display}`,
      })),
    }));
  });
}
