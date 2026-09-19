import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import { ActivatedRoute, Router, RouterLink, type ParamMap } from '@angular/router';

import { equalsMoney, parseAmount, type Money } from '@finmate/domain';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { LedgerCacheService, type LedgerSnapshot } from '../../core/offline/ledger-cache.service';
import { syncedAtLabel } from '../../core/offline/sync.view';
import { GraphqlClient } from '../../core/graphql/graphql.client';
import { I18nService } from '../../core/i18n/i18n.service';
import type { TranslationKey } from '../../core/i18n/translations';
import { moneyText, toMajorString } from '../../shared/money-text';
import { AvatarLoaderComponent } from '../../shared/ui/avatar-loader/avatar-loader.component';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { MoneyComponent } from '../../shared/ui/money/money.component';
import {
  TransactionDetailComponent,
  type CategoryOption,
} from './transaction-detail.component';
import {
  PAGE_SIZE,
  emptyFilters,
  exportUrl,
  filenameFromContentDisposition,
  filtersFromQuery,
  groupByDay,
  hasActiveFilters,
  localNoonInstant,
  toQueryVariables,
  groupCachedByDay,
  totalOf,
  type TransactionFilters,
  type TransactionKind,
  type TransactionRow,
} from './transactions.view';

interface AccountOption {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
}

interface SplitDraft {
  readonly categoryId: string;
  readonly amountText: string;
}

const TRANSACTIONS_QUERY = /* GraphQL */ `
  query Transactions(
    $first: Int
    $after: String
    $search: String
    $kind: TransactionKind
    $categoryId: ID
    $accountId: ID
    $from: LocalDate
    $to: LocalDate
    $needsReview: Boolean
  ) {
    transactions(
      first: $first
      after: $after
      search: $search
      kind: $kind
      categoryId: $categoryId
      accountId: $accountId
      from: $from
      to: $to
      needsReview: $needsReview
    ) {
      totalCount
      pageInfo {
        endCursor
        hasNextPage
      }
      edges {
        node {
          id
          kind
          status
          amount
          description
          note
          occurredAt
          occurredLocalDate
          categoryId
          accountId
          needsReview
          attachmentId
          version
          splits {
            id
            amount
            categoryId
          }
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
    $occurredLocalDate: LocalDate
    $categoryId: ID
    $splits: [SplitInput!]
  ) {
    createTransaction(
      accountId: $accountId
      kind: $kind
      amount: $amount
      description: $description
      occurredAt: $occurredAt
      occurredLocalDate: $occurredLocalDate
      categoryId: $categoryId
      splits: $splits
    ) {
      id
    }
  }
`;

const PROPOSE_EQUAL_SPLITS = /* GraphQL */ `
  query ProposeEqualSplits($amount: Money!, $categoryIds: [ID!]!) {
    proposeEqualSplits(amount: $amount, categoryIds: $categoryIds) {
      amount
      categoryId
    }
  }
`;

/**
 * One Transaction, for the `/transactions/:id` drill-in.
 *
 * The selection is the list query's node **verbatim**, because `fm-transaction-detail` takes a
 * `TransactionRow`: a narrower projection would compile and then fail on a missing field the sheet
 * reads. Nothing is inferred from the row the list already has, either — a deep link can point at a
 * row that is not on the current page (an old receipt's Transaction, say), so the row is fetched.
 */
const TRANSACTION = /* GraphQL */ `
  query Transaction($id: ID!) {
    transaction(id: $id) {
      id
      kind
      status
      amount
      description
      note
      occurredAt
      occurredLocalDate
      categoryId
      accountId
      needsReview
      attachmentId
      version
      splits {
        id
        amount
        categoryId
      }
    }
  }
`;

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Transactions: the screen the product is actually used through.
 *
 * Three decisions here are about not lying to the user:
 *
 *  - **Day totals are withheld for a day the page boundary cut through.** `groupByDay` returns
 *    `null` for the truncated oldest day, so the UI shows no total rather than one that silently
 *    grows as the user loads more. A wrong number presented as a fact about money is worse than no
 *    number.
 *  - **The amount is parsed by `@finmate/domain`**, the same code the server runs, and sent as a
 *    STRING, so a float cannot reach the API (ADR-003).
 *  - **A date-only edit sends `occurredLocalDate`, not just an instant.** The server derives the
 *    calendar day in the *Household's* timezone; a client that invented `T12:00:00Z` would file an
 *    evening entry on the wrong day east of UTC+11, and in the wrong *month* at a boundary (I-2).
 *
 * Splits are offered on create only. `updateTransaction` does not accept them, so the edit sheet
 * shows the parts read-only rather than pretending they can be changed.
 *
 * The screen also serves **`/transactions/:id`** (docs/02 §2.1) — the drill-in a posted receipt or a
 * drill-through link needs. That row is fetched by id, not looked up in the loaded page, because a
 * deep link routinely points at a Transaction the current filter and cursor do not include.
 */
