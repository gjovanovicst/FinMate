import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AuthStore } from '../../core/auth/auth.store';

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
      <h1 class="head__title">Pregled</h1>
      <p class="head__sub">Prijavljeni si kao {{ role() }}.</p>
    </header>

    <div class="panel">
      <p class="panel__title">Sledeći korak</p>
      <p class="panel__body">
        Dodaj svoj prvi račun da bi mogao da počneš da beležiš troškove.
      </p>
      <a class="panel__cta" routerLink="/accounts">Idi na račune</a>
    </div>

    <div class="panel panel--muted">
      <p class="panel__title">U izradi</p>
      <ul class="todo">
        <li>Unos prirodnim jezikom — „Lidl 2000“ (Faza 2)</li>
        <li>Budžeti i ciljevi štednje (Faza 1)</li>
        <li>„Koliko mogu danas da potrošim?“ (Faza 1)</li>
        <li>Računi i kategorizacija po stavkama (Faza 4)</li>
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
  private readonly auth = inject(AuthStore);
  readonly role = () => this.auth.role() ?? 'korisnik';
}
