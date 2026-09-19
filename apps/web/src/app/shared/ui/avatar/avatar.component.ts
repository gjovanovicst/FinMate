import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Initials on a tinted disc — the mockup's row marker for a merchant, a person or an account.
 *
 * Initials rather than a logo: the app has no merchant artwork, and a generated identicon for a shop
 * called "Lidl" would be noise pretending to be a brand. The disc's **tint is derived from the name**, so
 * the same merchant keeps the same colour on every screen without anything being stored — which is also
 * why it is not a token per merchant.
 *
 * The label is opt-in like fm-icon's: a row whose text already names the merchant does not need the
 * disc announced.
 */
@Component({
  selector: 'fm-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      class="disc"
      [style.inline-size.px]="size()"
      [style.block-size.px]="size()"
      [style.--fm-avatar-tint]="tint()"
      [style.font-size.px]="size() * 0.4"
      [attr.aria-hidden]="label() ? null : 'true'"
      [attr.aria-label]="label()"
      [attr.role]="label() ? 'img' : null"
    >
      {{ initials() }}
    </span>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
      }
      .disc {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: none;
        border-radius: var(--radius-md);
        background: color-mix(in srgb, var(--fm-avatar-tint) 18%, transparent);
        color: var(--fm-avatar-tint);
        font-weight: var(--weight-semibold);
        letter-spacing: 0.01em;
        text-transform: uppercase;
        user-select: none;
      }
    `,
  ],
})
export class AvatarComponent {
  /** The name the initials and the tint come from. */
  readonly name = input.required<string>();

  readonly size = input(36);

  /** An accessible name, when the disc is the only thing that identifies the row. */
  readonly label = input<string | undefined>(undefined);

  /**
   * Up to two initials.
   *
   * Splits on whitespace and takes the first letter of the first two words, which is right for both
   * "Lidl" (one letter) and "Dejan rođa" (two). Digits are kept: "24/7 shop" has no other handle.
   */
  readonly initials = computed(() => {
    const words = this.name()
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 0);
    if (words.length === 0) return '?';

    const letters = words.slice(0, 2).map((word) => [...word][0] ?? '');
    return letters.join('');
  });

  /**
   * A stable hue from the name.
   *
   * --chart-N rather than a raw hue: the eight chart colours are picked to be distinguishable and to
   * work on both themes, so a hash into them stays inside the palette instead of inventing a colour that
   * fails contrast on one of the two backgrounds.
   */
  readonly tint = computed(() => {
    const name = this.name();
    let hash = 0;
    for (const character of name) hash = (hash * 31 + character.codePointAt(0)!) % 100_000;

    return `var(--chart-${(hash % 7) + 1})`;
  });
}
