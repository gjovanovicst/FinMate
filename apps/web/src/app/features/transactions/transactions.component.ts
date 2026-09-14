import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { parseAmount } from '@finmate/domain';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { GraphqlClient } from '../../core/graphql/graphql.client';
import { I18nService } from '../../core/i18n/i18n.service';
import type { TranslationKey } from '../../core/i18n/translations';
import { toMajorString } from '../../shared/money-text';
import { MoneyComponent, type MoneyWire } from '../../shared/ui/money/money.component';

interface TransactionNode {
  readonly id: string;
  readonly kind: 'EXPENSE' | 'INCOME';
  readonly amount: MoneyWire;
  readonly description: string;
  readonly occurredLocalDate: string;
  readonly categoryId: string | null;
  readonly needsReview: boolean;
}

interface CategoryNode {
  readonly id: string;
  readonly name: string;
  readonly kind: 'EXPENSE' | 'INCOME';
  readonly path: string[];
}

interface AccountNode {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
}

const TRANSACTIONS_QUERY = /* GraphQL */ `
  query Transactions($first: Int) {
    transactions(first: $first) {
      totalCount
      edges {
        node {
          id
          kind
          amount
          description
          occurredLocalDate
          categoryId
          needsReview
        }
      }
    }
  }
`;

const TAXONOMY_QUERY = /* GraphQL */ `
  query Taxonomy {
    accounts(first: 100) {
      edges {
        node {
          id
          name
          currency
        }
      }
    }
    categories {
      id
      name
      kind
      path
    }
  }
`;

const CREATE_TRANSACTION = /* GraphQL */ `
  mutation CreateTransaction(
    $accountId: ID!
    $kind: TransactionKind!
    $amount: Money!
    $description: String!
    $occurredAt: DateTime!
    $categoryId: ID
  ) {
    createTransaction(
      accountId: $accountId
      kind: $kind
      amount: $amount
      description: $description
      occurredAt: $occurredAt
      categoryId: $categoryId
    ) {
      id
    }
  }
`;

/**
 * Transactions: the screen that makes the product manually usable.
 *
 * This is the Phase 1 exit criterion in UI form — a person can record a month of spending without
 * any AI. Three things are deliberate:
 *
 *  - **The amount is parsed by `@finmate/domain`, the same code the server uses.** A second parser in
 *    the client would eventually disagree with the first, and the disagreement would be about money.
 *    It also means the Serbian rules (`.` groups thousands, `,` is decimal) hold here for free.
 *  - **`amountMinor` is sent as a STRING.** The API rejects a JSON number outright (ADR-003), so the
 *    client cannot accidentally send a float even if it tried.
 *  - **The category list is filtered to the transaction's kind** before the user can pick an invalid
 *    one. The backend enforces I-3 regardless — this just avoids offering a choice that will fail.
 */
