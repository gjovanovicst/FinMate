import {
  ChangeDetectionStrategy,
  Component,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
  type ElementRef,
  type OnInit,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { parseAmount } from '@finmate/domain';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { GraphqlClient, GraphQLRequestError } from '../../core/graphql/graphql.client';
import { I18nService } from '../../core/i18n/i18n.service';
import { isRetryable } from '../../core/offline/outbox';
import { SyncService } from '../../core/offline/sync.service';
import type { TransactionEditInput } from '../../core/offline/sync.types';
import { planSaveFailure } from './transactions.view';
import type { TranslationKey } from '../../core/i18n/translations';
import { toMajorString } from '../../shared/money-text';
import { MoneyComponent } from '../../shared/ui/money/money.component';
import { ReceiptAttachmentComponent } from '../receipts/receipt-attachment.component';
import { planEdit, type TransactionRow, type TransactionStatus } from './transactions.view';

interface RuleProposal {
  readonly name: string;
  readonly priority: number;
  readonly conditions: unknown;
  readonly actions: unknown;
  readonly origin: string;
  readonly explanation: string;
  readonly explanationCode: string;
  readonly trigger: string;
  readonly confidence: number;
}

interface RuleConflict {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly priority: number;
  readonly overlappingField: string;
  readonly existingValue: string | null;
  readonly proposedValue: string | null;
}

interface CorrectResponse {
  readonly correctTransaction: {
    readonly transaction: { readonly id: string; readonly version: number };
    readonly correction: { readonly id: string; readonly ruleCreatedId: string | null };
    readonly synthesisedRule: RuleProposal | null;
    readonly ruleConflicts: readonly RuleConflict[];
  };
}

interface CreateRuleResponse {
  readonly createRuleFromCorrection: {
    readonly __typename: string;
    readonly rule?: { readonly id: string; readonly name: string };
    readonly code?: string;
    readonly message?: string;
    readonly conflicting?: readonly RuleConflict[];
  };
}

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

/**
 * The learning-loop entry point (docs/06 §5.3).
 *
 * A **category change** goes through this rather than `updateTransaction`, because that is what makes
 * it a Correction — the durable signal docs/04 §6.4's re-fit and rule synthesis both read. Every other
 * field still goes through `updateTransaction`: the learning loop is about categorisation, and
 * recording a `description` tweak as a correction would fill the table with noise.
 */
const CORRECT_TRANSACTION = /* GraphQL */ `
  mutation CorrectTransaction($input: CorrectTransactionInput!) {
    correctTransaction(input: $input) {
      transaction {
        id
        version
      }
      correction {
        id
        field
        fromValue
        toValue
        ruleCreatedId
      }
      synthesisedRule {
        name
        priority
        conditions
        actions
        origin
        explanation
        explanationCode
        trigger
        confidence
      }
      ruleConflicts {
        ruleId
        ruleName
        priority
        overlappingField
        existingValue
        proposedValue
      }
    }
  }
`;

/**
 * Accept a proposal the correction did **not** auto-create.
 *
 * docs/06 §5.3 creates the rule inside `correctTransaction` only when the user ticked "remember" AND
 * the trigger is a resolved entity AND nothing shadows it. Everything else arrives here, where the
 * user answers the prompt — and `RuleShadowedError` comes back as the union's rejection arm rather
 * than an error, because "an existing rule already handles this" is an answer, not a failure.
 */
const CREATE_RULE_FROM_CORRECTION = /* GraphQL */ `
  mutation CreateRuleFromCorrection($input: CreateRuleFromCorrectionInput!) {
    createRuleFromCorrection(input: $input) {
      __typename
      ... on CreateRuleFromCorrectionSuccessModel {
        rule {
          id
          name
        }
      }
      ... on RuleConflictErrorModel {
        code
        message
        conflicting {
          ruleId
          ruleName
          existingValue
        }
      }
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
  imports: [ReactiveFormsModule, MoneyComponent, RouterLink, ReceiptAttachmentComponent],
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

        <!-- F-34: the Receipt photo lives here rather than on /capture, because this is the sheet
             that already owns one Transaction, and commitAttachment links to exactly one. The child
             keeps its own state, so a change is visible without reloading the list, whose rows never
             render an attachment. -->
        <!-- (No backticks in this comment: the template is a JS template literal, and one would end
             it with a parse error that names the wrong line.) -->
        <fm-receipt-attachment
          [transactionId]="transaction().id"
          [attachmentId]="transaction().attachmentId"
        />

        @if (!hasSplits()) {
          <!-- The "Zapamti za ubuduće" checkbox (F-09, docs/02 §3). Only meaningful with a category,
               so it is not offered on a split Transaction, whose categories live on its parts. -->
          <label class="remember">
            <input type="checkbox" formControlName="remember" />
            <span class="remember__label">{{ i18n.t('transactions.remember') }}</span>
          </label>
          <p class="hint">{{ i18n.t('transactions.rememberHint') }}</p>
        }

        @if (proposal(); as offer) {
          <section class="proposal" aria-live="polite">
            <h3 class="proposal__title">{{ i18n.t('transactions.proposalTitle') }}</h3>
            <p class="proposal__text">{{ explain(offer.explanationCode, offer.explanation) }}</p>

            @if (firstConflict(); as conflict) {
              <p class="proposal__warn">
                {{
                  i18n.t('transactions.proposalShadowed', {
                    rule: conflict.ruleName,
                    category: nameOf(conflict.existingValue)
                  })
                }}
              </p>
              <!-- Offered rather than auto-applied: docs/04 §8.2 says surface the conflict and let the
                   user edit the rule that wins, because shadowing rules is how rule sets rot. -->
              <a class="proposal__link" routerLink="/rules">{{ i18n.t('nav.rules') }}</a>
            } @else {
              <div class="proposal__actions">
                <button class="btn btn--primary" type="button" [disabled]="busy()" (click)="acceptProposal()">
                  {{ i18n.t('transactions.proposalAccept') }}
                </button>
                <button class="btn" type="button" (click)="proposal.set(null)">
                  {{ i18n.t('transactions.proposalDismiss') }}
                </button>
              </div>
            }
          </section>
        }

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
        /* dvh, never vh (docs/07 section 4.3): on mobile Safari 100vh is the URL-bar-EXPANDED height, so
           a tall sheet had its own footer — save and delete — clipped off the bottom. min() with the
           doc's 90dvh cap keeps the button on screen and still leaves the 2rem margin when there is room. */
        max-height: min(90dvh, calc(100dvh - 2rem));
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
      .remember {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-sm);
      }
      .proposal {
        display: grid;
        gap: var(--space-2);
        padding: var(--space-3);
        border: 1px solid var(--color-primary);
        border-radius: var(--radius-md);
      }
      .proposal__title {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: 600;
      }
      .proposal__text {
        margin: 0;
        font-size: var(--text-sm);
        overflow-wrap: anywhere;
      }
      .proposal__warn {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--color-warning, #b45309);
      }
      .proposal__link {
        font-size: var(--text-sm);
      }
      .proposal__actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
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
  private readonly sync = inject(SyncService);
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
  /**
   * True when the edit was **queued** because the server could not be reached (task 4.2.7b, ADR-030).
   *
   * The sheet dismisses in that case, like a successful save, because the queue now owns the write —
   * the tray is where it is visible, and pretending it failed would invite the user to type it again.
   */
  readonly queued = signal(false);

  readonly hasSplits = computed(() => this.transaction().splits.length > 0);

  readonly form = this.fb.nonNullable.group({
    // The "Zapamti za ubuduće" checkbox (F-09). Non-nullable so `getRawValue()` reads a real boolean
    // rather than `boolean | null`.
    remember: false,
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

  /**
   * The proposal a correction produced, waiting for an answer.
   *
   * Held after the correction is saved, so the sheet stays open and the prompt has somewhere to live.
   * `null` when there is nothing to offer — either nothing could be derived, or "remember" already
   * created the rule.
   */
  readonly proposal = signal<RuleProposal | null>(null);
  readonly proposalConflicts = signal<readonly RuleConflict[]>([]);

  /** The correction the prompt belongs to, set when the correction is saved. */
  private lastCorrectionId: string | null = null;

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
      // Off by default: a correction is a fact, and turning it into a permanent rule is a separate
      // decision the user makes deliberately (docs/04 §8.2's "never auto-create").
      remember: false,
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

    const { description, categoryId, occurredOn, status, note, remember } = this.form.getRawValue();
    const current = this.transaction();
    const currency = current.amount.currency;

    let amountMinor: bigint | null = null;
    if (!this.hasSplits()) {
      const parsed = parseAmount(this.form.controls.amount.value, currency);
      if (!parsed.money || parsed.money.amountMinor <= 0n) {
        this.error.set(this.i18n.t('transactions.amountPositive'));
        return;
      }
      amountMinor = parsed.money.amountMinor;
    }

    // One definition of "what changed", tested directly: this is the decision that routes a save to
    // `correctTransaction` (which records the learning signal) or to a plain `updateTransaction`.
    const plan = planEdit({
      current,
      categoryId: this.hasSplits() ? null : categoryId === '' ? null : categoryId,
      description,
      occurredOn,
      status,
      note,
      amountMinor: this.hasSplits() ? null : amountMinor,
    });
    const { categoryChanged, otherFieldsChanged, nextCategoryId } = plan;

    this.busy.set(true);
    this.error.set(null);
    this.conflicted.set(false);
    this.proposal.set(null);
    this.proposalConflicts.set([]);
    this.lastCorrectionId = null;

    try {
      // The correction runs FIRST when the category changed, so the learning signal is recorded
      // against the version the user actually read.
      let version = current.version;
      if (categoryChanged) {
        const corrected = await this.graphql.query<CorrectResponse>(CORRECT_TRANSACTION, {
          input: {
            transactionId: current.id,
            version: current.version,
            field: 'category',
            categoryId: nextCategoryId,
            rememberForFuture: remember === true,
          },
        });
        // The correction bumped the version, so the plain edit below must use the new one — reusing
        // the old value would be a CONFLICT against our own write.
        version = corrected.correctTransaction.transaction.version;
        this.captureProposal(corrected);
      }

      // The rest of the fields. `categoryId` is deliberately absent when the correction already
      // applied it: `updateTransaction` treats an omitted field as "untouched", and re-sending the
      // same value would be a no-op edit that still writes a version.
      const edit = {
        id: current.id,
        version,
        description,
        occurredLocalDate: occurredOn,
        note: note.trim() === '' ? null : note,
        status,
        ...(amountMinor === null
          ? {}
          : { amount: { amountMinor: amountMinor.toString(), currency } }),
        ...(categoryChanged ? {} : { categoryId: nextCategoryId }),
      };
      if (otherFieldsChanged) {
        await this.graphql.query(UPDATE_TRANSACTION, { input: edit });
      }

      if (this.proposal() === null) {
        this.saved.emit();
        this.dismiss();
      }
      // Otherwise the sheet stays open with the prompt, and `acceptProposal` finishes the job.
    } catch (error) {
      await this.handleSaveFailure(error, {
        ...(amountMinor === null ? {} : { amount: { amountMinor: amountMinor.toString(), currency } }),
        description,
        occurredLocalDate: occurredOn,
        status,
        categoryId: nextCategoryId,
      });
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Apply {@link planSaveFailure}: a conflict to show, a queued edit, or an error.
   *
   * The decision itself is pure and lives in `transactions.view.ts` with its own spec, because all
   * three branches are silently wrong when they are wrong.
   */
  private async handleSaveFailure(error: unknown, next: Record<string, unknown>): Promise<void> {
    const plan = planSaveFailure({
      error,
      next,
      current: this.transaction(),
      retryable: isRetryable(error),
      isConflict: error instanceof GraphQLRequestError && error.code === 'CONFLICT',
    });

    if (plan.kind === 'CONFLICT') {
      this.conflicted.set(true);
      this.error.set(this.errors.for(error));
      return;
    }
    if (plan.kind === 'ERROR') {
      this.error.set(this.errors.for(error));
      return;
    }
    if (plan.kind === 'REFUSE_CATEGORY') {
      this.error.set(this.i18n.t('transactions.offlineCategory'));
      return;
    }

    await this.sync.enqueueEdit(plan.edit as unknown as TransactionEditInput, plan.before);
    this.queued.set(true);
    this.saved.emit();
    this.dismiss();
  }

  /** Keep whatever the correction offered, so the prompt can be answered after the save. */
  private captureProposal(response: CorrectResponse): void {
    const result = response.correctTransaction;
    this.lastCorrectionId = result.correction.id;
    this.proposalConflicts.set(result.ruleConflicts);

    // A rule already created (the entity + no-conflict case) leaves nothing to ask about.
    if (result.correction.ruleCreatedId !== null) {
      this.proposal.set(null);
      return;
    }
    this.proposal.set(result.synthesisedRule);
  }

  /**
   * Answer the prompt.
   *
   * The rejection arm is a *successful* answer — "an existing rule already handles this" — not a
   * failure, so it is rendered as the conflict it is rather than surfacing as an error.
   */
  async acceptProposal(): Promise<void> {
    if (this.busy() || this.lastCorrectionId === null) return;

    this.busy.set(true);
    this.error.set(null);
    try {
      const response = await this.graphql.query<CreateRuleResponse>(CREATE_RULE_FROM_CORRECTION, {
        input: { correctionId: this.lastCorrectionId, acceptProposal: true },
      });
      const result = response.createRuleFromCorrection;
      if (result.__typename === 'RuleConflictErrorModel') {
        this.proposalConflicts.set(result.conflicting ?? []);
        return;
      }
      this.proposal.set(null);
      this.saved.emit();
      this.dismiss();
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * The rule that beats the proposal, if any.
   *
   * A method rather than `proposalConflicts()[0]` in the template: `noUncheckedIndexedAccess` makes
   * an indexed read possibly-undefined, and a helper that returns `null` is what the `@if … as`
   * binding needs.
   */
  firstConflict(): RuleConflict | null {
    return this.proposalConflicts()[0] ?? null;
  }

  /** The localised explanation, with the server's English sentence as the fallback. */
  explain(code: string, fallback: string): string {
    const key = `rules.explain.${code}` as TranslationKey;
    // `t` returns the key itself when it is unknown, which is how a new server code stays visible
    // rather than blank.
    const localised = this.i18n.t(key);
    return localised === key ? fallback : localised;
  }

  /** A category id as its path, or the raw id when it is not one we loaded. */
  nameOf(categoryId: string | null): string {
    if (categoryId === null) return this.i18n.t('transactions.noCategory');
    return this.categoryLabel(categoryId);
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
