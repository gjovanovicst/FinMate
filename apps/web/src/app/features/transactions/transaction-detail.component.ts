import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
  type ElementRef,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { parseAmount } from '@finmate/domain';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { GraphqlClient, GraphQLRequestError } from '../../core/graphql/graphql.client';
import { I18nService } from '../../core/i18n/i18n.service';
import type { TranslationKey } from '../../core/i18n/translations';
import { toMajorString } from '../../shared/money-text';
import { MoneyComponent } from '../../shared/ui/money/money.component';
import type { TransactionRow, TransactionStatus } from './transactions.view';

export interface CategoryOption {
  readonly id: string;
  readonly name: string;
  readonly kind: 'EXPENSE' | 'INCOME';
  readonly path: readonly string[];
}

const UPDATE_TRANSACTION = /* GraphQL */ `
  mutation UpdateTransaction(
    $id: ID!
    $version: Int!
    $description: String
    $amount: Money
    $categoryId: ID
    $occurredLocalDate: LocalDate
    $note: String
    $status: TransactionStatus
  ) {
    updateTransaction(
      id: $id
      version: $version
      description: $description
      amount: $amount
      categoryId: $categoryId
      occurredLocalDate: $occurredLocalDate
      note: $note
      status: $status
    ) {
      id
      version
    }
  }
`;

const DELETE_TRANSACTION = /* GraphQL */ `
  mutation DeleteTransaction($id: ID!) {
    deleteTransaction(id: $id)
  }
`;

/**
 * The edit sheet for one Transaction.
 *
 * A native `<dialog>` rather than a hand-rolled overlay: `showModal()` gives focus containment, Esc
 * to dismiss and inertness of the page behind it for free, all of which a div-based modal has to
 * reimplement and usually gets wrong (doc 09 §8 requires keyboard-only operation).
 *
 * Two fields are deliberately **not** editable, and the UI says so rather than failing on save:
 *
 *  - **`kind`** — the API does not accept it. Direction is not a property you flip; a wrong
 *    direction means the row is wrong, so the honest affordance is to delete and re-record.
 *  - **The amount, when the Transaction has splits** — the parts must sum to the total exactly (I-1),
 *    so letting the total be edited on its own would break the invariant. The parts are shown
 *    read-only so the total is at least explicable.
 *
 * `version` rides along on every save, so two devices editing the same row get a CONFLICT instead of
 * the later write silently winning.
 */
