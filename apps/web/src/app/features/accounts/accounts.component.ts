import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { GraphqlClient } from '../../core/graphql/graphql.client';
import { I18nService } from '../../core/i18n/i18n.service';
import type { TranslationKey } from '../../core/i18n/translations';
import { MoneyComponent, type MoneyWire } from '../../shared/ui/money/money.component';

interface AccountNode {
  readonly id: string;
  readonly name: string;
  readonly kind: 'CASH' | 'BANK' | 'CARD' | 'OTHER';
  readonly currency: string;
  readonly openingBalance: MoneyWire;
  readonly balance: MoneyWire;
}

interface AccountsQueryResult {
  readonly accounts: {
    readonly totalCount: number;
    readonly edges: readonly { readonly node: AccountNode }[];
  };
}

interface CreateAccountResult {
  readonly createAccount: AccountNode;
}

const ACCOUNTS_QUERY = /* GraphQL */ `
  query Accounts($first: Int) {
    accounts(first: $first) {
      totalCount
      edges {
        node {
          id
          name
          kind
          currency
          openingBalance
          balance
        }
      }
    }
  }
`;

const CREATE_ACCOUNT_MUTATION = /* GraphQL */ `
  mutation CreateAccount($name: String!, $kind: AccountKind!, $openingBalance: Money) {
    createAccount(name: $name, kind: $kind, openingBalance: $openingBalance) {
      id
      name
      kind
      currency
      openingBalance
      balance
    }
  }
`;

/**
 * Accounts — the first screen backed by real data.
 *
 * It exercises the whole contract: the GraphQL client, the `Money` scalar (note that
 * `amountMinor` arrives as a **string**), and `fm-money` as the only place an amount is rendered.
 *
 * Loading, empty and error states are all handled explicitly. docs/09 §8 makes that part of the
 * Definition of Done, and a list screen with no empty state is the classic place it gets skipped.
 */
@Component({
  selector: 'fm-accounts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MoneyComponent],
  template: `
    <div class="fm-page">
      <header class="fm-page__head">
        <div>
          <h1 class="fm-page__title">{{ i18n.t('accounts.title') }}</h1>
          <p class="fm-page__sub">
            @if (loading()) {
              {{ i18n.t('accounts.loading') }}
            } @else {
              {{ i18n.t('accounts.count', { shown: accounts().length, total: totalCount() }) }}
            }
          </p>
        </div>
      </header>

      @if (error()) {
        <p class="alert" role="alert">{{ error() }}</p>
      }

      @if (!loading() && accounts().length === 0) {
        <!-- Actionable empty state, not decoration: it says what to do next. -->
        <div class="empty">
          <p class="empty__title">{{ i18n.t('accounts.emptyTitle') }}</p>
          <p class="empty__body">{{ i18n.t('accounts.emptyBody') }}</p>
        </div>
      }

      <ul class="list">
        @for (account of accounts(); track account.id) {
          <li class="fm-card card">
            <div class="card__main">
              <span class="card__name">{{ account.name }}</span>
              <span class="card__kind">{{ kindLabel(account.kind) }}</span>
            </div>
            <fm-money class="card__amount" [amount]="account.balance" />
          </li>
        }
      </ul>

      <section class="create">
        <h2 class="create__title">{{ i18n.t('accounts.newTitle') }}</h2>
        <form class="create__form" [formGroup]="form" (ngSubmit)="create()" novalidate>
          <label class="fm-field">
            <span class="fm-field__label">{{ i18n.t('accounts.name') }}</span>
            <input class="fm-field__input" type="text" formControlName="name" required />
          </label>

          <label class="fm-field">
            <span class="fm-field__label">{{ i18n.t('accounts.kind') }}</span>
            <select class="fm-field__input" formControlName="kind">
              @for (kind of accountKinds; track kind) {
                <option [value]="kind">{{ i18n.t(kindKey(kind)) }}</option>
              }
            </select>
          </label>

          <label class="fm-field">
            <span class="fm-field__label">{{ i18n.t('accounts.openingBalance') }}</span>
            <input
              class="fm-field__input"
              type="text"
              inputmode="numeric"
              formControlName="openingMinor"
            />
            <!-- Deliberately parama, not dinara: the wire format is integer minor units (ADR-003)
                 and a text field avoids the browser handing us a float. A friendlier dinara input
                 with correct parsing is a Phase 1 concern. -->
            <span class="fm-field__hint">{{ i18n.t('accounts.openingBalanceHint') }}</span>
          </label>

          <button class="fm-btn fm-btn--primary create__submit" type="submit" [disabled]="creating()">
            {{ creating() ? i18n.t('accounts.submitting') : i18n.t('accounts.submit') }}
          </button>
        </form>
      </section>
    </div>
  `,
  styles: [
    `
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
      }
      .empty__title {
        margin: 0 0 var(--space-2);
        font-weight: var(--weight-semibold);
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
      /* The shared card supplies the surface, radius, padding and shadow; only the row's own
         arrangement is local. */
      .card {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .card__main {
        display: grid;
        gap: var(--space-1);
        min-inline-size: 0;
      }
      .card__name {
        font-weight: var(--weight-semibold);
        /* Long account names must not push the amount off-screen on a narrow phone. */
        overflow-wrap: anywhere;
      }
      .card__kind {
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
      }
      .card__amount {
        font-weight: var(--weight-semibold);
        font-size: var(--text-lg);
      }
      .create {
        padding-block-start: var(--space-5);
        border-block-start: 1px solid var(--color-border);
      }
      .create__title {
        margin: 0 0 var(--space-4);
        font-size: var(--text-lg);
      }
      .create__form {
        display: grid;
        gap: var(--space-4);
        max-inline-size: 420px;
      }
      /* Placement only: the button's box is the shared fm-btn fm-btn--primary. */
      .create__submit {
        justify-self: start;
      }
    `,
  ],
})
export class AccountsComponent {
  readonly i18n = inject(I18nService);
  private readonly graphql = inject(GraphqlClient);
  private readonly fb = inject(FormBuilder);
  private readonly errors = inject(ErrorMessageService);

