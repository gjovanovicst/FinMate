import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { parseAmount } from '@finmate/domain';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { GraphqlClient } from '../../core/graphql/graphql.client';
import { I18nService } from '../../core/i18n/i18n.service';
import { moneyText, toMajorString } from '../../shared/money-text';
import { MoneyComponent, type MoneyWire } from '../../shared/ui/money/money.component';

type BudgetPeriod = 'WEEKLY' | 'MONTHLY' | 'YEARLY';

interface BudgetNode {
  readonly id: string;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly amount: MoneyWire;
  readonly period: BudgetPeriod;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly spent: MoneyWire;
  readonly remaining: MoneyWire;
  readonly usedRatio: number;
  readonly elapsedRatio: number;
  readonly isOverspent: boolean;
  readonly isAheadOfPace: boolean;
  readonly includeSubcategories: boolean;
  readonly rollover: boolean;
}

interface CategoryNode {
  readonly id: string;
  readonly name: string;
  readonly kind: 'EXPENSE' | 'INCOME';
  readonly path: string[];
}

const BUDGETS_QUERY = /* GraphQL */ `
  query Budgets {
    budgets {
      id
      categoryId
      categoryName
      amount
      period
      periodStart
      periodEnd
      spent
      remaining
      usedRatio
      elapsedRatio
      isOverspent
      isAheadOfPace
      includeSubcategories
      rollover
    }
    categories(kind: EXPENSE) {
      id
      name
      kind
      path
    }
  }
`;

const UPSERT_BUDGET = /* GraphQL */ `
  mutation UpsertBudget($amount: Money!, $categoryId: ID, $period: BudgetPeriod!) {
    upsertBudget(amount: $amount, categoryId: $categoryId, period: $period) {
      id
    }
  }
`;

const DELETE_BUDGET = /* GraphQL */ `
  mutation DeleteBudget($id: ID!) {
    deleteBudget(id: $id)
  }
`;

/**
 * Budgets.
 *
 * Two things here carry product meaning rather than being CRUD:
 *
 *  - **The progress bar is `usedRatio` against `elapsedRatio`, not against 100 %.** "82 % used with
 *    60 % of the month gone" is the signal that changes behaviour; "82 % used" alone is not, because
 *    on the 28th it means nothing. The bar shows both, and it says nothing at all before the pace is
 *    reliable (`isAheadOfPace` is false early in the period by construction, not by a UI guess).
 *  - **The whole-household budget is listed first and named in words.** It is the row that drives
 *    safe-to-spend, and a nameless row would hide that.
 *
 * The amount is parsed by `@finmate/domain` — the same parser as the server — and sent as a STRING,
 * because the API rejects a JSON number for Money outright (ADR-003).
 */