@Component({
  selector: 'fm-transactions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MoneyComponent,
    IconComponent,
    TransactionDetailComponent,
    AvatarLoaderComponent,
  ],
  template: `
    <div class="fm-page">
      <header class="fm-page__head">
        <div>
          <h1 class="fm-page__title">{{ i18n.t('transactions.title') }}</h1>
          <p class="fm-page__sub">
            @if (loading()) {
              {{ i18n.t('accounts.loading') }}
            } @else if (cached()) {
              {{ i18n.t('transactions.cachedCount', { count: cachedCount() }) }}
            } @else {
              {{ i18n.t('transactions.count', { count: totalCount() }) }}
            }
          </p>
        </div>

        <!-- The head's control cluster (ADR-039): filters and the export belong to the page, not to a
             bespoke toolbar. They are absent in the cached mode, which is read-only by construction. -->
        @if (!loading() && !cached() && !noAccounts()) {
          <div class="fm-page__actions">
            <button
              class="fm-btn fm-btn--ghost"
              type="button"
              (click)="filtersOpen.set(!filtersOpen())"
            >
              {{ i18n.t('transactions.filters') }}
              @if (hasFilters()) {
                <span class="dot" aria-hidden="true"></span>
              }
            </button>

            @if (hasFilters()) {
              <button class="fm-btn fm-btn--ghost" type="button" (click)="clearFilters()">
                {{ i18n.t('transactions.clearFilters') }}
              </button>
            }

            <!-- The count is the promise: the file contains exactly the rows the filter matched, not
                 the rows currently paged in. Hidden at zero, because an empty export helps nobody. -->
            @if (totalCount() > 0) {
              <button class="fm-btn" type="button" [disabled]="exporting()" (click)="exportCsv()">
                {{
                  exporting()
                    ? i18n.t('transactions.exporting')
                    : i18n.t('transactions.exportCount', { count: totalCount() })
                }}
              </button>
            }
          </div>
        }
      </header>

      @if (error()) {
        <p class="alert" role="alert">{{ error() }}</p>
      }

      @if (cached()) {
        <div class="cached" role="status">
          @if (staleLabel(); as asOf) {
            <p class="cached__asof">{{ i18n.t('money.asOf', { time: asOf }) }}</p>
          }
          <p class="cached__body">{{ i18n.t('transactions.cachedNotice') }}</p>
        </div>

        <!-- The same one-card ledger the live list renders: a flush card around one table, so a cached
             day is not a stack of bordered row cards either. -->
        <div class="fm-card fm-card--flush">
          <table class="fm-table ledger">
            @for (group of cachedGroups(); track group.date) {
              <tbody>
                <tr class="ledger__day">
                  <th colspan="3" scope="rowgroup" class="ledger__day-head">
                    <span class="day__head">
                      <span class="day__date">{{ dayLabel(group.date) }}</span>
                      <span class="day__totals">
                        @if (group.expenseTotal; as spent) {
                          <span>{{ i18n.t('transactions.daySpent', { amount: amountText(spent) }) }}</span>
                        }
                        @if (group.incomeTotal; as received) {
                          <span>{{ i18n.t('transactions.dayReceived', { amount: amountText(received) }) }}</span>
                        }
                      </span>
                    </span>
                  </th>
                </tr>

                <!--
                  Deliberately NOT a button: a cached row has no id to open (the whitelist drops it, and
                  adding one is a data-minimisation decision, not a convenience). A row that looked
                  tappable and did nothing would be worse than a row that plainly does not.
                -->
                @for (row of group.rows; track $index) {
                  <tr class="ledger__row ledger__row--cached">
                    <td>
                      <span class="row__main">
                        <span class="row__desc">{{ row.description }}</span>
                        <span class="row__meta">
                          <!--
                            Nothing when the cache holds no category. A null category means "uncategorised"
                            OR "divided" — a split Transaction has no Category of its own and the whitelist
                            holds one — so the screen claims neither instead of guessing.
                          -->
                          @if (row.categoryName; as name) {
                            {{ name }}
                          }
                        </span>
                      </span>
                    </td>
                    <td class="ledger__amount">
                      <fm-money class="row__amount" [amount]="row.amount" [direction]="row.kind" />
                    </td>
                    <td class="ledger__edit"></td>
                  </tr>
                }
              </tbody>
            }
          </table>
        </div>
      } @else if (noAccounts()) {
        <div class="empty">
          <p class="empty__title">{{ i18n.t('transactions.noAccountsTitle') }}</p>
          <p class="empty__body">{{ i18n.t('transactions.noAccountsBody') }}</p>
          <p><a routerLink="/accounts">{{ i18n.t('nav.accounts') }}</a></p>
        </div>
      } @else {
        <section class="fm-card">
          <div class="fm-card__head">
            <h2 class="fm-card__title">
              <fm-icon name="capture" [size]="18" />
              {{ i18n.t('transactions.addTitle') }}
            </h2>
          </div>

          <form class="form" [formGroup]="form" (ngSubmit)="submit()" novalidate>
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

            @if (!splitMode()) {
              <label class="field">
                <span class="field__label">{{ i18n.t('transactions.category') }}</span>
                <select class="field__input" formControlName="categoryId">
                  <option value="">{{ i18n.t('transactions.noCategory') }}</option>
                  @for (category of matchingCategories(); track category.id) {
                    <option [value]="category.id">{{ categoryLabel(category) }}</option>
                  }
                </select>
              </label>
            }

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

            <!-- Splits are a create-time concept: the API cannot divide an existing Transaction,
                 which the edit sheet states outright rather than hiding. -->
            <div class="mode">
              <label class="mode__option">
                <input
                  type="radio"
                  name="mode"
                  [checked]="!splitMode()"
                  (change)="setSplitMode(false)"
                />
                <span>{{ i18n.t('transactions.singleCategory') }}</span>
              </label>
              <label class="mode__option">
                <input
                  type="radio"
                  name="mode"
                  [checked]="splitMode()"
                  (change)="setSplitMode(true)"
                />
                <span>{{ i18n.t('transactions.splitAcross') }}</span>
              </label>
            </div>

            @if (splitMode()) {
              <div class="splits">
                <p class="hint">{{ i18n.t('transactions.splitHint') }}</p>

                @for (draft of splitDrafts(); track $index; let index = $index) {
                  <div class="splits__row">
                    <select
                      class="field__input"
                      [value]="draft.categoryId"
                      (change)="setSplitCategory(index, $any($event.target).value)"
                      [attr.aria-label]="i18n.t('transactions.category') + ' ' + (index + 1)"
                    >
                      <option value="">{{ i18n.t('transactions.noCategory') }}</option>
                      @for (category of matchingCategories(); track category.id) {
                        <option [value]="category.id">{{ categoryLabel(category) }}</option>
                      }
                    </select>
                    <input
                      class="field__input splits__amount"
                      type="text"
                      inputmode="decimal"
                      [value]="draft.amountText"
                      (input)="setSplitAmount(index, $any($event.target).value)"
                      [attr.aria-label]="i18n.t('transactions.amount') + ' ' + (index + 1)"
                    />
                    <button
                      class="splits__remove"
                      type="button"
                      (click)="removeSplitRow(index)"
                      [attr.aria-label]="i18n.t('transactions.removeSplit')"
                    >
                      ×
                    </button>
                  </div>
                }

                <div class="splits__actions">
                  <button class="link" type="button" (click)="addSplitRow()">
                    {{ i18n.t('transactions.addSplit') }}
                  </button>
                  <button class="link" type="button" (click)="splitEvenly()">
                    {{ i18n.t('transactions.splitEvenly') }}
                  </button>
                </div>

                @if (splitMessage(); as message) {
                  <p class="hint" [class.hint--warn]="!splitsBalanced()">{{ message }}</p>
                }
              </div>
            }

            <button class="fm-btn fm-btn--primary form__submit" type="submit" [disabled]="creating()">
              {{ creating() ? i18n.t('transactions.submitting') : i18n.t('transactions.submit') }}
            </button>
          </form>
        </section>

        <section class="toolbar">
          <label class="field field--search">
            <span class="field__label">{{ i18n.t('transactions.search') }}</span>
            <input
              class="field__input"
              type="search"
              [value]="filters().search"
              [placeholder]="i18n.t('transactions.searchPlaceholder')"
              (input)="onSearch($any($event.target).value)"
            />
          </label>
        </section>

        @if (filtersOpen()) {
          <section class="filters">
            <label class="field">
              <span class="field__label">{{ i18n.t('transactions.kind') }}</span>
              <select
                class="field__input"
                [value]="filters().kind"
                (change)="setFilter('kind', $any($event.target).value)"
              >
                <option value="">{{ i18n.t('transactions.allKinds') }}</option>
                <option value="EXPENSE">{{ i18n.t('transactionKind.EXPENSE') }}</option>
                <option value="INCOME">{{ i18n.t('transactionKind.INCOME') }}</option>
              </select>
            </label>

            <label class="field">
              <span class="field__label">{{ i18n.t('transactions.category') }}</span>
              <select
                class="field__input"
                [value]="filters().categoryId"
                (change)="setFilter('categoryId', $any($event.target).value)"
              >
                <option value="">{{ i18n.t('transactions.allCategories') }}</option>
                @for (category of categories(); track category.id) {
                  <option [value]="category.id">{{ categoryLabel(category) }}</option>
                }
              </select>
            </label>

            <label class="field">
              <span class="field__label">{{ i18n.t('transactions.account') }}</span>
              <select
                class="field__input"
                [value]="filters().accountId"
                (change)="setFilter('accountId', $any($event.target).value)"
              >
                <option value="">{{ i18n.t('transactions.allAccounts') }}</option>
                @for (account of accounts(); track account.id) {
                  <option [value]="account.id">{{ account.name }}</option>
                }
              </select>
            </label>

            <label class="field">
              <span class="field__label">{{ i18n.t('transactions.from') }}</span>
              <input
                class="field__input"
                type="date"
                [value]="filters().from"
                (change)="setFilter('from', $any($event.target).value)"
              />
            </label>

            <label class="field">
              <span class="field__label">{{ i18n.t('transactions.to') }}</span>
              <input
                class="field__input"
                type="date"
                [value]="filters().to"
                (change)="setFilter('to', $any($event.target).value)"
              />
            </label>

            <label class="mode__option">
              <input
                type="checkbox"
                [checked]="filters().needsReviewOnly"
                (change)="setFilter('needsReviewOnly', $any($event.target).checked)"
              />
              <span>{{ i18n.t('transactions.onlyNeedsReview') }}</span>
            </label>
          </section>
        }

        @if (loading()) {
          <!-- The ledger's rows share one card, so the placeholder does too. -->
          <div class="fm-card">
            <fm-avatar-loader [rows]="5" />
          </div>
        } @else if (rows().length === 0) {
          <div class="empty">
            @if (hasFilters()) {
              <p class="empty__title">{{ i18n.t('transactions.emptyFilteredTitle') }}</p>
              <p class="empty__body">{{ i18n.t('transactions.emptyFilteredBody') }}</p>
            } @else {
              <p class="empty__title">{{ i18n.t('transactions.emptyTitle') }}</p>
              <p class="empty__body">{{ i18n.t('transactions.emptyBody') }}</p>
            }
          </div>
        } @else {
          <!-- One card around one table (ADR-039). Twenty bordered row cards became rows of a single
               ledger: the day is a full-width header row inside its own tbody, and a Transaction is a
               row with no border or radius of its own. The row stays one click target — the button in
               the first cell stretches over the whole line (see .ledger__open), so the behaviour is
               exactly what the card list had. -->
          <div class="fm-card fm-card--flush">
            <table class="fm-table ledger">
              @for (group of groups(); track group.date) {
                <tbody>
                  <tr class="ledger__day">
                    <th colspan="3" scope="rowgroup" class="ledger__day-head">
                      <span class="day__head">
                        <span class="day__date">{{ dayLabel(group.date) }}</span>
                        <span class="day__totals">
                          @if (group.expenseTotal; as spent) {
                            <span>{{ i18n.t('transactions.daySpent', { amount: amountText(spent) }) }}</span>
                          }
                          @if (group.incomeTotal; as received) {
                            <span>
                              {{ i18n.t('transactions.dayReceived', { amount: amountText(received) }) }}
                            </span>
                          }
                          @if (!group.expenseTotal && !group.incomeTotal) {
                            <span class="day__partial">{{ i18n.t('transactions.dayPartial') }}</span>
                          }
                        </span>
                      </span>
                    </th>
                  </tr>

                  @for (row of group.rows; track row.id) {
                    <tr class="ledger__row">
                      <td>
                        <button class="ledger__open" type="button" (click)="editing.set(row)">
                          <span class="row__desc">{{ row.description }}</span>
                          <span class="row__meta">
                            {{ row.categoryId ? categoryName(row.categoryId) : categoryLabelOf(row) }}
                            @if (row.status !== 'CONFIRMED') {
                              · {{ statusLabel(row.status) }}
                            }
                            @if (row.needsReview) {
                              <span class="row__flag">{{ i18n.t('transactions.needsReview') }}</span>
                            }
                          </span>
                        </button>
                      </td>
                      <td class="ledger__amount">
                        <fm-money class="row__amount" [amount]="row.amount" [direction]="row.kind" />
                      </td>
                      <td class="ledger__edit">
                        <span class="row__edit">{{ i18n.t('transactions.edit') }}</span>
                      </td>
                    </tr>
                  }
                </tbody>
              }

              @if (hasMore()) {
                <tfoot>
                  <tr>
                    <td colspan="3" class="ledger__more">
                      <button
                        class="fm-btn more"
                        type="button"
                        [disabled]="loadingMore()"
                        (click)="loadMore()"
                      >
                        {{
                          loadingMore()
                            ? i18n.t('transactions.loadingMore')
                            : i18n.t('transactions.loadMore')
                        }}
                      </button>
                    </td>
                  </tr>
                </tfoot>
              }
            </table>
          </div>
        }
      }

      @if (editing(); as row) {
        <fm-transaction-detail
          [transaction]="row"
          [categories]="categories()"
          (saved)="reload()"
          (deleted)="reload()"
          (closed)="closeDetail()"
        />
      }
    </div>
  `,
  styles: [
    `
      .muted {
        margin: 0;
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
      /* The create panel's form. The card around it is .fm-card, so only the field grid lives here. */
      .form {
        display: grid;
        gap: var(--space-3);
      }
      @media (min-width: 768px) {
        .form {
          grid-template-columns: 1fr 1fr;
        }
        .form__submit,
        .mode,
        .splits {
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
      .form__submit {
        justify-self: start;
      }
      .mode {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-4);
      }
      .mode__option {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-sm);
        /* Same reason as the notification switch: the radio it wraps is 13 px (4.3.1e). */
        min-block-size: var(--control-size);
      }
      .splits {
        display: grid;
        gap: var(--space-2);
        padding: var(--space-3);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
      }
      .splits__row {
        display: grid;
        grid-template-columns: 1fr 1fr auto;
        gap: var(--space-2);
        align-items: center;
      }
      /* Below this the category select is too narrow to read ("Hrana › Namirnice" truncates to a
         few characters), so the row becomes two: the category on its own line, then amount + remove. */
      @media (max-width: 559px) {
        .splits__row {
          grid-template-columns: 1fr auto;
        }
        .splits__row > .field__input:first-child {
          grid-column: 1 / -1;
        }
      }
      .splits__actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-4);
      }
      .splits__remove {
        padding: 0 var(--space-2);
        font: inherit;
        font-size: var(--text-lg);
        line-height: 1;
        color: var(--color-text-subtle);
        background: none;
        border: none;
        cursor: pointer;
      }
      .hint {
        margin: 0;
        color: var(--color-text-subtle);
        font-size: var(--text-xs);
      }
      .hint--warn {
        color: var(--color-warning);
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: end;
        gap: var(--space-3);
      }
      .field--search {
        flex: 1 1 14rem;
      }
      .link {
        padding: 0;
        font: inherit;
        font-size: var(--text-sm);
        color: var(--color-primary-text);
        background: none;
        border: none;
        cursor: pointer;
        text-decoration: underline;
      }
      .dot {
        display: inline-block;
        inline-size: 0.45rem;
        block-size: 0.45rem;
        border-radius: 50%;
        background: var(--color-primary);
        vertical-align: middle;
      }
      .filters {
        display: grid;
        gap: var(--space-3);
        padding: var(--space-4);
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
      }
      @media (min-width: 768px) {
        .filters {
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          align-items: end;
        }
      }
      /* ---- the ledger ----
         One flush card holding one table (ADR-039). A day is a full-width header row inside its own
         tbody; a Transaction is a row. Nothing below is a card: no radius, no side borders, only the
         shared .fm-table row divider. The hover fill comes from .fm-table itself. */
      .ledger__day:hover {
        background: transparent;
      }
      /* A cached row is not a control, so it must not light up on hover like one. */
      .ledger__row--cached:hover {
        background: transparent;
      }
      /* .fm-table th carries the uppercase column-header treatment; a day header is a date, not a
         column label, so the case and tracking are reset here and the row lays itself out. */
      .ledger__day-head {
        padding-block: var(--space-2);
        font-size: var(--text-sm);
        text-transform: none;
        letter-spacing: normal;
      }
      .day__head {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-2);
      }
      .day__date {
        font-weight: var(--weight-semibold);
        color: var(--color-text-muted);
      }
      .day__totals {
        display: flex;
        gap: var(--space-3);
        font-size: var(--text-xs);
        font-weight: var(--weight-normal);
        color: var(--color-text-subtle);
      }
      .day__partial {
        font-style: italic;
      }
      /* The last row of a day still closes the day: the shared table drops the divider on a tbody's
         final row, which would leave one group running into the next. */
      .ledger tbody tr:last-child td {
        border-block-end: 1px solid var(--color-border);
      }
      .ledger tbody:last-child tr:last-child td {
        border-block-end: none;
      }
      /* The row's whole line is the click target: the button in the first cell stretches over the table
         row, so clicking the amount opens the sheet exactly as the old card-wide button did. */
      .ledger__row {
        position: relative;
      }
      .ledger__open {
        display: grid;
        gap: var(--space-1);
        inline-size: 100%;
        padding: 0;
        font: inherit;
        text-align: start;
        color: inherit;
        background: none;
        border: none;
        cursor: pointer;
      }
      .ledger__open::after {
        content: '';
        position: absolute;
        inset: 0;
      }
      .ledger__amount {
        text-align: end;
        white-space: nowrap;
      }
      .ledger__edit {
        text-align: end;
      }
      /* Below this the third column only takes width from the description, and it is a hover-only
         affordance — there is no hover on a phone, so at 320 px the description column was narrow
         enough to break words in half. The row is the button either way. */
      @media (max-width: 559px) {
        .ledger__edit {
          display: none;
        }
      }
      .ledger__more {
        padding: var(--space-3) var(--space-4);
      }
      /* The cached mode (4.2.8b): one provenance line for every row below it, never per row
         (ADR-027 decision 4), plus a read-only row that plainly is not a button. */
      .cached {
        padding: var(--space-3) var(--space-4);
        margin-block-end: var(--space-4);
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
      }
      .cached__asof {
        margin: 0;
        color: var(--color-text-subtle);
        font-size: var(--text-xs);
        font-style: italic;
      }
      .cached__body {
        margin: var(--space-1) 0 0;
        color: var(--color-text-muted);
        font-size: var(--text-sm);
      }
      /* The cached row's content, without the live row's affordances: no hover, no cursor, no edit
         label. It is the same cell as the live row's, so the two ledgers have one geometry. */
      .row__main {
        display: grid;
        gap: var(--space-1);
        min-inline-size: 0;
      }
      .row__desc {
        overflow-wrap: anywhere;
      }
      .row__meta {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
        /* A wrapped flex line still refuses to go below the longest word, and a table column sizes to
           that min-content: a long category path pushed the whole ledger 27 px past its card at 320 px
           (the flush card clips, so the amount column was cut). Allowing a break anywhere lets the
           column shrink, which is what the free-flowing card layout used to do. */
        overflow-wrap: anywhere;
      }
      .row__flag {
        color: var(--color-warning);
      }
      .row__amount {
        font-weight: var(--weight-semibold);
      }
      /* The edit affordance is visible only on hover/focus: it is a repeated action, and a column of
         "Edit" labels competes with the amounts. The row is a real button either way. */
      .row__edit {
        display: none;
        font-size: var(--text-xs);
        color: var(--color-primary-text);
      }
      .ledger__row:hover .row__edit,
      .ledger__row:focus-within .row__edit {
        display: inline;
      }
      /* Paging sits in the ledger's own footer, so a short last page still reads as part of the table.
         The box is the shared button; the brand-coloured label is the colour this control already
         carried, kept rather than reset to the shared button's ink. */
      .more {
        inline-size: 100%;
        color: var(--color-primary-text);
      }
    `,
  ],
})
export class TransactionsComponent {
  readonly i18n = inject(I18nService);
  private readonly graphql = inject(GraphqlClient);
  private readonly errors = inject(ErrorMessageService);
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly ledger = inject(LedgerCacheService);

