import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** One slice. share is a fraction of the whole, computed by the backend. */
export interface DonutSegment {
  readonly label: string;
  readonly share: number;
  /** A CSS colour — a --chart-N token from the caller, so the ring follows the theme. */
  readonly color: string;
}

/**
 * The spending-by-category ring.
 *
 * ## Why the geometry is what it is
 *
 * Drawn as <circle> elements with pathLength="100", so **every dash length is already a percentage**
 * of the circumference and the component never has to know the radius. That removes the classic
 * donut-chart bug class: an arc computed from Math.PI that lands a degree off for one radius, and a
 * gap that shrinks as the data grows.
 *
 * Each slice is offset by the **sum of the ones before it**, not by an incremental rotation, because
 * incremental accumulation is where rounding drift accumulates and the last slice ends up overlapping
 * the first.
 *
 * ## What it refuses to do
 *
 * The shares are the server's (CategorySpendModel.shareOfTotal) and are never recomputed here from
 * amounts (ADR-001, ADR-003). A slice with no share draws nothing rather than a hairline segment that
 * reads as "a small amount" when the truth is "none".
 */
@Component({
  selector: 'fm-donut',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap" [style.inline-size.px]="size()" [style.block-size.px]="size()">
      <svg
        viewBox="0 0 100 100"
        [attr.width]="size()"
        [attr.height]="size()"
        role="img"
        [attr.aria-label]="summary()"
      >
        <!-- The track: a full ring in the sunken colour, so an empty month reads as an empty ring
             rather than as a missing chart. -->
        <circle
          class="track"
          cx="50"
          cy="50"
          [attr.r]="radius()"
          [attr.stroke-width]="thickness()"
          pathLength="100"
        />
        @for (segment of drawn(); track segment.label) {
          <circle
            class="slice"
            cx="50"
            cy="50"
            [attr.r]="radius()"
            [attr.stroke-width]="thickness()"
            [attr.stroke]="segment.color"
            pathLength="100"
            [style.stroke-dasharray]="segment.dash"
            [style.stroke-dashoffset]="segment.offset"
          />
        }
      </svg>

      @if (centerValue()) {
        <div class="center">
          @if (centerLabel()) {
            <span class="center__label">{{ centerLabel() }}</span>
          }
          <span class="center__value">{{ centerValue() }}</span>
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .wrap {
        position: relative;
        display: grid;
        place-items: center;
        flex: none;
      }
      svg {
        display: block;
        /* Start the first slice at twelve o'clock rather than at three, which is what a reader expects
           of a ring of money. */
        transform: rotate(-90deg);
      }
      circle {
        fill: none;
      }
      .track {
        stroke: var(--color-surface-sunken);
      }
      .slice {
        /* butt, not round: a rounded cap lengthens every slice by half the stroke width at each end,
           so the slices would overlap by half a percent each and the ring would close early. */
        stroke-linecap: butt;
        /* A slice must never sit under the pointer: the legend is the interactive element. */
        pointer-events: none;
        transition: stroke-dasharray var(--motion-base) ease;
      }
      .center {
        position: absolute;
        display: grid;
        justify-items: center;
        gap: 0.15rem;
        text-align: center;
        padding-inline: 22%;
      }
      .center__label {
        color: var(--color-text-muted);
        font-size: var(--text-xs);
      }
      .center__value {
        font-size: var(--text-lg);
        font-weight: var(--weight-semibold);
        font-variant-numeric: tabular-nums;
      }
    `,
  ],
})
export class DonutComponent {
  readonly segments = input.required<readonly DonutSegment[]>();

  readonly size = input(180);

  /** Ring thickness in the 100-unit box, so it scales with size. */
  readonly thickness = input(11);

  readonly centerLabel = input('');

  /** Rendered as-is: the caller passes an already-formatted fm-money string, never a raw number. */
  readonly centerValue = input('');

  /** One sentence naming the ring, for a reader who cannot see it. */
  readonly summary = input.required<string>();

  protected readonly radius = computed(() => 50 - this.thickness() / 2 - 1);

  /**
   * The slices, as dash arrays.
   *
   * GAP is taken out of each arc and **added to its offset**, so the gap belongs to nobody and the
   * slices never creep. With one segment the gap is skipped entirely: a ring with a single category is
   * a full circle, and cutting a notch out of it would look like missing data.
   */
  protected readonly drawn = computed(() => {
    const segments = this.segments().filter((segment) => segment.share > 0);
    if (segments.length === 0) return [];

    const Gap = segments.length === 1 ? 0 : 1.6;
    let cursor = 0;

    return segments.map((segment) => {
      const length = segment.share * 100;
      const dash = `${Math.max(length - Gap, 0.4)} ${100 - Math.max(length - Gap, 0.4)}`;
      const offset = -cursor;
      cursor += length;
      return { label: segment.label, color: segment.color, dash, offset };
    });
  });
}
