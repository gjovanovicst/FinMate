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
      <a class="nf__cta" routerLink="/">{{ i18n.t('notFound.cta') }}</a>
    </section>
  `,
  styles: [
    `
      .nf {
        max-inline-size: 420px;
        margin-inline: auto;
        padding-block-start: var(--space-7);
        text-align: center;
      }
      .nf__title {
        font-size: var(--text-xl);
        margin-block: 0 var(--space-2);
      }
      .nf__body {
        color: var(--color-text-muted);
        font-size: var(--text-sm);
        margin-block: 0 var(--space-5);
      }
      .nf__cta {
        display: inline-block;
        padding: var(--space-2) var(--space-4);
        background: var(--color-primary);
        color: var(--color-primary-contrast);
        border-radius: var(--radius-md);
        text-decoration: none;
        font-size: var(--text-sm);
        font-weight: 600;
      }
    `,
  ],
})
export class NotFoundComponent {
  readonly i18n = inject(I18nService);
}