@Component({
  selector: 'fm-transactions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MoneyComponent],
  template: `
    <header class="head">
      <h1 class="head__title">{{ i18n.t('transactions.title') }}</h1>
      <p class="head__sub">
        @if (loading()) {
          {{ i18n.t('accounts.loading') }}
        } @else {
          {{ i18n.t('transactions.count', { count: transactions().length }) }}
        }
      </p>
    </header>

    @if (error()) {
      <p class="alert" role="alert">{{ error() }}</p>
    }

    @if (noAccounts()) {
      <div class="empty">
        <p class="empty__title">{{ i18n.t('transactions.noAccountsTitle') }}</p>
        <p class="empty__body">{{ i18n.t('transactions.noAccountsBody') }}</p>
      </div>
    } @else {
      <section class="create">
        <h2 class="create__title">{{ i18n.t('transactions.addTitle') }}</h2>
        <form class="create__form" [formGroup]="form" (ngSubmit)="submit()" novalidate>
          <label class="field">
            <span class="field__label">{{ i18n.t('transactions.amount') }}</span>
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
              <!-- The parser reports ambiguity instead of guessing, so the hint shows what it read. -->
              <span class="field__hint">{{ hint }}</span>
            }
          </label>

          <label class="field">
            <span class="field__label">{{ i18n.t('transactions.description') }}</span>
            <input class="field__input" type="text" formControlName="description" required />
          </label>

          <label class="field">
            <span class="field__label">{{ i18n.t('transactions.kind') }}</span>
            <select class="field__input" formControlName="kind">
              <option value="EXPENSE">{{ i18n.t('transactionKind.EXPENSE') }}</option>
              <option value="INCOME">{{ i18n.t('transactionKind.INCOME') }}</option>
            </select>
          </label>

          <label class="field">
            <span class="field__label">{{ i18n.t('transactions.category') }}</span>
            <select class="field__input" formControlName="categoryId">
              <option value="">{{ i18n.t('transactions.noCategory') }}</option>
              @for (category of matchingCategories(); track category.id) {
                <option [value]="category.id">{{ categoryLabel(category) }}</option>
              }
            </select>
          </label>

          <label class="field">
            <span class="field__label">{{ i18n.t('transactions.account') }}</span>
            <select class="field__input" formControlName="accountId">
              @for (account of accounts(); track account.id) {
                <option [value]="account.id">{{ account.name }}</option>
              }
            </select>
          </label>

          <label class="field">
            <span class="field__label">{{ i18n.t('transactions.date') }}</span>
            <input class="field__input" type="date" formControlName="occurredOn" required />
          </label>

          <button class="create__submit" type="submit" [disabled]="creating()">
            {{ creating() ? i18n.t('transactions.submitting') : i18n.t('transactions.submit') }}
          </button>
        </form>
      </section>

      @if (transactions().length === 0 && !loading()) {
        <div class="empty">
          <p class="empty__title">{{ i18n.t('transactions.emptyTitle') }}</p>
          <p class="empty__body">{{ i18n.t('transactions.emptyBody') }}</p>
        </div>
      }

      <ul class="list">
        @for (transaction of transactions(); track transaction.id) {
          <li class="row">
            <div class="row__main">
              <span class="row__desc">{{ transaction.description }}</span>
              <span class="row__meta">
                {{ transaction.occurredLocalDate }}
                @if (transaction.needsReview) {
                  <span class="row__flag">{{ i18n.t('transactions.needsReview') }}</span>
                }
              </span>
            </div>
            <fm-money
              class="row__amount"
              [amount]="transaction.amount"
              [direction]="transaction.kind"
            />
          </li>
        }
      </ul>
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
      .head__sub {
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
      .empty {
        padding: var(--space-5);
        border: 1px dashed var(--color-border);
        border-radius: var(--radius-lg);
        text-align: center;
        margin-block-end: var(--space-5);
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
      /* Two columns once there is room: entry is a repeated task, so it should not scroll. */
      @media (min-width: 768px) {
        .create__form {
          grid-template-columns: 1fr 1fr;
        }
        .create__submit {
          grid-column: 1 / -1;
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
      .list {
        display: grid;
        gap: var(--space-2);
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-4);
        padding: var(--space-3) var(--space-4);
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
      }
      .row__main {
        display: grid;
        gap: var(--space-1);
        min-inline-size: 0;
      }
      .row__desc {
        overflow-wrap: anywhere;
      }
      .row__meta {
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
        display: flex;
        gap: var(--space-2);
      }
      .row__flag {
        color: var(--color-warning);
      }
      .row__amount {
        font-weight: 600;
      }
    `,
  ],
})
export class TransactionsComponent {
  readonly i18n = inject(I18nService);
  private readonly graphql = inject(GraphqlClient);
  private readonly errors = inject(ErrorMessageService);
  private readonly fb = inject(FormBuilder);

  readonly transactions = signal<readonly TransactionNode[]>([]);
  readonly categories = signal<readonly CategoryNode[]>([]);
  readonly accounts = signal<readonly AccountNode[]>([]);
  readonly loading = signal(true);
  readonly creating = signal(false);
  readonly error = signal<string | null>(null);
  readonly amountMessage = signal<string | null>(null);

