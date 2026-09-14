import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { AuthStore } from '../../core/auth/auth.store';
import { GraphqlClient } from '../../core/graphql/graphql.client';
import { I18nService } from '../../core/i18n/i18n.service';
import type { TranslationKey } from '../../core/i18n/translations';
import { MoneyComponent, type MoneyWire } from '../../shared/ui/money/money.component';
import { moneyText, overrunText } from '../../shared/money-text';

interface DashboardData {
  readonly today: string;
  readonly daysElapsed: number;
  readonly daysInMonth: number;
  readonly safeToSpendToday: MoneyWire;
  readonly available: MoneyWire;
  readonly isOverspent: boolean;
  readonly spentThisMonth: MoneyWire;
  readonly incomeThisMonth: MoneyWire;
  readonly monthlyBudget: MoneyWire | null;
  readonly projectedTotal: MoneyWire;
  readonly projectedOverrun: MoneyWire | null;
  readonly paceIsReliable: boolean;
  readonly needsReviewCount: number;
}

const DASHBOARD_QUERY = /* GraphQL */ `
  query Dashboard {
    dashboard {
      today
      daysElapsed
      daysInMonth
      safeToSpendToday
      available
      isOverspent
      spentThisMonth
      incomeThisMonth
      monthlyBudget
      projectedTotal
      projectedOverrun
      paceIsReliable
      needsReviewCount
    }
  }
`;

/**
 * The dashboard.
 *
 * Every figure comes from the backend's deterministic calculators (ADR-001) — including
 * safe-to-spend, which is the product's headline number. The UI's job is to present them and to be
 * honest about their confidence:
 *
 *  - With no budget set, safe-to-spend is meaningless, so the tile invites the user to set one
 *    rather than showing a zero that looks like advice.
 *  - Before enough days have elapsed, the projection is withheld as "too early" instead of
 *    presenting a straight line extrapolated from one shopping trip as a forecast.
 */
