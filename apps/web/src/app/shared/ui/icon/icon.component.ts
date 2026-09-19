import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { ICONS, isIconName } from './icon-paths';

/**
 * One inline SVG icon.
 *
 * Inline rather than an <img> or a sprite sheet, for three reasons that all show up on this app's
 * screens: it inherits currentColor (so the same icon is a muted nav item, a brand-coloured active one
 * and white inside the gradient hero card without a second file), it needs no extra request in an
 * offline-first app, and it is decoration the template can hide from assistive technology by default.
 *
 * **The label is opt-in, and that is the important default.** An icon is decoration when the text beside
 * it already says the thing — a nav item labelled "Budgets" does not need a screen reader to hear
 * "budgets icon" first. Only a control whose *entire* meaning is the glyph (the theme toggle, the bell)
 * passes label, and then the icon becomes an accessible name instead of a hidden node.
 */
@Component({
  selector: 'fm-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (paths().length > 0) {
      <svg
        [attr.width]="size()"
        [attr.height]="size()"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        [attr.stroke-width]="strokeWidth()"
        stroke-linecap="round"
        stroke-linejoin="round"
        [attr.aria-hidden]="label() ? null : 'true'"
        [attr.aria-label]="label()"
        [attr.role]="label() ? 'img' : null"
        focusable="false"
      >
        @for (d of paths(); track d) {
          <path [attr.d]="d" />
        }
      </svg>
    }
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        /* The glyph must not add baseline leading: an inline SVG sits on the text baseline, and a
           line-height inherited from a heading pushes the whole row down by a few pixels. */
        line-height: 0;
      }
      svg {
        display: block;
        /* A hair under 2 keeps the strokes from filling in at 16 px, where a 2 px stroke on a 24-unit
           grid closes the gaps in the settings gear and the piggy bank. */
        flex: none;
      }
    `,
  ],
})
export class IconComponent {
  /** Which icon. An unknown name renders nothing rather than a broken box. */
  readonly name = input.required<string>();

  /** Edge length in px. 20 in body rows, 18 in dense chrome, 24 in a card header. */
  readonly size = input(20);

  readonly strokeWidth = input(1.75);

  /** The accessible name. Omit for a decorative icon that sits beside its own text label. */
  readonly label = input<string | undefined>(undefined);

  readonly paths = computed<readonly string[]>(() => {
    const name = this.name();
    return isIconName(name) ? ICONS[name] : [];
  });
}