@Component({
  selector: 'fm-transaction-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MoneyComponent],
  template: `
    <dialog #dialog class="sheet" (close)="closed.emit()" (cancel)="closed.emit()">
      <form class="sheet__form" [formGroup]="form" (ngSubmit)="save()" novalidate>
        <header class="sheet__head">
          <h2 class="sheet__title">{{ i18n.t('transactions.editTitle') }}</h2>
          <button class="sheet__dismiss" type="button" (click)="dismiss()">
            {{ i18n.t('transactions.close') }}
          </button>
        </header>

        @if (error(); as message) {
          <p class="alert" role="alert">{{ message }}</p>
          @if (conflicted()) {
            <!-- The row moved on under us, so the only useful action is to look again. Saving over
                 it would need a merge decision the user has not been shown. -->
            <button class="sheet__dismiss" type="button" (click)="dismiss()">
              {{ i18n.t('transactions.conflictReload') }}
            </button>
          }
        }

        <!-- Direction is read-only on purpose; see the class doc. -->
        <p class="kind">
          <fm-money [amount]="transaction().amount" [direction]="transaction().kind" />
          <span class="kind__label">{{ kindLabel() }}</span>
        </p>
        <p class="hint">{{ i18n.t('transactions.kindImmutable') }}</p>

        <label class="field">
          <span class="field__label">{{ i18n.t('transactions.description') }}</span>
          <input class="field__input" type="text" formControlName="description" required />
        </label>

        <label class="field">
          <span class="field__label">{{ i18n.t('transactions.amount') }}</span>
          <input
            class="field__input"
            type="text"
            inputmode="decimal"
            formControlName="amount"
            [attr.aria-describedby]="hasSplits() ? 'split-lock' : null"
            autocomplete="off"
          />
          @if (amountHint(); as hint) {
            <span class="field__hint">{{ hint }}</span>
          }
        </label>

        @if (hasSplits()) {
          <p class="hint" id="split-lock">{{ i18n.t('transactions.splitAmountLocked') }}</p>

          <section class="splits">
            <h3 class="splits__title">{{ i18n.t('transactions.splitsTitle') }}</h3>
            <ul class="splits__list">
              @for (split of transaction().splits; track split.id) {
                <li class="splits__row">
                  <span class="splits__name">{{ categoryLabel(split.categoryId) }}</span>
                  <fm-money class="splits__amount" [amount]="split.amount" />
                </li>
              }
            </ul>
            <p class="hint">{{ i18n.t('transactions.splitsReadOnly') }}</p>
          </section>
        } @else {
          <label class="field">
            <span class="field__label">{{ i18n.t('transactions.category') }}</span>
            <select class="field__input" formControlName="categoryId">
              <option value="">{{ i18n.t('transactions.noCategory') }}</option>
              @for (category of matchingCategories(); track category.id) {
                <option [value]="category.id">{{ categoryLabel(category.id) }}</option>
              }
            </select>
          </label>
        }

        <label class="field">
          <span class="field__label">{{ i18n.t('transactions.date') }}</span>
          <input class="field__input" type="date" formControlName="occurredOn" required />
        </label>

        <label class="field">
          <span class="field__label">{{ i18n.t('transactions.status') }}</span>
          <select class="field__input" formControlName="status">
            <option value="CONFIRMED">{{ i18n.t('transactionStatus.CONFIRMED') }}</option>
            <option value="PENDING">{{ i18n.t('transactionStatus.PENDING') }}</option>
            <option value="VOID">{{ i18n.t('transactionStatus.VOID') }}</option>
          </select>
        </label>

        <label class="field">
          <span class="field__label">{{ i18n.t('transactions.note') }}</span>
          <textarea class="field__input" rows="2" formControlName="note"></textarea>
        </label>

        <footer class="sheet__foot">
          <button class="btn btn--primary" type="submit" [disabled]="busy()">
            {{ busy() ? i18n.t('transactions.saving') : i18n.t('transactions.save') }}
          </button>
          <button class="btn btn--danger" type="button" [disabled]="busy()" (click)="remove()">
            {{ busy() ? i18n.t('transactions.deleting') : i18n.t('transactions.delete') }}
          </button>
        </footer>
      </form>
    </dialog>
  `,
  styles: [
    `
      .sheet {
        width: min(560px, calc(100vw - 2rem));
        max-height: calc(100vh - 2rem);
        padding: 0;
        color: var(--color-text);
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
      }
      .sheet::backdrop {
        background: rgb(0 0 0 / 55%);
      }
      .sheet__form {
        display: grid;
        gap: var(--space-3);
        padding: var(--space-5);
      }
      .sheet__head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .sheet__title {
        margin: 0;
        font-size: var(--text-xl);
      }
      .sheet__dismiss {
        padding: 0;
        font: inherit;
        font-size: var(--text-sm);
        color: var(--color-text-muted);
        background: none;
        border: none;
        cursor: pointer;
        text-decoration: underline;
      }
      .alert {
        margin: 0;
        padding: var(--space-3);
        border-radius: var(--radius-md);
        background: color-mix(in srgb, var(--color-danger) 15%, transparent);
        color: var(--color-danger);
        font-size: var(--text-sm);
      }
      .kind {
        display: flex;
        align-items: baseline;
        gap: var(--space-2);
        margin: 0;
        font-size: var(--text-lg);
        font-weight: 600;
      }
      .kind__label {
        color: var(--color-text-muted);
        font-size: var(--text-sm);
        font-weight: 400;
      }
      .hint {
        margin: 0;
        color: var(--color-text-subtle);
        font-size: var(--text-xs);
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
      .splits {
        display: grid;
        gap: var(--space-2);
        padding: var(--space-3);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
      }
      .splits__title {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: 600;
      }
      .splits__list {
        display: grid;
        gap: var(--space-1);
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .splits__row {
        display: flex;
        justify-content: space-between;
        gap: var(--space-3);
        font-size: var(--text-sm);
      }
      .sheet__foot {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-3);
        padding-block-start: var(--space-2);
      }
      .btn {
        padding: var(--space-3) var(--space-5);
        font: inherit;
        font-weight: 600;
        border: 1px solid transparent;
        border-radius: var(--radius-md);
        cursor: pointer;
      }
      .btn:disabled {
        opacity: 0.6;
        cursor: default;
      }
      .btn--primary {
        color: var(--color-primary-contrast);
        background: var(--color-primary);
      }
      .btn--danger {
        color: var(--color-danger);
        background: none;
        border-color: var(--color-danger);
      }
    `,
  ],
})
export class TransactionDetailComponent implements OnInit {
  readonly i18n = inject(I18nService);
  private readonly graphql = inject(GraphqlClient);
  private readonly errors = inject(ErrorMessageService);
  private readonly fb = inject(FormBuilder);

