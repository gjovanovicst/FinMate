import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';

import { I18nService } from '../../../core/i18n/i18n.service';

/**
 * The product's mark and wordmark.
 *
 * Extracted because three places draw it — the sidebar, the compact topbar and the auth screens' front
 * door — and they must not be three copies of an inline SVG. The same reasoning that put the consent
 * disclosure in one component (`ui-consent-purpose`): a second copy is how the two drift, and a brand
 * is the thing drift is most visible on.
 *
 * The **name comes from the catalogue** (`app.name`, ADR-014), never from a literal, so a rename is one
 * commit. The mark is inline SVG rather than an asset so it scales from 28 px to 36 px, inherits the
 * brand gradient and costs no request in an offline-first app.
 *
 * It is not a link. The sidebar wraps it in a `routerLink` to the dashboard and the auth screens do not
 * link it at all (there is nowhere to go from a sign-in form), so the destination belongs to the caller.
 */
@Component({
  selector: 'fm-brand',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="brand" [class.brand--lg]="size() === 'lg'">
      <span class="brand__mark" aria-hidden="true">
        <svg viewBox="0 0 32 32" fill="none">
          <path
            d="M9 22.5c0-6.4 4.6-11 11.4-11.6M9 22.5c5.9 1.2 11.4-1.6 13.6-6.6"
            stroke="currentColor"
            stroke-width="2.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </span>
      <span class="brand__text">
        <span class="brand__name">{{ i18n.t('app.name') }}</span>
        @if (tagline()) {
          <span class="brand__tagline">{{ i18n.t('app.tagline') }}</span>
        }
      </span>
    </span>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        min-inline-size: 0;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        min-inline-size: 0;
      }
      .brand__mark {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        inline-size: 2.25rem;
        block-size: 2.25rem;
        flex: none;
        border-radius: var(--radius-md);
        background: var(--gradient-brand);
        color: var(--color-primary-contrast);
        box-shadow: var(--shadow-glow);
      }
      .brand--lg .brand__mark {
        inline-size: 2.75rem;
        block-size: 2.75rem;
        border-radius: var(--radius-lg);
      }
      .brand__mark svg {
        inline-size: 1.6rem;
        block-size: 1.6rem;
      }
      .brand--lg .brand__mark svg {
        inline-size: 1.9rem;
        block-size: 1.9rem;
      }
      .brand__text {
        display: grid;
        gap: var(--space-1);
        min-inline-size: 0;
        text-align: start;
      }
      .brand__name {
        font-size: var(--text-lg);
        font-weight: var(--weight-bold);
        letter-spacing: var(--tracking-tight);
        line-height: 1.15;
      }
      .brand--lg .brand__name {
        font-size: var(--text-xl);
      }
      .brand__tagline {
        color: var(--color-text-subtle);
        font-size: var(--text-xs);
        /* Decoration: it must never widen the sidebar or the auth card. */
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ],
})
export class BrandComponent {
  readonly i18n = inject(I18nService);

  /** `lg` on the auth screens, where there is room for a bigger mark; `md` in the shell. */
  readonly size = input<'md' | 'lg'>('md');

  readonly tagline = input(true);
}
