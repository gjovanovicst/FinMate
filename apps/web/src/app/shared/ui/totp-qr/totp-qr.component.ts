import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { I18nService } from '../../../core/i18n/i18n.service';
import { qrDataUrl } from './qr';

/**
 * The authenticator QR code (ADR-041, ADR-042).
 *
 * Renders the `otpauth://` URI the API returns as an `<img>` whose `src` **is** the data URL
 * `qrcode-generator` produces. That is deliberate on three counts:
 *
 *  - It is a **real image**, so a phone's camera and every screen reader treat it as one, and the
 *    alternative — injecting the library's SVG string — would need a sanitizer bypass, which is a
 *    hole nobody needs for a picture.
 *  - It is generated **client-side from the server's own URI**: no secret is sent anywhere, and the
 *    code exists only in this component while the setup is on screen.
 *  - `qrcode-generator` has **no dependencies** and ships types (ADR-042), so this is one package
 *    rather than a tree of them for a feature used on one screen.
 *
 * The secret is always shown as text beside it too: a QR code alone fails for a desktop browser, for
 * a screen reader, and for every authenticator app that offers manual entry.
 *
 * @module apps/web/src/app/shared/ui/totp-qr
 */
@Component({
  selector: 'fm-totp-qr',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <img
      class="qr"
      [src]="dataUrl()"
      [attr.alt]="i18n.t('mfa.qrAlt')"
      width="212"
      height="212"
    />
  `,
  styles: `
    /* The generated image is a GIF, which is block-level content with no intrinsic styling worth
       keeping: the white quiet zone is baked in by the generator's margin, so the only thing here is
       the rounded frame the rest of the app's cards use. */
    .qr {
      display: block;
      inline-size: 212px;
      block-size: 212px;
      padding: var(--space-2);
      background: #fff;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
    }
  `,
})
export class TotpQrComponent {
  readonly i18n = inject(I18nService);

  /**
   * The `otpauth://` URI to encode.
   *
   * A default of `''` rather than `input.required`, and the difference is not cosmetic: the template's
   * first render happens as soon as the component exists, and a required signal input read before the
   * parent's binding arrives throws. An empty URI simply renders no image — the setup panel is only
   * created with one anyway, so this is a guard rather than a state the screen ever shows.
   */
  readonly uri = input<string>('');

  /**
   * The QR as a data URL.
   *
   * Type number 0 lets the generator pick the smallest version that fits; error-correction level `M`
   * is the usual trade (about 15 % recoverable) and keeps the code small enough to scan from a
   * laptop screen.
   */
  readonly dataUrl = computed(() => qrDataUrl(this.uri()));
}