  readonly form = this.fb.nonNullable.group({
    amount: ['', [Validators.required]],
    description: ['', [Validators.required, Validators.maxLength(200)]],
    kind: ['EXPENSE' as 'EXPENSE' | 'INCOME', [Validators.required]],
    categoryId: [''],
    accountId: ['', [Validators.required]],
    occurredOn: [new Date().toISOString().slice(0, 10), [Validators.required]],
  });

  readonly noAccounts = computed(() => !this.loading() && this.accounts().length === 0);

  /** Only categories of the selected kind, so an I-3 violation is not offerable in the first place. */
  readonly matchingCategories = computed(() => {
    const kind = this.form.controls.kind.value;
    return this.categories().filter((category) => category.kind === kind);
  });

  /**
   * What the parser read from the amount field.
   *
   * Shown because the parser reports ambiguity rather than guessing: if `1.200` could be either
   * reading, the user sees which one was understood *before* saving, not after.
   */
  readonly amountHint = computed(() => {
    const raw = this.form.controls.amount.value;
    if (!raw.trim()) return null;
    const currency = this.accounts()[0]?.currency ?? 'RSD';
    const parsed = parseAmount(raw, currency);
    if (!parsed.money) return this.i18n.t('transactions.amountUnreadable');
    if (parsed.ambiguous) {
      return this.i18n.t('transactions.amountAmbiguous', {
        reading: toMajorString(parsed.money.amountMinor, currency),
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
      const [taxonomy, list] = await Promise.all([
        this.graphql.query<{
          accounts: { edges: { node: AccountNode }[] };
          categories: CategoryNode[];
        }>(TAXONOMY_QUERY),
        this.graphql.query<{
          transactions: { edges: { node: TransactionNode }[] };
        }>(TRANSACTIONS_QUERY, { first: 50 }),
      ]);

      this.accounts.set(taxonomy.accounts.edges.map((edge) => edge.node));
      this.categories.set(taxonomy.categories);
      this.transactions.set(list.transactions.edges.map((edge) => edge.node));

      const firstAccount = this.accounts()[0];
      if (firstAccount) this.form.controls.accountId.setValue(firstAccount.id);
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.loading.set(false);
    }
  }

  async submit(): Promise<void> {
    if (this.form.invalid || this.creating()) {
      this.form.markAllAsTouched();
      return;
    }

    const { amount, description, kind, categoryId, accountId, occurredOn } = this.form.getRawValue();
    const currency = this.accounts().find((a) => a.id === accountId)?.currency ?? 'RSD';

    // Parse with the shared domain parser, then send the minor units as a STRING.
    const parsed = parseAmount(amount, currency);
    if (!parsed.money) {
      this.error.set(this.i18n.t('transactions.amountUnreadable'));
      return;
    }

    this.creating.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(CREATE_TRANSACTION, {
        accountId,
        kind,
        amount: {
          amountMinor: parsed.money.amountMinor.toString(),
          currency,
        },
        description,
        // Midday UTC keeps the local calendar day stable across timezones for a date-only input.
        occurredAt: `${occurredOn}T12:00:00.000Z`,
        categoryId: categoryId === '' ? null : categoryId,
      });

      this.form.patchValue({ amount: '', description: '', categoryId: '' });
      await this.load();
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.creating.set(false);
    }
  }

  categoryLabel(category: CategoryNode): string {
    return category.path.join(' › ');
  }
}

/** Kept next to the component so the key list is reviewable with it. */
export const TRANSACTION_KEYS: readonly TranslationKey[] = [
  'transactions.title',
  'transactions.count',
  'transactions.addTitle',
  'transactions.amount',
  'transactions.amountPlaceholder',
  'transactions.amountAmbiguous',
  'transactions.amountUnreadable',
  'transactions.description',
  'transactions.kind',
  'transactions.category',
  'transactions.noCategory',
  'transactions.account',
  'transactions.date',
  'transactions.submit',
  'transactions.submitting',
  'transactions.emptyTitle',
  'transactions.emptyBody',
  'transactions.needsReview',
  'transactions.noAccountsTitle',
  'transactions.noAccountsBody',
  'transactionKind.EXPENSE',
  'transactionKind.INCOME',
];