  readonly rows = signal<readonly TransactionRow[]>([]);
  readonly categories = signal<readonly CategoryOption[]>([]);
  readonly accounts = signal<readonly AccountOption[]>([]);
  readonly totalCount = signal(0);
  readonly filters = signal<TransactionFilters>(emptyFilters());
  readonly filtersOpen = signal(false);
  readonly loading = signal(true);
  readonly loadingMore = signal(false);
  readonly creating = signal(false);
  readonly exporting = signal(false);
  readonly error = signal<string | null>(null);
  readonly editing = signal<TransactionRow | null>(null);
  readonly splitMode = signal(false);
  readonly splitDrafts = signal<readonly SplitDraft[]>([]);

  /**
   * The rows served from the ledger cache, or `null` when the list on screen came from the server.
   *
   * A mode, not a fallback list: ADR-027 decision 2 makes provenance the label, so the screen renders
   * *either* the live list *or* the cached one, and the cached arm carries the `podaci od <time>` line
   * and no controls that need a connection.
   */
  readonly cached = signal<LedgerSnapshot | null>(null);

  private cursor: string | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * A signal, not a field, because `groups` reads it: a plain property read inside a `computed` is
   * not tracked, so the day totals would keep the stale "there is another page" answer whenever the
   * two happened to change separately.
   */
  private readonly hasMoreRows = signal(false);