@Component({
  selector: 'fm-budgets',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, MoneyComponent],
  template: `
    <header class="head">
      <h1 class="head__title">{{ i18n.t('budgets.title') }}</h1>
      <p class="head__sub">{{ i18n.t('budgets.explain') }}</p>
    </header>

    @if (error()) {
      <p class="alert" role="alert">{{ error() }}</p>
    }

    <section class="create">
      <h2 class="create__title">{{ i18n.t('budgets.addTitle') }}</h2>
      <form class="create__form" [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <label class="field">
          <span class="field__label">{{ i18n.t('budgets.category') }}</span>
          <select class="field__input" formControlName="categoryId">
            <option value="">{{ i18n.t('budgets.wholeHousehold') }}</option>
            @for (category of categories(); track category.id) {
              <option [value]="category.id">{{ categoryLabel(category) }}</option>
            }
          </select>
        </label>

        <label class="field">
          <span class="field__label">{{ i18n.t('budgets.amount') }}</span>
          <input
            class="field__input"
            type="text"
            inputmode="decimal"
            formControlName="amount"
            [placeholder]="i18n.t('transactions.amountPlaceholder')"
            autocomplete="off"
            required
          />
          @if (amountHint(); as hint) {
            <span class="field__hint">{{ hint }}</span>
          }
        </label>

        <label class="field">
          <span class="field__label">{{ i18n.t('budgets.period') }}</span>
          <select class="field__input" formControlName="period">
            <option value="MONTHLY">{{ i18n.t('budgets.periodMonthly') }}</option>
            <option value="WEEKLY">{{ i18n.t('budgets.periodWeekly') }}</option>
            <option value="YEARLY">{{ i18n.t('budgets.periodYearly') }}</option>
          </select>
        </label>

        <button class="create__submit" type="submit" [disabled]="saving()">
          {{ saving() ? i18n.t('budgets.saving') : i18n.t('budgets.save') }}
        </button>
      </form>
    </section>

    @if (loading()) {
      <p class="muted">{{ i18n.t('accounts.loading') }}</p>
    } @else if (budgets().length === 0) {
      <div class="empty">
        <p class="empty__title">{{ i18n.t('budgets.none') }}</p>
        <p class="empty__body">{{ i18n.t('budgets.noneBody') }}</p>
      </div>
    } @else {
      <ul class="list">
        @for (budget of budgets(); track budget.id) {
          <li class="card" [class.card--over]="budget.isOverspent">
            <div class="card__top">
              <div>
                <p class="card__name">
                  {{ budget.categoryName ?? i18n.t('budgets.wholeHousehold') }}
                </p>
                <p class="card__period">{{ budget.periodStart }} – {{ budget.periodEnd }}</p>
              </div>
              <fm-money class="card__amount" [amount]="budget.amount" />
            </div>

            <!-- The bar plots BOTH ratios: fill is usage, the marker is where the period should be.
                 Comparing them is the whole point, so they share one scale and one card. -->
            <div
              class="bar"
              role="progressbar"
              [attr.aria-valuenow]="percent(budget.usedRatio)"
              aria-valuemin="0"
              aria-valuemax="100"
              [attr.aria-label]="
                i18n.t('budgets.progressLabel', {
                  spent: spentText(budget),
                  budget: amountText(budget),
                })
              "
            >
              <span class="bar__fill" [style.inline-size.%]="percent(budget.usedRatio)"></span>
              <span class="bar__pace" [style.inset-inline-start.%]="percent(budget.elapsedRatio)"></span>
            </div>

            <div class="card__figures">
              <span>
                {{ i18n.t('budgets.spent') }}
                <fm-money [amount]="budget.spent" direction="EXPENSE" />
              </span>
              <span>
                {{ i18n.t('budgets.remaining') }}
                <fm-money [amount]="budget.remaining" />
              </span>
              @if (budget.isOverspent) {
                <span class="card__over">
                  {{ i18n.t('budgets.overBudget', { amount: overText(budget) }) }}
                </span>
              }
            </div>

            <button class="card__remove" type="button" (click)="remove(budget)">
              {{ i18n.t('budgets.remove') }}
            </button>
          </li>
        }
      </ul>
    }

    <p class="foot">
      <a routerLink="/">{{ i18n.t('nav.dashboard') }}</a>
    </p>
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
      .create {
        padding: var(--space-4);
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        margin-block-end: var(--space-6);
      }
      .create__title {
        margin: 0 0 var(--space-4);
        font-size: var(--text-lg);
      }
      .create__form {
        display: grid;
        gap: var(--space-3);
      }
      @media (min-width: 768px) {
        .create__form {
          grid-template-columns: 1.2fr 1fr 0.8fr auto;
          align-items: end;
        }
      }
      .field {
        display: grid;
        gap: var(--space-1);
        min-inline-size: 0;
      }
      .field__label {
        font-size: var(--text-sm);
        color: var(--color-text-muted);
      }
      .field__hint {
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
      }
      .field__input {
        padding: var(--space-3);
        font: inherit;
        color: var(--color-text);
        background: var(--color-bg);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        min-inline-size: 0;
      }
      .create__submit {
        justify-self: start;
        padding: var(--space-3) var(--space-5);
        font: inherit;
        font-weight: 600;
        color: var(--color-primary-contrast);
        background: var(--color-primary);
        border: none;
        border-radius: var(--radius-md);
        cursor: pointer;
      }
      .create__submit:disabled {
        opacity: 0.6;
        cursor: default;
      }
      .empty {
        padding: var(--space-5);
        border: 1px dashed var(--color-border);
        border-radius: var(--radius-lg);
        text-align: center;
      }
      .empty__title {
        margin: 0 0 var(--space-2);
        font-weight: 600;
      }
      .empty__body {
        margin: 0;
        color: var(--color-text-muted);
        font-size: var(--text-sm);
      }
      .list {
        display: grid;
        gap: var(--space-3);
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .card {
        display: grid;
        gap: var(--space-3);
        padding: var(--space-4);
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
      }
      .card--over {
        border-color: var(--color-danger);
      }
      .card__top {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-4);
      }
      .card__top > div {
        min-inline-size: 0;
      }
      .card__name {
        margin: 0;
        font-weight: 600;
        overflow-wrap: anywhere;
      }
      .card__period {
        margin: var(--space-1) 0 0;
        color: var(--color-text-subtle);
        font-size: var(--text-xs);
      }
      .card__amount {
        font-size: var(--text-lg);
        font-weight: 600;
      }
      .bar {
        position: relative;
        block-size: 8px;
        border-radius: 999px;
        background: var(--color-border);
        overflow: hidden;
      }
      .bar__fill {
        position: absolute;
        inset-block: 0;
        inset-inline-start: 0;
        background: var(--color-primary);
      }
      .card--over .bar__fill {
        background: var(--color-danger);
      }
      /* The pace marker: a hairline at the share of the period already elapsed. */
      .bar__pace {
        position: absolute;
        inset-block: -2px;
        inline-size: 2px;
        background: var(--color-text-muted);
      }
      .card__figures {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-4);
        font-size: var(--text-sm);
        color: var(--color-text-muted);
      }
      .card__over {
        color: var(--color-danger);
      }
      .card__remove {
        justify-self: start;
        padding: 0;
        font: inherit;
        font-size: var(--text-sm);
        color: var(--color-text-subtle);
        background: none;
        border: none;
        cursor: pointer;
        text-decoration: underline;
      }
      .foot {
        margin-block-start: var(--space-6);
        font-size: var(--text-sm);
      }
    `,
  ],
})
export class BudgetsComponent {
  readonly i18n = inject(I18nService);
  private readonly graphql = inject(GraphqlClient);
  private readonly errors = inject(ErrorMessageService);
  private readonly fb = inject(FormBuilder);