  readonly transaction = input.required<TransactionRow>();
  readonly categories = input.required<readonly CategoryOption[]>();

  readonly saved = output<void>();
  readonly deleted = output<void>();
  readonly closed = output<void>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  /** True when the API refused the write because somebody else changed the row first. */
  readonly conflicted = signal(false);

  readonly hasSplits = computed(() => this.transaction().splits.length > 0);

  readonly form = this.fb.nonNullable.group({
    description: ['', [Validators.required, Validators.maxLength(200)]],
    amount: ['', [Validators.required]],
    categoryId: [''],
    occurredOn: ['', [Validators.required]],
    status: ['CONFIRMED' as TransactionStatus, [Validators.required]],
    note: [''],
  });

  readonly matchingCategories = computed(() => {
    const kind = this.transaction().kind;
    return this.categories().filter((category) => category.kind === kind);
  });

  readonly amountHint = computed(() => {
    const raw = this.form.controls.amount.value;
    if (!raw.trim()) return null;
    const parsed = parseAmount(raw, this.transaction().amount.currency);
    if (!parsed.money) return this.i18n.t('transactions.amountUnreadable');
    if (parsed.ambiguous) {
      return this.i18n.t('transactions.amountAmbiguous', {
        reading: toMajorString(parsed.money.amountMinor, this.transaction().amount.currency),
      });
    }
    return null;
  });

  /** `transactionKind.EXPENSE` and friends. Typed here because a template cannot cast a key. */
  readonly kindLabel = computed(() =>
    this.i18n.t(`transactionKind.${this.transaction().kind}` as TranslationKey),
  );

  constructor() {
    // The dialog is opened here because `afterNextRender` needs an injection context, which a
    // lifecycle hook is not. Reading the required `transaction` input waits for `ngOnInit`, since
    // it has no value yet at construction time.
    afterNextRender(() => this.dialog().nativeElement.showModal());
  }

  ngOnInit(): void {
    const current = this.transaction();
    this.form.patchValue({
      description: current.description,
      // The amount is shown in major units, which is what the user typed in the first place.
      amount: toMajorString(BigInt(current.amount.amountMinor), current.amount.currency),
      categoryId: current.categoryId ?? '',
      occurredOn: current.occurredLocalDate,
      status: current.status,
      note: current.note ?? '',
    });

    // A split Transaction's total is fixed by its parts, so the field is not offered at all rather
    // than offered and then refused (I-1).
    if (this.hasSplits()) this.form.controls.amount.disable();
  }

  dismiss(): void {
    this.dialog().nativeElement.close();
  }

  categoryLabel(categoryId: string): string {
    const category = this.categories().find((candidate) => candidate.id === categoryId);
    return category ? category.path.join(' › ') : this.i18n.t('transactions.noCategory');
  }

  async save(): Promise<void> {
    if (this.form.invalid || this.busy()) {
      this.form.markAllAsTouched();
      return;
    }

    const { description, categoryId, occurredOn, status, note } = this.form.getRawValue();
    const currency = this.transaction().amount.currency;
    const variables: Record<string, unknown> = {
      id: this.transaction().id,
      version: this.transaction().version,
      description,
      // `occurredLocalDate`, not an instant: the server picks the instant so the calendar day cannot
      // be shifted by the Household's timezone (I-2).
      occurredLocalDate: occurredOn,
      note: note.trim() === '' ? null : note,
      status,
    };

    if (!this.hasSplits()) {
      const parsed = parseAmount(this.form.controls.amount.value, currency);
      if (!parsed.money || parsed.money.amountMinor <= 0n) {
        this.error.set(this.i18n.t('transactions.amountPositive'));
        return;
      }
      variables['amount'] = {
        amountMinor: parsed.money.amountMinor.toString(),
        currency,
      };
      // An explicit null clears the category; omitting the key would leave it untouched.
      variables['categoryId'] = categoryId === '' ? null : categoryId;
    }

    this.busy.set(true);
    this.error.set(null);
    this.conflicted.set(false);
    try {
      await this.graphql.query(UPDATE_TRANSACTION, variables);
      this.saved.emit();
      this.dismiss();
    } catch (error) {
      this.conflicted.set(error instanceof GraphQLRequestError && error.code === 'CONFLICT');
      this.error.set(this.errors.for(error));
    } finally {
      this.busy.set(false);
    }
  }

  async remove(): Promise<void> {
    if (this.busy()) return;
    if (!globalThis.confirm(this.i18n.t('transactions.deleteConfirm'))) return;

    this.busy.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(DELETE_TRANSACTION, { id: this.transaction().id });
      this.deleted.emit();
      this.dismiss();
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.busy.set(false);
    }
  }
}