  readonly form = this.fb.nonNullable.group({
    amount: ['', [Validators.required]],
    description: ['', [Validators.required, Validators.maxLength(200)]],
    kind: ['EXPENSE' as TransactionKind, [Validators.required]],
    categoryId: [''],
    accountId: ['', [Validators.required]],
    occurredOn: [new Date().toISOString().slice(0, 10), [Validators.required]],
  });

  private readonly http = inject(HttpClient);

  readonly noAccounts = computed(() => !this.loading() && this.accounts().length === 0);
  readonly hasFilters = computed(() => hasActiveFilters(this.filters()));
  readonly hasMore = computed(() => this.hasMoreRows());
  readonly groups = computed(() => groupByDay(this.rows(), this.hasMoreRows()));

  /**
   * The cached rows, grouped like the live ones but off {@link LedgerSnapshot} (task 4.2.8b).
   *
   * Empty while the list is live, so `@if (cached())` and this agree about the mode.
   */
  readonly cachedGroups = computed(() => {
    const record = this.cached();
    return record === null ? [] : groupCachedByDay(record.rows, record.currency);
  });

  /**
   * The `podaci od <time>` line, or `null` when the rows are live.
   *
   * One label for the serving mode, not one per day or per row (ADR-027 decision 4). It reads the
   * *cache service's* provenance rather than the component's own copy of the record, so the label and
   * the rows cannot disagree: the signal is set by `readRows` and cleared by `writeRows`/`reset`, and
   * every successful read hits one of those two. Live rows render **no** label — if everything were
   * labelled, the label would stop meaning anything.
   */
  readonly staleLabel = computed(() => {
    const syncedAt = this.ledger.staleAt();
    return syncedAt === null ? null : syncedAtLabel(syncedAt, this.i18n.tag());
  });

