import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AuthStore } from '../../core/auth/auth.store';
import { I18nService } from '../../core/i18n/i18n.service';
import type { TranslationKey } from '../../core/i18n/translations';

/**
 * Dashboard.
 *
 * Phase 0 shows identity and the next step. The real dashboard — "how much can I spend today",
 * the month-end projection, the insight feed — is Phase 1/3 work (docs/09 §3, §5) and needs the
 * deterministic calculators that live in `packages/domain` to exist first. Shipping placeholders
 * for those tiles now would put figures on screen that no ledger stands behind.
 */
@Component({
  selector: 'fm-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <header class="head">
      <h1 class="head__title">{{ i18n.t('dashboard.title') }}</h1>
      <p class="head__sub">{{ i18n.t('session.signedInAs', { role: roleLabel() }) }}</p>
    </header>

    <div class="panel">
      <p class="panel__title">{{ i18n.t('dashboard.nextStepTitle') }}</p>
      <p class="panel__body">{{ i18n.t('dashboard.nextStepBody') }}</p>
      <a class="panel__cta" routerLink="/accounts">{{ i18n.t('dashboard.nextStepCta') }}</a>
    </div>

    <div class="panel panel--muted">
      <p class="panel__title">{{ i18n.t('dashboard.inProgressTitle') }}</p>
      <ul class="todo">
        @for (item of roadmap; track item) {
          <li>{{ i18n.t(item) }}</li>
        }
      </ul>
    </div>
  `,
  styles: [
    `
      .head {
        margin-block-end: var(--space-5);
      }
      .head__title {
        margin: 0;
        font-size: var(--text-2xl);
      }
      .head__sub {
        margin: var(--space-1) 0 0;
        color: var(--color-text-muted);
        font-size: var(--text-sm);
      }
      .panel {
        padding: var(--space-5);
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        margin-block-end: var(--space-4);
      }
      .panel--muted {
        background: transparent;
        border-style: dashed;
      }
      .panel__title {
        margin: 0 0 var(--space-2);
        font-weight: 600;
      }
      .panel__body {
        margin: 0 0 var(--space-4);
        color: var(--color-text-muted);
        font-size: var(--text-sm);
      }
      .panel__cta {
        display: inline-block;
        padding: var(--space-2) var(--space-4);
        background: var(--color-primary);
        color: var(--color-primary-contrast);
        border-radius: var(--radius-md);
        text-decoration: none;
        font-size: var(--text-sm);
        font-weight: 600;
      }
      .todo {
        margin: 0;
        padding-inline-start: var(--space-5);
        color: var(--color-text-muted);
        font-size: var(--text-sm);
        display: grid;
        gap: var(--space-1);
      }
    `,
  ],
})
export class DashboardComponent {
  readonly i18n = inject(I18nService);
  private readonly auth = inject(AuthStore);

  /** Roadmap items are keys, so the list re-renders with the language. */
  readonly roadmap: readonly TranslationKey[] = [
    'dashboard.todo.naturalLanguage',
    'dashboard.todo.budgets',
    'dashboard.todo.safeToSpend',
    'dashboard.todo.receipts',
  ];

  readonly roleLabel = computed(() => {
    const role = this.auth.role();
    return role ? this.i18n.t(`role.${role}` as TranslationKey) : this.i18n.t('role.unknown');
  });
}