  readonly budgets = signal<readonly BudgetNode[]>([]);
  readonly categories = signal<readonly CategoryNode[]>([]);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  readonly form = this.fb.nonNullable.group({
    categoryId: [''],
    amount: ['', [Validators.required]],
    period: ['MONTHLY' as BudgetPeriod, [Validators.required]],
  });

  readonly amountHint = computed(() => {
    const raw = this.form.controls.amount.value;
    if (!raw.trim()) return null;
    const parsed = parseAmount(raw, 'RSD');
    if (!parsed.money) return this.i18n.t('budgets.amountUnreadable');
    if (parsed.ambiguous) {
      return this.i18n.t('transactions.amountAmbiguous', {
        reading: toMajorString(parsed.money.amountMinor),
      });
    }
    return null;
  });

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const result = await this.graphql.query<{
        budgets: BudgetNode[];
        categories: CategoryNode[];
      }>(BUDGETS_QUERY);
      this.budgets.set(result.budgets);
      this.categories.set(result.categories);
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.loading.set(false);
    }
  }

  async submit(): Promise<void> {
    if (this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }

    const { categoryId, amount, period } = this.form.getRawValue();
    const parsed = parseAmount(amount, 'RSD');
    if (!parsed.money) {
      this.error.set(this.i18n.t('budgets.amountUnreadable'));
      return;
    }

    this.saving.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(UPSERT_BUDGET, {
        categoryId: categoryId === '' ? null : categoryId,
        // A STRING on purpose: the API rejects a JSON number for Money (ADR-003).
        amount: { amountMinor: parsed.money.amountMinor.toString(), currency: 'RSD' },
        period,
      });
      this.form.patchValue({ amount: '' });
      await this.load();
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.saving.set(false);
    }
  }

  async remove(budget: BudgetNode): Promise<void> {
    this.error.set(null);
    try {
      await this.graphql.query(DELETE_BUDGET, { id: budget.id });
      await this.load();
    } catch (error) {
      this.error.set(this.errors.for(error));
    }
  }

  /** Clamp to 0–100: an overspent budget renders as a full bar, never as an overflowing one. */
  percent(ratio: number): number {
    if (!Number.isFinite(ratio)) return 0;
    return Math.max(0, Math.min(100, Math.round(ratio * 100)));
  }

  categoryLabel(category: CategoryNode): string {
    return category.path.join(' › ');
  }

  spentText(budget: BudgetNode): string {
    return moneyText(budget.spent);
  }

  amountText(budget: BudgetNode): string {
    return moneyText(budget.amount);
  }

  /** The overspend magnitude for "Over by {amount}" — the sign is carried by the sentence. */
  overText(budget: BudgetNode): string {
    const remaining = BigInt(budget.remaining.amountMinor);
    const magnitude = remaining < 0n ? -remaining : remaining;
    return `${toMajorString(magnitude, budget.remaining.currency)} ${budget.remaining.currency}`;
  }
}
