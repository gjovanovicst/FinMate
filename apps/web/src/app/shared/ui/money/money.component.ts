import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { balance, formatBalance } from '@finmate/domain';

/**
 * The Money on the wire (docs/06 §1).
 *
 * `amountMinor` is a **string** so a large balance cannot be rounded by `JSON.parse` on the way in.
 */
export interface MoneyWire {
  readonly amountMinor: string;
  readonly currency: string;
}

export type MoneyDirection = 'INCOME' | 'EXPENSE' | 'NEUTRAL';

/**
 * Render Money. The single place in the client where currency is formatted (ADR-003).
 *
 * Why this is a correctness control and not styling: currency formatting done ad hoc at each call
 * site is how you get a screen where `2.000,00 RSD` and `2000 RSD` appear side by side, or where
 * someone divides by 100 twice. Formatting lives in `@finmate/domain` (already property-tested);
 * this component converts the wire shape and renders the result. Nothing else may format Money.
 *
 * **Direction is a sign and a label, never a colour.** Colouring expenses red and income green would
 * collide with `--color-danger`/`--color-success`, which are reserved for validation and the
 * ADR-009 confidence bands (docs/13 §9). It would also imply a judgement the product has no
 * business making about a transfer or a refund.
 */
@Component({
  selector: 'fm-money',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      class="amount"
      [class.amount--signed]="showSign()"
      [attr.aria-label]="accessibleLabel()"
      role="text"
    >
      <!-- The sign is decorative: the accessible label already says "prihod"/"trošak", and a
           screen reader announcing "minus two thousand" for income would be wrong. -->
      @if (showSign()) {
        <span class="amount__sign" aria-hidden="true">{{ signGlyph() }}</span>
      }
      <span class="amount__value" aria-hidden="true">{{ formatted() }}</span>
    </span>
  `,
  styles: [
    `
      .amount {
        /* Tabular figures: proportional digits make a column of amounts jitter as values change. */
        font-variant-numeric: tabular-nums;
        font-feature-settings: 'tnum';
        white-space: nowrap;
        color: inherit;
      }
      .amount--signed .amount__sign {
        margin-inline-end: 0.15em;
      }
    `,
  ],
})
export class MoneyComponent {
  /** The value to render. Required: a Money component with no amount is a bug, not a state. */
  readonly amount = input.required<MoneyWire>();

  /**
   * Which way the money moved. Purely for an optional sign — it never changes colour.
   * Defaults to `NEUTRAL` so an unrecognised value renders the amount rather than hiding it.
   */
  readonly direction = input<MoneyDirection>('NEUTRAL');

  /** Show a `+`/`−` prefix. Defaults on for anything but `NEUTRAL`. */
  readonly sign = input<boolean | undefined>(undefined);

  /** BCP-47 locale. Serbian latin by default; the app ships latn and cyrl variants (ADR-019). */
  readonly locale = input<string>('sr-Latn-RS');

  readonly showSign = computed(() => this.sign() ?? this.direction() !== 'NEUTRAL');

  readonly signGlyph = computed(() => (this.direction() === 'INCOME' ? '+' : '−'));

  /**
   * A malformed amount renders as a visible placeholder rather than `NaN` or a silently wrong
   * number. A finance app that shows a plausible but wrong figure is worse than one that shows it
   * could not read the value.
   *
   * Rendering uses the **signed** formatter. For a non-negative value the output is identical, and
   * for a negative one it shows the minus instead of the placeholder — which matters because a
   * derived Balance (an overdraft, a credit card) is legitimately negative. The Money/Balance
   * distinction is enforced where it belongs, on the write path and in the domain arithmetic; a
   * view component's job is to render what the server sent, not to re-litigate it.
   */
  readonly formatted = computed(() => {
    const { amountMinor, currency } = this.amount();
    try {
      return formatBalance(balance(BigInt(amountMinor), currency), this.locale());
    } catch {
      return '—';
    }
  });

  /** Spoken form: screen readers handle "2.000 RSD" poorly, so spell out the direction too. */
  readonly accessibleLabel = computed(() => {
    const spoken = this.direction() === 'INCOME' ? 'prihod' : this.direction() === 'EXPENSE' ? 'trošak' : '';
    return spoken ? `${this.formatted()} (${spoken})` : this.formatted();
  });
}
