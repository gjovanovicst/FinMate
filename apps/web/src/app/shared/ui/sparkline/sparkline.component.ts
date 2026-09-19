import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type SparklineVariant = 'bars' | 'line';

/**
 * The number series behind one variant of a chart.
 *
 * label is the accessible name of the series (docs/07: every chart is announced, because a chart that
 * is a picture of money is content). It is a translated string the caller supplies.
 */
export interface SparkPoint {
  readonly value: number;
  readonly label: string;
}

/** The drawing box every sparkline is computed in, whatever its rendered size. */
const WIDTH = 100;
const HEIGHT = 32;
/** A bar's floor, so a zero bucket still draws a mark instead of vanishing. */
const MIN_BAR = 1;

/**
 * A tiny inline chart for a KPI tile: the shape of a month in about 20 lines of SVG.
 *
 * Deliberately **not** a charting dependency (ADR-004 wants an ADR before one) and deliberately not a
 * full chart: it has no axes, no labels and no legend, because the tile's own number is the message and
 * this only shows the shape. Anything that needs to be read precisely is fm-bar-chart or the analytics
 * screen, where the same data carries axis labels.
 *
 * The series is normalised to its own maximum, which is the honest reading of "shape": two tiles with
 * different magnitudes are still comparable in silhouette. The absolute figure is on the tile.
 */
@Component({
  selector: 'fm-sparkline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      [attr.viewBox]="'0 0 ' + width + ' ' + boxHeight"
      preserveAspectRatio="none"
      [attr.height]="height()"
      fill="none"
      role="img"
      [attr.aria-label]="summary()"
    >
      @if (variant() === 'bars') {
        @for (bar of bars(); track $index) {
          <rect
            [attr.x]="bar.x"
            [attr.y]="bar.y"
            [attr.width]="bar.width"
            [attr.height]="bar.height"
            [attr.rx]="1.4"
            [style.fill]="'var(' + fill() + ')'"
            [attr.opacity]="bar.opacity"
          />
        }
      } @else {
        <path
          [attr.d]="line()"
          [style.stroke]="'var(' + fill() + ')'"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          vector-effect="non-scaling-stroke"
        />
      }
    </svg>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      svg {
        display: block;
        inline-size: 100%;
        overflow: visible;
      }
    `,
  ],
})
export class SparklineComponent {
  readonly points = input.required<readonly SparkPoint[]>();

  readonly variant = input<SparklineVariant>('bars');

  /** A **token name**, so the chart follows the theme instead of freezing a hex value. */
  readonly fill = input('--chart-2');

  readonly height = input(48);

  /**
   * The accessible name of the whole series.
   *
   * One sentence, not a data table: a screen reader gets "Income, last 12 months, trending up" rather
   * than thirty numbers, and the exact figures are already on the tile above it.
   */
  readonly summary = input.required<string>();

  protected readonly width = WIDTH;
  protected readonly boxHeight = HEIGHT;

  /** The maximum **as a number**, used only to normalise the drawing — never to display a figure. */
  private readonly max = computed(() => {
    const values = this.points().map((point) => point.value);
    return values.length === 0 ? 0 : Math.max(...values);
  });

  protected readonly bars = computed(() => {
    const points = this.points();
    if (points.length === 0) return [];

    const max = this.max();
    // Bars share the box with a gap proportional to how many there are, so 8 buckets and 62 buckets
    // both read as a series rather than as a smear.
    const slot = WIDTH / points.length;
    const gap = Math.min(slot * 0.34, 2.2);
    const barWidth = Math.max(slot - gap, 0.5);

    return points.map((point, index) => {
      const ratio = max === 0 ? 0 : point.value / max;
      const height = Math.max(ratio * HEIGHT, MIN_BAR);
      return {
        x: index * slot + gap / 2,
        y: HEIGHT - height,
        width: barWidth,
        height,
        // The most recent bucket is the brightest: it is the one the tile is about.
        opacity: index === points.length - 1 ? 1 : 0.62,
      };
    });
  });

  protected readonly line = computed(() => {
    const points = this.points();
    if (points.length === 0) return '';

    const max = this.max();
    const step = points.length === 1 ? 0 : WIDTH / (points.length - 1);
    // A flat series draws a flat line through the middle rather than along the floor, which would read
    // as "nothing happened" for a month where every day was the same.
    const y = (value: number): number =>
      max === 0 ? HEIGHT / 2 : HEIGHT - (value / max) * (HEIGHT - 3) - 1.5;

    return points
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${(index * step).toFixed(2)} ${y(point.value).toFixed(2)}`)
      .join(' ');
  });
}