  readonly accountKinds: readonly AccountNode['kind'][] = ['CASH', 'BANK', 'CARD', 'OTHER'];

  readonly accounts = signal<readonly AccountNode[]>([]);
  readonly totalCount = signal(0);
  readonly loading = signal(true);
  readonly creating = signal(false);
  readonly error = signal<string | null>(null);

  readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    kind: ['CASH' as AccountNode['kind'], [Validators.required]],
    openingMinor: ['0', [Validators.pattern(/^\d*$/)]],
  });

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const data = await this.graphql.query<AccountsQueryResult>(ACCOUNTS_QUERY, { first: 50 });
      this.accounts.set(data.accounts.edges.map((edge) => edge.node));
      this.totalCount.set(data.accounts.totalCount);
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.loading.set(false);
    }
  }

  async create(): Promise<void> {
    if (this.form.invalid || this.creating()) {
      this.form.markAllAsTouched();
      return;
    }

    this.creating.set(true);
    this.error.set(null);
    try {
      const { name, kind, openingMinor } = this.form.getRawValue();
      // The currency is the Household ledger currency, chosen by the API — the client does not
      // send it (ADR-011). `amountMinor` must be a STRING: the API rejects a number outright.
      await this.graphql.query<CreateAccountResult>(CREATE_ACCOUNT_MUTATION, {
        name,
        kind,
        openingBalance: { amountMinor: openingMinor === '' ? '0' : openingMinor, currency: 'RSD' },
      });
      this.form.reset({ name: '', kind: 'CASH', openingMinor: '0' });
      await this.load();
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.creating.set(false);
    }
  }

  /** The translation key for an account kind, so the label follows the language. */
  kindKey(kind: AccountNode['kind']): TranslationKey {
    return `accountKind.${kind}` as TranslationKey;
  }

  kindLabel(kind: AccountNode['kind']): string {
    return this.i18n.t(this.kindKey(kind));
  }
}
