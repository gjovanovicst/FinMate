import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { I18nService } from '../../core/i18n/i18n.service';

@Component({
  selector: 'fm-not-found',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <section class="nf">
      <h1 class="nf__title">{{ i18n.t('notFound.title') }}</h1>
      <p class="nf__body">{{ i18n.t('notFound.body') }}</p>
      <a class="fm-btn fm-btn--primary nf__cta" routerLink="/">{{ i18n.t('notFound.cta') }}</a>
    </section>
  `,
  styles: [
    `
      .nf {
        max-inline-size: 26rem;
        margin-inline: auto;
        padding-block-start: var(--space-7);
        text-align: center;
      }
      .nf__title {
        font-size: var(--text-2xl);
        font-weight: var(--weight-bold);
        letter-spacing: var(--tracking-tight);
        margin-block: 0 var(--space-2);
      }
      .nf__body {
        color: var(--color-text-muted);
        font-size: var(--text-sm);
        margin-block: 0 var(--space-5);
      }
      /* Everything but the centring comes from the shared button class: a bespoke primary button with its
         own radius and weight was 4 px rounder and bolder than every other primary action in the app. */
      .nf__cta {
        justify-self: center;
      }
    `,
  ],
})
export class NotFoundComponent {
  readonly i18n = inject(I18nService);
}