  /** How many rows the cached mode is showing. Never `totalCount`: a cache knows only its own window. */
  readonly cachedCount = computed(() => this.cached()?.rows.length ?? 0);

  readonly matchingCategories = computed(() => {
    const kind = this.form.controls.kind.value;
    return this.categories().filter((category) => category.kind === kind);
  });

  readonly currency = computed(() => {
    const accountId = this.form.controls.accountId.value;
    return this.accounts().find((account) => account.id === accountId)?.currency ?? 'RSD';
  });

  readonly amountHint = computed(() => {
    const raw = this.form.controls.amount.value;
    if (!raw.trim()) return null;
    const parsed = parseAmount(raw, this.currency());
    if (!parsed.money) return this.i18n.t('transactions.amountUnreadable');
    if (parsed.ambiguous) {
      return this.i18n.t('transactions.amountAmbiguous', {
        reading: toMajorString(parsed.money.amountMinor, this.currency()),
      });
    }
    return null;
  });

  /** The parsed total, or null while the field is unreadable — the split check needs it. */
  private readonly total = computed<Money | null>(() => {
    const parsed = parseAmount(this.form.controls.amount.value, this.currency());
    return parsed.money && parsed.money.amountMinor > 0n ? parsed.money : null;
  });

  private readonly splitTotals = computed<readonly (Money | null)[]>(() =>
    this.splitDrafts().map((draft) => parseAmount(draft.amountText, this.currency()).money),
  );