@Component({
  selector: 'fm-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MoneyComponent],
  template: `
    <header class="head">
      <h1 class="head__title">{{ i18n.t('dashboard.title') }}</h1>
      <p class="head__sub">{{ i18n.t('session.signedInAs', { role: roleLabel() }) }}</p>
    </header>

    @if (error()) {
      <p class="alert" role="alert">{{ error() }}</p>
    }

    @if (loading()) {
      <p class="muted">{{ i18n.t('accounts.loading') }}</p>
    } @else if (data(); as d) {
      <section class="hero" [class.hero--overspent]="d.isOverspent">
        @if (d.monthlyBudget) {
          <p class="hero__label">{{ i18n.t('dashboard.safeToSpendTitle') }}</p>
          <fm-money class="hero__amount" [amount]="d.safeToSpendToday" />
          <p class="hero__meta">
            {{ i18n.t('dashboard.dayOf', { day: d.daysElapsed, total: d.daysInMonth }) }}
            @if (overrunText(); as over) {
              · {{ i18n.t('dashboard.overspent', { amount: over }) }}
            }
          </p>
        } @else {
          <p class="hero__label">{{ i18n.t('dashboard.noBudgetTitle') }}</p>
          <p class="hero__meta">{{ i18n.t('dashboard.noBudgetBody') }}</p>
          <a class="hero__cta" routerLink="/budgets">{{ i18n.t('budgets.setBudget') }}</a>
        }
      </section>

      <div class="tiles">
        <article class="tile">
          <p class="tile__label">{{ i18n.t('dashboard.spentThisMonth') }}</p>
          <fm-money class="tile__value" [amount]="d.spentThisMonth" direction="EXPENSE" />
          @if (d.monthlyBudget) {
            <p class="tile__meta">
              {{ i18n.t('dashboard.of', { budget: budgetText() }) }}
            </p>
          }
        </article>

        <article class="tile">
          <p class="tile__label">{{ i18n.t('dashboard.incomeThisMonth') }}</p>
          <fm-money class="tile__value" [amount]="d.incomeThisMonth" direction="INCOME" />
        </article>

        <article class="tile">
          <p class="tile__label">{{ i18n.t('dashboard.projected') }}</p>
          <fm-money class="tile__value" [amount]="d.projectedTotal" />
          @if (!d.paceIsReliable) {
            <p class="tile__meta">{{ i18n.t('dashboard.notEnoughData') }}</p>
          } @else if (projectedOverText(); as over) {
            <p class="tile__meta tile__meta--warn">
              {{ i18n.t('dashboard.projectedOverrun', { amount: over }) }}
            </p>
          }
        </article>

        @if (d.needsReviewCount > 0) {
          <article class="tile tile--warn">
            <p class="tile__label">{{ i18n.t('transactions.needsReview') }}</p>
            <p class="tile__value">{{ d.needsReviewCount }}</p>
          </article>
        }
      </div>
    }
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
      .head__sub,
      .muted {
        margin: var(--space-1) 0 0;
        color: var(--color-text-muted);
        font-size: var(--text-sm);
      }
      .alert {
        padding: var(--space-3);
        border-radius: var(--radius-md);
        background: color-mix(in srgb, var(--color-danger) 15%, transparent);
        color: var(--color-danger);
        font-size: var(--text-sm);
      }
      .hero {
        padding: var(--space-5);
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        margin-block-end: var(--space-4);
      }
      .hero--overspent {
        border-color: var(--color-danger);
      }
      .hero__label {
        margin: 0 0 var(--space-2);
        color: var(--color-text-muted);
        font-size: var(--text-sm);
      }
      .hero__amount {
        font-size: var(--text-3xl);
        font-weight: 700;
        line-height: var(--leading-tight);
      }
      .hero__meta {
        margin: var(--space-2) 0 0;
        color: var(--color-text-subtle);
        font-size: var(--text-sm);
      }
      .hero__cta {
        display: inline-block;
        margin-block-start: var(--space-3);
        color: var(--color-primary);
        font-size: var(--text-sm);
      }
      .tiles {
        display: grid;
        gap: var(--space-3);
        grid-template-columns: 1fr;
      }
      @media (min-width: 700px) {
        .tiles {
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        }
      }
      .tile {
        padding: var(--space-4);
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
      }
      .tile--warn {
        border-color: var(--color-warning);
      }
      .tile__label {
        margin: 0 0 var(--space-2);
        color: var(--color-text-muted);
        font-size: var(--text-sm);
      }
      .tile__value {
        font-size: var(--text-xl);
        font-weight: 600;
      }
      .tile__meta {
        margin: var(--space-2) 0 0;
        color: var(--color-text-subtle);
        font-size: var(--text-xs);
      }
      .tile__meta--warn {
        color: var(--color-warning);
      }
    `,
  ],
})
export class DashboardComponent {
  readonly i18n = inject(I18nService);
  private readonly graphql = inject(GraphqlClient);
  private readonly errors = inject(ErrorMessageService);
  private readonly auth = inject(AuthStore);

  readonly data = signal<DashboardData | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  readonly roleLabel = computed(() => {
    const role = this.auth.role();
    return role ? this.i18n.t(`role.${role}` as TranslationKey) : this.i18n.t('role.unknown');
  });

  /** The budget, in major units, for the "of 300.000,00 RSD" label. */
  readonly budgetText = computed(() => moneyText(this.data()?.monthlyBudget));

  /**
   * How much is already over, or null while inside the budget.
   *
   * `available` is a signed Balance, so this reads as an overspend only once it has gone negative —
   * see `overrunText`, which owns that rule and is covered by `money-text.spec.ts`.
   */
  readonly overrunText = computed(() => overrunText(this.data()?.available));

  /** How much the month is *projected* to overshoot, or null when the projection is inside budget. */
  readonly projectedOverText = computed(() => overrunText(this.data()?.projectedOverrun));

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const result = await this.graphql.query<{ dashboard: DashboardData }>(DASHBOARD_QUERY);
      this.data.set(result.dashboard);
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.loading.set(false);
    }
  }

}