  readonly splitTotal = computed(() => totalOf(this.splitTotals().filter(isMoney)));

  /**
   * Whether the parts add up.
   *
   * Checked against the parsed total using integer minor units, so "adds up" means exactly that.
   * The server re-validates (I-1) — this exists so the user is told before saving, not to replace
   * the check that matters.
   */
  readonly splitsBalanced = computed(() => {
    const total = this.total();
    const sum = this.splitTotal();
    if (!total || !sum) return false;
    return equalsMoney(total, sum);
  });

  readonly splitMessage = computed(() => {
    if (!this.splitMode()) return null;
    if (this.splitDrafts().length < 2) return this.i18n.t('transactions.splitNeedsTwo');
    if (!this.total()) return this.i18n.t('transactions.splitNoAmount');
    if (!this.splitsBalanced()) {
      const sum = this.splitTotal();
      return this.i18n.t('transactions.splitMismatch', {
        sum: sum ? this.amountText(sum) : '—',
        total: this.amountText(this.total() as Money),
      });
    }
    return this.i18n.t('transactions.splitBalanced');
  });

  constructor() {
    // A drill-through arrives as query parameters — the assistant's `drillThrough.filter` names
    // exactly these keys (docs/06 §4.4) — so they are read into the filter **before** the first load.
    // Applying them afterwards would paint an unfiltered list and then replace it, which reads as the
    // data changing under the user.
    //
    // The direction is one-way: the screen reads the URL and never writes its own filters back to it.
    // A filter edit is not a navigation, and writing one would make every keystroke a history entry —
    // and would fight this subscription.
    const readParams = (params: ParamMap): Record<string, string | null> =>
      Object.fromEntries(params.keys.map((key) => [key, params.get(key)]));

    this.filters.set(filtersFromQuery(readParams(this.route.snapshot.queryParamMap)));

    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const next = filtersFromQuery(readParams(params), this.filters());
      // `queryParamMap` replays the current value on subscribe, so comparing first avoids a second
      // fetch for a screen that was opened with no drill-through at all.
      if (JSON.stringify(next) === JSON.stringify(this.filters())) return;
      this.filters.set(next);
      void this.reload();
    });

    // The `/transactions/:id` drill-in (docs/02 §2.1). It is read from the same `ActivatedRoute` the
    // filters come from rather than split across two mechanisms: this screen owns one URL contract,
    // and a deep link has to work for a row that is not on the current page — a posted receipt's
    // Transaction, an old correction — so it is fetched by id rather than looked up in `rows()`.
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const id = params.get('id');
      if (id !== null) void this.openById(id);
    });

    void this.load();
  }

  /**
   * Open one Transaction in the edit sheet, fetched by id.
   *
   * A row the list does not hold is the normal case for a deep link, so a miss is not an error here;
   * an id the API refuses is, and it lands in the screen's banner like every other failure.
   */
  private async openById(id: string): Promise<void> {
    this.error.set(null);
    try {
      const data = await this.graphql.query<{ transaction: TransactionRow }>(TRANSACTION, { id });
      // A slow response for a previous id must not replace the row the user is looking at.
      if (this.route.snapshot.paramMap.get('id') !== id) return;
      this.editing.set(data.transaction);
    } catch (error) {
      this.error.set(this.errors.for(error));
    }
  }

  /**
   * Close the edit sheet.
   *
   * When the sheet was opened **by URL**, dismissing it must also leave that URL: the id addresses a
   * row the user has just dismissed, and a reload would otherwise reopen it. Opening the same screen
   * from the list stays a filter edit — no navigation, no history entry.
   */
  closeDetail(): void {
    if (this.route.snapshot.paramMap.get('id') !== null) {
      void this.router.navigate(['/transactions']);
      return;
    }
    this.editing.set(null);
    void this.reload();
  }

  // -------------------------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------------------------

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);

    // Taxonomy first, but **not fatally**: it feeds the create form and the category filter, and a
    // ledger snapshot is a read-only view. Failing the whole screen because the category list did not
    // arrive would throw away rows the device already has (4.2.8b).
    await this.loadTaxonomy();

    await this.readFirstPage();
    this.loading.set(false);
  }

  /** The accounts and categories the form needs. A failure here is not a failure of the list. */
  private async loadTaxonomy(): Promise<void> {
    try {
      const taxonomy = await this.graphql.query<{
        accounts: { edges: { node: AccountOption }[] };
        categories: CategoryOption[];
      }>(TAXONOMY_QUERY);

      this.accounts.set(taxonomy.accounts.edges.map((edge) => edge.node));
      this.categories.set(taxonomy.categories);

      const firstAccount = this.accounts()[0];
      if (firstAccount) this.form.controls.accountId.setValue(firstAccount.id);
    } catch {
      // Nothing to say here: if the ledger read also failed, *it* reports the reason, and if it
      // succeeded the list is correct even though the form has no accounts to offer.
    }
  }

  /**
   * Read the first page, and serve the ledger cache when the read fails (task 4.2.8b, ADR-027).
   *
   * Two rules decide whether the cache may stand in for the server, and both come from the cache's own
   * shape rather than from convenience:
   *
   * - **Only with no filters active.** A filtered read is a subset, and the cache is the *ledger's*
   *   window — serving it after a failed search would show rows the search excluded and present them
   *   as the answer. With a filter on, a failed read keeps the honest error state.
   * - **Only when something was cached.** No record, an expired one (24 h TTL) or an unreadable store
   *   all mean the same thing: there is nothing honest to show, so the error stands rather than a zero
   *   or an empty list that looks like a quiet month (ADR-027 decision 3).
   */
  private async readFirstPage(): Promise<void> {
    try {
      await this.fetchPage({ reset: true });
      // A live read supersedes the cached mode, including the label. `writeRows` clears the provenance
      // when it stores a record; this covers the success that stores nothing (no rows, or a filter on).
      this.cached.set(null);
      this.ledger.reset();
      // The error is **not** cleared here. `load()` clears it once up front, and a successful list read
      // must not wipe a message another concurrent path just wrote: the `/transactions/:id` drill-in
      // runs beside this one, and clearing here would swallow its refusal (the spec caught this).
      return;
    } catch (error) {
      const fallback = await this.cachedFirstPage();
      if (fallback !== null) {
        this.cached.set(fallback);
        // A live page must not linger behind a cached one: the label covers the whole mode, so rows
        // that came from the server may not sit under a `podaci od` line they are not part of.
        this.rows.set([]);
        this.hasMoreRows.set(false);
        this.cursor = null;
        this.error.set(null);
        return;
      }

      // No cache: clear anything a previous read left, so an unlabelled stale row cannot render
      // beside the error (ADR-027 decisions 2 and 3).
      this.cached.set(null);
      this.rows.set([]);
      this.error.set(this.errors.for(error));
    }
  }

  /** The cached record, or `null` when there is none, it expired, or the store would not open. */
  private async cachedFirstPage(): Promise<LedgerSnapshot | null> {
    if (hasActiveFilters(this.filters())) return null;
    try {
      return await this.ledger.readRows();
    } catch {
      return null;
    }
  }

  async reload(): Promise<void> {
    await this.readFirstPage();
  }

  async loadMore(): Promise<void> {
    if (this.loadingMore() || !this.hasMoreRows()) return;
    this.loadingMore.set(true);
    try {
      await this.fetchPage({ reset: false });
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.loadingMore.set(false);
    }
  }

  private async fetchPage(options: { reset: boolean }): Promise<void> {
    const variables = toQueryVariables(this.filters(), {
      first: PAGE_SIZE,
      after: options.reset ? null : this.cursor,
    });

    const result = await this.graphql.query<{
      transactions: {
        totalCount: number;
        pageInfo: { endCursor: string | null; hasNextPage: boolean };
        edges: { node: TransactionRow }[];
      };
    }>(TRANSACTIONS_QUERY, variables);

    const page = result.transactions.edges.map((edge) => edge.node);
    this.rows.set(options.reset ? page : [...this.rows(), ...page]);
    this.cursor = result.transactions.pageInfo.endCursor;
    this.hasMoreRows.set(result.transactions.pageInfo.hasNextPage);
    this.totalCount.set(result.transactions.totalCount);

    if (options.reset) await this.cachePage(page);
  }

  /**
   * Keep the first page for offline reading (task 4.2.8b).
   *
   * **A side effect of a successful read, never a reason to hide one** — and never on a timer
   * (ADR-027 decision 6). Three conditions, each of which would otherwise make the cache lie:
   *
   * - **no active filters**, because a filtered page is a subset and the cache is the ledger's window;
   * - **at least one row**, because there is nothing to render from an empty record and writing one
   *   would only convert "no cache" into "an empty ledger";
   * - a currency, taken from the rows themselves — the server sends it on every amount, and a cached
   *   row cannot become `Money` without one (ADR-003).
   *
   * `today` is the device's local day, the same expression the create form uses for its default date.
   * It anchors `selectLedgerRows`'s symmetric ±45-day window, so an offset at the margin can drop at
   * most the oldest day of a 200-row cap.
   */
  private async cachePage(page: readonly TransactionRow[]): Promise<void> {
    const first = page[0];
    if (first === undefined || hasActiveFilters(this.filters())) return;

    try {
      await this.ledger.writeRows(
        page.map((row) => ({
          amountMinor: row.amount.amountMinor,
          kind: row.kind,
          occurredLocalDate: row.occurredLocalDate,
          description: row.description,
          // A divided Transaction has no category of its own, and the cache holds one per row — so it
          // caches as `null`, which the cached list renders as *nothing* rather than as "uncategorised"
          // (see the service's header).
          category: row.categoryId
            ? { id: row.categoryId, name: this.categoryName(row.categoryId) }
            : null,
        })),
        new Date().toISOString().slice(0, 10),
        first.amount.currency,
      );
    } catch {
      // A store that will not open must not turn a live list into an error screen.
    }
  }

  // -------------------------------------------------------------------------------------------
  // Filters
  // -------------------------------------------------------------------------------------------

  onSearch(value: string): void {
    this.filters.update((current) => ({ ...current, search: value }));
    clearTimeout(this.searchTimer);
    // Debounced: a keystroke per request would queue a query per character typed.
    this.searchTimer = setTimeout(() => void this.reload(), SEARCH_DEBOUNCE_MS);
  }

  setFilter<K extends keyof TransactionFilters>(key: K, value: TransactionFilters[K]): void {
    this.filters.update((current) => ({ ...current, [key]: value }));
    void this.reload();
  }

  clearFilters(): void {
    this.filters.set(emptyFilters());
    void this.reload();
  }

  /**
   * Download the filtered Transactions as CSV (F-25).
   *
   * Fetched through `HttpClient` rather than a plain link so failures land in the screen's error
   * banner: a bare `href` would hand the user a downloaded file containing the API's JSON error,
   * which looks like a corrupt export rather than a message. Going through the client also means the
   * request carries the session cookies via the credentials interceptor, like every other call.
   */
  async exportCsv(): Promise<void> {
    if (this.exporting()) return;
    this.exporting.set(true);
    this.error.set(null);
    try {
      const response = await firstValueFrom(
        this.http.get(exportUrl(this.filters()), { observe: 'response', responseType: 'text' }),
      );

      const filename =
        filenameFromContentDisposition(response.headers.get('content-disposition')) ??
        'transactions.csv';
      saveTextFile(response.body ?? '', filename);
    } catch (error) {
      // A blob-free `text` response means a JSON error body still arrives as readable text, so the
      // typed code survives instead of becoming a Blob the banner cannot interpret.
      this.error.set(this.errors.for(fromHttpError(error)));
    } finally {
      this.exporting.set(false);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------------------------

  setSplitMode(enabled: boolean): void {
    this.splitMode.set(enabled);
    if (enabled && this.splitDrafts().length === 0) {
      this.addSplitRow();
      this.addSplitRow();
    }
  }

  addSplitRow(): void {
    this.splitDrafts.update((drafts) => [...drafts, { categoryId: '', amountText: '' }]);
  }

  removeSplitRow(index: number): void {
    this.splitDrafts.update((drafts) => drafts.filter((_, at) => at !== index));
  }

  setSplitCategory(index: number, categoryId: string): void {
    this.splitDrafts.update((drafts) =>
      drafts.map((draft, at) => (at === index ? { ...draft, categoryId } : draft)),
    );
  }

  setSplitAmount(index: number, amountText: string): void {
    this.splitDrafts.update((drafts) =>
      drafts.map((draft, at) => (at === index ? { ...draft, amountText } : draft)),
    );
  }

  /**
   * Ask the backend to divide the total evenly.
   *
   * Deliberately a round trip rather than a local division: the API's `proposeEqualSplits` runs the
   * same largest-remainder allocation as `createTransaction`, so the numbers the user approves are
   * the numbers that will be stored. Dividing in the UI would be a second implementation of the
   * rounding rule, and the two would eventually disagree by a para (I-1).
   */
  async splitEvenly(): Promise<void> {
    const total = this.total();
    if (!total) {
      this.error.set(this.i18n.t('transactions.splitNoAmount'));
      return;
    }

    const categoryIds = this.splitDrafts()
      .map((draft) => draft.categoryId)
      .filter((id) => id !== '');

    if (categoryIds.length < 2) {
      this.error.set(this.i18n.t('transactions.splitNeedsTwo'));
      return;
    }

    try {
      const result = await this.graphql.query<{
        proposeEqualSplits: { amount: { amountMinor: string; currency: string }; categoryId: string }[];
      }>(PROPOSE_EQUAL_SPLITS, {
        amount: { amountMinor: total.amountMinor.toString(), currency: total.currency },
        categoryIds,
      });

      this.splitDrafts.set(
        result.proposeEqualSplits.map((split) => ({
          categoryId: split.categoryId,
          amountText: toMajorString(BigInt(split.amount.amountMinor), split.amount.currency),
        })),
      );
      this.error.set(null);
    } catch (error) {
      this.error.set(this.errors.for(error));
    }
  }

  async submit(): Promise<void> {
    if (this.form.invalid || this.creating()) {
      this.form.markAllAsTouched();
      return;
    }

    const { amount, description, kind, categoryId, accountId, occurredOn } =
      this.form.getRawValue();
    const currency = this.currency();

    const parsed = parseAmount(amount, currency);
    if (!parsed.money || parsed.money.amountMinor <= 0n) {
      this.error.set(this.i18n.t('transactions.amountPositive'));
      return;
    }

    let splits: { categoryId: string; amount: { amountMinor: string; currency: string } }[] | null =
      null;
    if (this.splitMode()) {
      if (!this.splitsBalanced()) {
        this.error.set(this.splitMessage() ?? this.i18n.t('transactions.splitNeedsTwo'));
        return;
      }
      splits = this.splitDrafts().map((draft, index) => ({
        categoryId: draft.categoryId,
        amount: {
          amountMinor: (this.splitTotals()[index] as Money).amountMinor.toString(),
          currency,
        },
      }));
    }

    this.creating.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(CREATE_TRANSACTION, {
        accountId,
        kind,
        amount: { amountMinor: parsed.money.amountMinor.toString(), currency },
        description,
        // `occurredAt` is still a required argument, so a stable instant goes along with it; the
        // server treats `occurredLocalDate` as authoritative for the calendar day (I-2).
        occurredAt: localNoonInstant(occurredOn),
        occurredLocalDate: occurredOn,
        categoryId: splits ? null : categoryId === '' ? null : categoryId,
        splits,
      });

      this.form.patchValue({ amount: '', description: '', categoryId: '' });
      this.splitDrafts.set([]);
      this.splitMode.set(false);
      await this.fetchPage({ reset: true });
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.creating.set(false);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Labels
  // -------------------------------------------------------------------------------------------

  /** `transactionStatus.VOID` and friends. Typed here because a template cannot cast a key. */
  statusLabel(status: TransactionRow['status']): string {
    return this.i18n.t(`transactionStatus.${status}` as TranslationKey);
  }

  categoryLabel(category: CategoryOption): string {
    return category.path.join(' › ');
  }

  categoryName(categoryId: string): string {
    const category = this.categories().find((candidate) => candidate.id === categoryId);
    return category ? category.path.join(' › ') : this.i18n.t('transactions.noCategory');
  }

  /** A split Transaction has no category of its own, so the row says so instead of looking bare. */
  categoryLabelOf(row: TransactionRow): string {
    if (row.splits.length > 0) return this.i18n.t('transactions.splitsTitle');
    return this.i18n.t('transactions.noCategory');
  }

  /**
   * A day as "18 Sep", in the active locale, for a ledger day header.
   *
   * A `LocalDate` is a calendar day, not an instant, so it is read at `T00:00:00Z` with
   * `timeZone: 'UTC'`: formatting it in the device's zone would move a midnight boundary day by one
   * (the same rule the dashboard's `shortDate` follows, and docs/03's date rule).
   */
  dayLabel(date: string): string {
    return new Intl.DateTimeFormat(this.i18n.tag(), {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    }).format(new Date(`${date}T00:00:00Z`));
  }

  /** An amount as text for a translated sentence. Magnitudes only: the sentence carries direction. */
  amountText(value: Money): string {
    // Through the shared formatter, so a day total is grouped and spelled exactly like the fm-money rows
    // beneath it (it used to read "45000.00 RSD" above a row reading "+ RSD 45,000.00").
    return moneyText(
      { amountMinor: value.amountMinor.toString(), currency: value.currency },
      this.i18n.tag(),
    );
  }
}

function isMoney(value: Money | null): value is Money {
  return value !== null;
}

/**
 * Re-shape an `HttpErrorResponse` carrying the API's JSON error so `ErrorMessageService` can read it.
 *
 * The API returns `{ error: { code, message } }`, and the service already knows how to pull a code
 * out of that nesting; it was written for responses parsed as JSON. With a `text` response type the
 * body arrives as a string, so it is parsed here rather than teaching the service about transports.
 */
function fromHttpError(error: unknown): unknown {
  if (!(error instanceof HttpErrorResponse)) return error;
  if (typeof error.error !== 'string') return error;
  try {
    return { error: JSON.parse(error.error) as unknown };
  } catch {
    return error;
  }
}

/** Hand the browser a file. The object URL is revoked, or the blob is never collected. */
function saveTextFile(contents: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
