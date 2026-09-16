import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { parseAmount, type ReconciliationState } from '@finmate/domain';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { GraphqlClient } from '../../core/graphql/graphql.client';
import { I18nService } from '../../core/i18n/i18n.service';
import type { TranslationKey } from '../../core/i18n/translations';
import { toMajorString } from '../../shared/money-text';
import { MoneyComponent, type MoneyWire } from '../../shared/ui/money/money.component';
import {
  canPost,
  capturedLabel,
  confidenceBadge,
  postHintKey,
  reconciliationLabelKey,
  toneForState,
  variantForRounding,
  varianceLabelKey,
} from './receipts.view';

/**
 * One Receipt and its mismatch — F-14, docs/02 §4.11, tasks 4.1.4b and 4.1.5.
 *
 * ## The screen answers one question
 *
 * *Do the lines add up to the total?* Everything here exists to make that question answerable and
 * then to let the user act on the answer: the lines, each one's category, and three ways out of a
 * mismatch. The banner states the **exact difference in money** and never a percentage (docs/02
 * §4.11) — a percentage of an unknown total is not an answer, and "3 % off" cannot be reconciled.
 *
 * ## The three gates are the server's, restated — not re-implemented
 *
 * *Napravi transakciju* is enabled only while I-6 holds and every line has a Category, because those
 * are exactly the two refusals `ReceiptsService.commit` raises. The button's `disabled` is a
 * courtesy; the mutation is what enforces it, and this screen shows the API's refusal rather than
 * pretending the write happened. The hint names which gate is closed so the user is not left
 * guessing at a grey button.
 *
 * ## Why every mutation re-reads the Receipt
 *
 * The mutation selections the API documents are deliberately partial (a reconcile returns the items
 * without their `rawText`; a commit returns the link without the lines). Merging a partial answer
 * into the screen's state is how a row silently loses a field, so the mutation is followed by the
 * full `receipt` query. A failed re-read leaves the previous state in place and says nothing: the
 * write landed, and claiming otherwise would make the user repeat an action that already happened.
 *
 * ## What this screen deliberately does not do
 *
 * The photo is rendered from `attachment.downloadUrl` and the *not virus-scanned* fact is **not**
 * repeated here — `fm-receipt-attachment` owns that note, and a second copy is how one screen starts
 * implying a clean bill of health. `quantity` and `unitPrice` have no UI (recorded in docs/02 §4.11).
 * The created Transaction is linked through the **`/transactions/:id` drill-in** (docs/02 §2.1),
 * which screens that row's own edit sheet rather than the list — hunting for the row by hand is the
 * opposite of what a posted receipt is for.
 *
 * @module apps/web/src/app/features/receipts
 */
@Component({
  selector: 'fm-receipt-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MoneyComponent],
  template: `
    <main class="wrap">
      <header class="head">
        <h1 class="head__title">{{ i18n.t('receipts.detail.title') }}</h1>
        <a class="head__back" routerLink="/receipts">{{ i18n.t('receipts.detail.back') }}</a>
      </header>

      @if (loading()) {
        <p class="muted" role="status">{{ i18n.t('receipts.detail.loading') }}</p>
      } @else if (loadError(); as message) {
        <p class="alert" role="alert">{{ message }}</p>
      } @else if (receipt(); as r) {
        <section class="photo">
          @if (image(); as url) {
            <img [src]="url" [attr.alt]="i18n.t('receipts.detail.imageAlt')" />
          } @else {
            <p class="muted small">{{ i18n.t('receipts.detail.noImage') }}</p>
          }
          <p class="muted small">{{ i18n.t('receipts.detail.capturedAt', { date: dateLabel(r.capturedAt) }) }}</p>
        </section>

        <!-- The banner: the state in words, and — for a mismatch only — the difference in money.
             MATCHED and MANUAL "say so"; PENDING says there is no total; a percentage never appears. -->
        <section class="banner banner--{{ tone(r.reconciliation) }}" role="status">
          <p class="banner__state">{{ i18n.t(stateKey(r.reconciliation)) }}</p>
          <p class="banner__text">
            {{ i18n.t(varianceKey(r)) }}
            @if (showVariance(r)) {
              <fm-money class="banner__amount" [amount]="varianceDisplay(r)" />
            }
          </p>
        </section>

        <section class="items" aria-labelledby="receipts-items">
          <h2 class="items__title" id="receipts-items">{{ i18n.t('receipts.items.title') }}</h2>

          @if (r.items.length === 0) {
            <p class="muted small">{{ i18n.t('receipts.items.empty') }}</p>
          }

          <div class="items__table">
            <div class="items__head" aria-hidden="true">
              <span>{{ i18n.t('receipts.items.line') }}</span>
              <span>{{ i18n.t('receipts.items.rawText') }}</span>
              <span>{{ i18n.t('receipts.items.amount') }}</span>
              <span>{{ i18n.t('receipts.items.category') }}</span>
              <span>{{ i18n.t('receipts.items.confidence') }}</span>
              <span></span>
            </div>

            @for (item of r.items; track item.id) {
              <div class="items__row">
                <span class="items__line">{{ item.lineNo }}</span>

                <span class="items__text">
                  {{ item.rawText }}
                  @if (item.needsReview) {
                    <span class="items__flag" [attr.title]="i18n.t('receipts.items.needsReview')">
                      ⚠ {{ i18n.t('receipts.items.needsReview') }}
                    </span>
                  }
                </span>

                <span class="items__amount">
                  <span class="items__label">{{ i18n.t('receipts.items.amount') }}</span>
                  <fm-money [amount]="item.amount" />
                </span>

                <span class="items__category">
                  <label class="items__field">
                    <span class="items__label">{{ i18n.t('receipts.items.category') }}</span>
                    <select
                      class="items__select"
                      [value]="item.categoryId ?? ''"
                      [disabled]="busy()"
                      [attr.aria-label]="i18n.t('receipts.items.category') + ' ' + item.lineNo"
                      (change)="setCategory(item.id, $any($event.target).value)"
                    >
                      <option value="">{{ i18n.t('receipts.items.noCategory') }}</option>
                      @for (category of expenseCategories(); track category.id) {
                        <!-- The option carries "selected" as well as the select carrying "value":
                             the options are created in the same pass as the select, so the property
                             binding on the select runs while there is nothing to match, and a saved
                             category would then render as "no category". The selected binding has no
                             such ordering problem. -->
                        <option [value]="category.id" [selected]="category.id === item.categoryId">
                          {{ categoryLabel(category) }}
                        </option>
                      }
                    </select>
                  </label>
                </span>

                <span class="items__confidence">
                  <span class="items__label">{{ i18n.t('receipts.items.confidence') }}</span>
                  <!-- The badge carries an icon *and* its words: colour alone is not an answer. -->
                  <span class="badge">
                    <span aria-hidden="true">{{ badge(item.confidence).icon }}</span>
                    {{ i18n.t(badge(item.confidence).labelKey) }}
                  </span>
                </span>

                <span class="items__actions">
                  <button
                    type="button"
                    class="items__remove"
                    [disabled]="busy()"
                    [attr.aria-label]="i18n.t('receipts.items.removeLabel', { line: item.lineNo })"
                    (click)="removeItem(item.id)"
                  >
                    ×
                  </button>
                </span>
              </div>
            }

            <!-- Manual itemisation is offered rather than a spinner (docs/02 §4.11): with no OCR
                 provider this row is the only way lines exist at all. -->
            @if (adding()) {
              <div class="items__row items__row--add">
                <span class="items__line">{{ nextLineNo(r) }}</span>
                <span class="items__text">
                  <label class="items__field">
                    <span class="items__label">{{ i18n.t('receipts.items.addText') }}</span>
                    <input
                      class="items__input"
                      type="text"
                      autocomplete="off"
                      [value]="draftText()"
                      [attr.aria-label]="i18n.t('receipts.items.addText')"
                      (input)="draftText.set($any($event.target).value)"
                    />
                  </label>
                </span>
                <span class="items__amount">
                  <label class="items__field">
                    <span class="items__label">{{ i18n.t('receipts.items.addAmount') }}</span>
                    <input
                      class="items__input"
                      type="text"
                      inputmode="decimal"
                      autocomplete="off"
                      [value]="draftAmount()"
                      [attr.aria-label]="i18n.t('receipts.items.addAmount')"
                      (input)="draftAmount.set($any($event.target).value)"
                    />
                  </label>
                </span>
                <span class="items__category">
                  <label class="items__field">
                    <span class="items__label">{{ i18n.t('receipts.items.addCategory') }}</span>
                    <select
                      class="items__select"
                      [value]="draftCategoryId()"
                      [attr.aria-label]="i18n.t('receipts.items.addCategory')"
                      (change)="draftCategoryId.set($any($event.target).value)"
                    >
                      <option value="">{{ i18n.t('receipts.items.noCategory') }}</option>
                      @for (category of expenseCategories(); track category.id) {
                        <option
                          [value]="category.id"
                          [selected]="category.id === draftCategoryId()"
                        >
                          {{ categoryLabel(category) }}
                        </option>
                      }
                    </select>
                  </label>
                </span>
                <span class="items__confidence">
                  <span class="muted small">{{ i18n.t('receipts.items.addNew') }}</span>
                </span>
                <span class="items__actions">
                  <button type="button" class="btn btn--primary" [disabled]="busy()" (click)="addItem()">
                    {{ i18n.t('receipts.items.addSubmit') }}
                  </button>
                  <button type="button" class="btn btn--link" (click)="cancelAdd()">
                    {{ i18n.t('receipts.items.addCancel') }}
                  </button>
                </span>
              </div>
            } @else {
              <div class="items__row items__row--prompt">
                <span class="items__text">
                  <button type="button" class="btn btn--link" (click)="adding.set(true)">
                    {{ i18n.t('receipts.items.add') }}
                  </button>
                </span>
              </div>
            }
          </div>

          @if (adding() && addProblem(); as key) {
            <p class="error" role="alert">{{ i18n.t(key) }}</p>
          }
        </section>

        <section class="actions" aria-labelledby="receipts-actions">
          <h2 class="actions__title" id="receipts-actions">{{ i18n.t('receipts.actions.title') }}</h2>

          @if (actionError(); as key) {
            <p class="error" role="alert">{{ i18n.t(key) }}</p>
          }
          @if (notice(); as key) {
            <p class="ok" role="status">{{ i18n.t(key) }}</p>
          }

          <div class="actions__group">
            <h3 class="actions__subtitle">{{ i18n.t('receipts.actions.reconcile') }}</h3>

            <label class="field">
              <span class="field__label">{{ i18n.t('receipts.actions.amount') }}</span>
              <input
                class="field__input"
                type="text"
                inputmode="decimal"
                autocomplete="off"
                [value]="totalText()"
                (input)="totalText.set($any($event.target).value)"
              />
              <span class="hint">{{ i18n.t('receipts.actions.amountHint') }}</span>
            </label>
            <button type="button" class="btn" [disabled]="busy()" (click)="setTotal()">
              {{ i18n.t('receipts.actions.applyTotal') }}
            </button>

            <label class="field">
              <span class="field__label">{{ i18n.t('receipts.actions.absorbCategory') }}</span>
              <select
                class="field__input"
                [value]="absorbCategoryId()"
                (change)="absorbCategoryId.set($any($event.target).value)"
              >
                <option value="">{{ i18n.t('receipts.items.noCategory') }}</option>
                @for (category of expenseCategories(); track category.id) {
                  <option
                    [value]="category.id"
                    [selected]="category.id === absorbCategoryId()"
                  >
                    {{ categoryLabel(category) }}
                  </option>
                }
              </select>
              <span class="hint">{{ i18n.t('receipts.actions.roundingHint') }}</span>
            </label>
            <button
              type="button"
              class="btn"
              [disabled]="busy() || !roundingOfferable()"
              (click)="addRoundingLine()"
            >
              {{ i18n.t('receipts.actions.rounding') }}
            </button>

            <button
              type="button"
              class="btn"
              [disabled]="busy() || !canAccept()"
              (click)="acceptMatch()"
            >
              {{ i18n.t('receipts.actions.accept') }}
            </button>
          </div>

          @if (r.transactionId; as transactionId) {
            <div class="actions__group">
              <p class="ok">{{ i18n.t('receipts.detail.transaction') }}</p>
              <p>
                <!-- The drill-in (docs/02 §2.1) opens the exact row, not the list: the receipt's whole
                     point is that it becomes one Transaction, and hunting for it by hand defeats that. -->
                <a [routerLink]="['/transactions', transactionId]">
                  {{ i18n.t('receipts.detail.openTransaction') }}
                </a>
              </p>
              <button type="button" class="btn btn--danger" [disabled]="busy()" (click)="detach()">
                {{ i18n.t('receipts.actions.detach') }}
              </button>
            </div>
          } @else {
            <div class="actions__group">
              <label class="field">
                <span class="field__label">{{ i18n.t('receipts.actions.account') }}</span>
                <select
                  class="field__input"
                  [value]="accountId()"
                  (change)="accountId.set($any($event.target).value)"
                >
                  @if (accounts().length === 0) {
                    <option value="">{{ i18n.t('receipts.actions.chooseAccount') }}</option>
                  }
                  @for (account of accounts(); track account.id) {
                    <option [value]="account.id" [selected]="account.id === accountId()">
                      {{ account.name }}
                    </option>
                  }
                </select>
              </label>
              <button
                type="button"
                class="btn btn--primary"
                [disabled]="busy() || !postable()"
                (click)="post()"
              >
                {{ i18n.t('receipts.actions.post') }}
              </button>
              @if (postHint(); as key) {
                <p class="hint">{{ i18n.t(key) }}</p>
              }
            </div>
          }
        </section>
      }
    </main>
  `,
  styles: `
    .wrap {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      max-inline-size: 100%;
    }
    .head {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      justify-content: space-between;
      gap: var(--space-2);
    }
    .head__title {
      margin: 0;
      font-size: var(--text-2xl);
    }
    .head__back {
      font-size: var(--text-sm);
      color: var(--color-primary);
    }
    .muted {
      color: var(--color-text-muted);
    }
    .small {
      font-size: var(--text-xs);
    }
    .alert {
      margin: 0;
      padding: var(--space-3);
      border-radius: var(--radius-md);
      background: color-mix(in srgb, var(--color-danger) 15%, transparent);
      color: var(--color-danger);
      font-size: var(--text-sm);
    }
    .error {
      margin: 0;
      color: var(--color-danger);
      font-size: var(--text-sm);
    }
    .ok {
      margin: 0;
      color: var(--color-success);
      font-size: var(--text-sm);
    }
    .hint {
      margin: 0;
      color: var(--color-text-subtle);
      font-size: var(--text-xs);
    }
    .photo {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      align-items: flex-start;
      min-inline-size: 0;
    }
    .photo img {
      max-inline-size: 100%;
      max-block-size: 22rem;
      border-radius: var(--radius-md);
      border: 1px solid var(--color-border);
    }
    .banner {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      padding: var(--space-4);
      border: 1px solid currentColor;
      border-inline-start-width: 0.25rem;
      border-radius: var(--radius-md);
      min-inline-size: 0;
    }
    .banner__state {
      margin: 0;
      font-weight: 600;
    }
    .banner__text {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: var(--space-2);
      margin: 0;
      font-size: var(--text-sm);
      min-inline-size: 0;
    }
    .banner--ok {
      color: var(--color-success);
    }
    .banner--warn {
      color: var(--color-warning);
    }
    .banner--danger {
      color: var(--color-danger);
    }
    .banner--muted {
      color: var(--color-text-muted);
    }
    .items,
    .actions {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
    .items__title,
    .actions__title {
      margin: 0;
      font-size: var(--text-lg);
    }
    .items__table {
      display: flex;
      flex-direction: column;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      overflow: hidden;
    }
    /* Narrow: every row is a stack of labelled fields. The head row exists only in the wide layout,
       so it is hidden rather than read out as six orphaned words. */
    .items__head {
      display: none;
    }
    .items__row {
      display: grid;
      gap: var(--space-2);
      padding: var(--space-3);
      border-block-end: 1px solid var(--color-border);
      background: var(--color-surface);
      min-inline-size: 0;
    }
    .items__row:last-child {
      border-block-end: 0;
    }
    .items__line {
      font-size: var(--text-xs);
      color: var(--color-text-subtle);
    }
    .items__text {
      min-inline-size: 0;
      overflow-wrap: anywhere;
    }
    .items__flag {
      color: var(--color-warning);
      font-size: var(--text-xs);
      white-space: nowrap;
    }
    .items__amount,
    .items__confidence {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: var(--space-2);
      min-inline-size: 0;
    }
    .items__field {
      display: grid;
      gap: var(--space-1);
      min-inline-size: 0;
    }
    .items__label {
      font-size: var(--text-xs);
      color: var(--color-text-subtle);
    }
    .items__input,
    .items__select {
      inline-size: 100%;
      min-inline-size: 0;
      max-inline-size: 100%;
      padding: var(--space-2);
      font: inherit;
      color: var(--color-text);
      background: var(--color-bg);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
    }
    .badge {
      white-space: nowrap;
      font-size: var(--text-xs);
    }
    .items__actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
    }
    .items__remove {
      /* A thumb target, not a glyph: the character is ~1rem, which no one can hit reliably on a
         phone (WCAG 2.5.5). The box is 44 px and the glyph is centred inside it. */
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-inline-size: 2.75rem;
      min-block-size: 2.75rem;
      font: inherit;
      font-size: var(--text-lg);
      line-height: 1;
      color: var(--color-text-subtle);
      background: none;
      border: none;
      cursor: pointer;
    }
    /* Wide: one row per item, with the head row carrying the column labels. Every column is a
       fraction, so no width is pinned and a long item name wraps instead of pushing the amount off. */
    @media (min-width: 768px) {
      .items__head,
      .items__row {
        display: grid;
        grid-template-columns:
          2.5rem minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1.5fr) minmax(0, 1fr) auto;
        gap: var(--space-3);
        align-items: center;
      }
      .items__head {
        padding: var(--space-2) var(--space-3);
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
        border-block-end: 1px solid var(--color-border);
      }
      /* The add prompt is one control, so it takes the whole row rather than the first column. */
      .items__row--prompt .items__text {
        grid-column: 1 / -1;
      }
      .items__label {
        display: none;
      }
    }
    .actions__group {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      padding: var(--space-4);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
    }
    .actions__subtitle {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-text-muted);
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
    .field__input {
      padding: var(--space-3);
      font: inherit;
      color: var(--color-text);
      background: var(--color-bg);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      min-inline-size: 0;
    }
    .btn {
      align-self: start;
      padding: var(--space-2) var(--space-4);
      font: inherit;
      font-weight: 600;
      color: var(--color-text);
      background: var(--color-bg);
      border: 1px solid var(--color-border);
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
      border-color: transparent;
    }
    .btn--danger {
      color: var(--color-danger);
      background: none;
      border-color: var(--color-danger);
    }
    .btn--link {
      padding: 0;
      color: var(--color-primary);
      background: none;
      border: 0;
      text-decoration: underline;
    }
  `,
})
export class ReceiptDetailComponent {
  /** The Receipt id, bound straight from the `receipts/:id` route (`withComponentInputBinding`). */
  readonly id = input.required<string>();

  readonly i18n = inject(I18nService);

  private readonly graphql = inject(GraphqlClient);
  private readonly errors = inject(ErrorMessageService);

  readonly receipt = signal<ReceiptWire | null>(null);
  readonly image = signal<string | null>(null);
  readonly accounts = signal<readonly AccountOption[]>([]);
  readonly categories = signal<readonly CategoryOption[]>([]);

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly busy = signal(false);
  readonly actionError = signal<TranslationKey | null>(null);
  readonly notice = signal<TranslationKey | null>(null);

  readonly totalText = signal('');
  readonly absorbCategoryId = signal('');
  readonly accountId = signal('');

  readonly adding = signal(false);
  readonly draftText = signal('');
  readonly draftAmount = signal('');
  readonly draftCategoryId = signal('');
  readonly addProblem = signal<TranslationKey | null>(null);

  readonly expenseCategories = computed(() =>
    this.categories().filter((category) => category.kind === 'EXPENSE'),
  );

  /** The ledger currency the receipt's figures are in (ADR-011). Always present on `itemsTotal`. */
  readonly currency = computed(() => this.receipt()?.itemsTotal.currency ?? 'RSD');

  private readonly varianceMinor = computed(() => {
    const value = this.receipt()?.variance.amountMinor;
    return value === undefined ? 0n : BigInt(value);
  });

  readonly postable = computed(() => {
    const current = this.receipt();
    return current !== null && canPost(current);
  });

  readonly postHint = computed<TranslationKey | null>(() => {
    const current = this.receipt();
    return current === null ? null : postHintKey(current);
  });

  readonly roundingOfferable = computed(() => variantForRounding(this.varianceMinor()));

  readonly canAccept = computed(() => {
    const state = this.receipt()?.reconciliation;
    return state === 'MATCHED' || state === 'MANUAL';
  });

  constructor() {
    // The route param is an input, so an id change (a second receipt from a list) re-reads rather
    // than showing the previous receipt's lines under the new URL.
    effect(() => {
      void this.load(this.id());
    });
  }

  // -------------------------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------------------------

  private async load(id: string): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      const [receiptData, taxonomy] = await Promise.all([
        this.graphql.query<{ receipt: ReceiptWire | null }>(RECEIPT, { id }),
        this.graphql.query<{
          accounts: { edges: { node: AccountOption }[] };
          categories: CategoryOption[];
        }>(TAXONOMY),
      ]);

      // A slow response for a previous id must not overwrite the newer receipt being looked at.
      if (this.id() !== id) return;

      this.accounts.set(taxonomy.accounts.edges.map((edge) => edge.node));
      this.categories.set(taxonomy.categories);
      const firstAccount = taxonomy.accounts.edges[0]?.node;
      if (this.accountId() === '' && firstAccount !== undefined) {
        this.accountId.set(firstAccount.id);
      }

      const current = receiptData.receipt;
      this.receipt.set(current);
      if (current === null) {
        this.loadError.set(this.i18n.t('receipts.detail.notFound'));
        return;
      }

      // The total field is pre-filled with the current total so *Set the total* can adjust it; the
      // input is text because a Money value is never a float, and it is parsed on submit.
      this.totalText.set(
        current.total === null
          ? ''
          : toMajorString(BigInt(current.total.amountMinor), current.total.currency),
      );
      await this.loadImage(current.attachmentId);
    } catch (error) {
      if (this.id() !== id) return;
      this.loadError.set(this.errors.for(error));
    } finally {
      // Only the request that still owns the input may clear the loader.
      if (this.id() === id) this.loading.set(false);
    }
  }

  private async loadImage(attachmentId: string | null): Promise<void> {
    if (attachmentId === null) {
      this.image.set(null);
      return;
    }
    try {
      const data = await this.graphql.query<{ attachment: AttachmentWire | null }>(ATTACHMENT, {
        id: attachmentId,
      });
      this.image.set(data.attachment?.downloadUrl ?? null);
    } catch {
      // A preview that cannot be resolved is a missing picture, not a broken screen: the lines below
      // are what the user came to fix.
      this.image.set(null);
    }
  }

  /** Re-read the Receipt after a mutation. Throws, so the caller decides what a failed re-read means. */
  private async refresh(): Promise<void> {
    const data = await this.graphql.query<{ receipt: ReceiptWire | null }>(RECEIPT, {
      id: this.id(),
    });
    this.receipt.set(data.receipt);
  }

  // -------------------------------------------------------------------------------------------
  // Labels and derived figures
  // -------------------------------------------------------------------------------------------

  /** A captured instant as the reader's own date. */
  dateLabel(instant: string): string {
    return capturedLabel(instant, this.i18n.tag());
  }

  stateKey(state: ReconciliationState): TranslationKey {
    return reconciliationLabelKey(state);
  }

  tone(state: ReconciliationState): string {
    return toneForState(state);
  }

  varianceKey(receipt: ReceiptWire): TranslationKey {
    return varianceLabelKey(receipt.reconciliation, BigInt(receipt.variance.amountMinor));
  }

  /** The difference in money is stated for a mismatch only; the other states "say so" in words. */
  showVariance(receipt: ReceiptWire): boolean {
    return receipt.reconciliation === 'MISMATCH';
  }

  /**
   * The variance as a positive magnitude, because the sentence beside it already gives the direction.
   * Only the sign is changed here — the minor units are passed through untouched (ADR-003).
   */
  varianceDisplay(receipt: ReceiptWire): MoneyWire {
    const minor = BigInt(receipt.variance.amountMinor);
    return {
      amountMinor: (minor < 0n ? -minor : minor).toString(),
      currency: receipt.variance.currency,
    };
  }

  badge(confidence: number | null): { readonly icon: string; readonly labelKey: TranslationKey } {
    return confidenceBadge(confidence);
  }

  categoryLabel(category: CategoryOption): string {
    return category.path.join(' › ');
  }

  nextLineNo(receipt: ReceiptWire): number {
    return (receipt.items.at(-1)?.lineNo ?? 0) + 1;
  }

  // -------------------------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------------------------

  /**
   * Run one mutation, announce it, and re-read the receipt.
   *
   * Returns whether the write landed. A failed **re-read** after a successful write is not a failure:
   * it leaves the previous state on screen and says nothing, because telling the user "nothing was
   * saved" about a mutation that did save would make them do it twice.
   */
  private async mutate(
    query: string,
    variables: Record<string, unknown>,
    errorKey: TranslationKey,
    successKey: TranslationKey | null,
  ): Promise<boolean> {
    this.busy.set(true);
    this.actionError.set(null);
    this.notice.set(null);
    try {
      await this.graphql.query(query, variables);
    } catch {
      this.actionError.set(errorKey);
      this.busy.set(false);
      return false;
    }

    if (successKey !== null) this.notice.set(successKey);
    try {
      await this.refresh();
    } catch {
      // Deliberately silent; see the method doc.
    }
    this.busy.set(false);
    return true;
  }

  /** `updateReceiptItem` — a category chosen by hand is recorded at confidence 1 by the API. */
  async setCategory(itemId: string, categoryId: string): Promise<void> {
    if (this.busy()) return;
    const variables =
      categoryId === ''
        ? { input: { receiptItemId: itemId, clearCategory: true } }
        : { input: { receiptItemId: itemId, categoryId } };
    await this.mutate(UPDATE_ITEM, variables, 'receipts.error.item', null);
  }

  async removeItem(itemId: string): Promise<void> {
    if (this.busy()) return;
    await this.mutate(REMOVE_ITEM, { receiptItemId: itemId }, 'receipts.error.item', null);
  }

  /**
   * Manual itemisation: a line typed by hand.
   *
   * The amount goes through `parseAmount` — the same parser the capture screen uses, from
   * `@finmate/domain` — and is sent as a **string** of minor units, so a float cannot reach the API
   * (ADR-003). A line with no category is allowed here and blocks the post button, which is exactly
   * what the review queue does with a transaction whose category is missing (I-8).
   */
  async addItem(): Promise<void> {
    const current = this.receipt();
    if (current === null || this.busy()) return;

    const rawText = this.draftText().trim();
    if (rawText === '') {
      this.addProblem.set('receipts.items.addNeedsText');
      return;
    }

    const parsed = parseAmount(this.draftAmount(), this.currency());
    if (parsed.money === null || parsed.money.amountMinor < 0n) {
      this.addProblem.set('receipts.items.addInvalidAmount');
      return;
    }
    this.addProblem.set(null);

    const categoryId = this.draftCategoryId();
    const added = await this.mutate(
      ADD_ITEM,
      {
        receiptId: current.id,
        input: {
          rawText,
          amount: {
            amountMinor: parsed.money.amountMinor.toString(),
            currency: parsed.money.currency,
          },
          ...(categoryId === '' ? {} : { categoryId }),
        },
      },
      'receipts.error.item',
      'receipts.items.added',
    );

    if (added) {
      this.adding.set(false);
      this.draftText.set('');
      this.draftAmount.set('');
      this.draftCategoryId.set('');
    }
  }

  cancelAdd(): void {
    this.adding.set(false);
    this.addProblem.set(null);
  }

  /**
   * `ADJUST_TOTAL` — the field holds the **absolute new total**, never a delta.
   *
   * The SDL says so in as many words: `Money` is non-negative (ADR-003), so a delta could never
   * express a decrease. The hint under the field repeats that to the user, because a field labelled
   * "difference" that actually means "new total" is how a receipt silently loses money.
   */
  async setTotal(): Promise<void> {
    const current = this.receipt();
    if (current === null || this.busy()) return;

    const parsed = parseAmount(this.totalText(), this.currency());
    if (parsed.money === null || parsed.money.amountMinor < 0n) {
      this.actionError.set('receipts.actions.amountUnreadable');
      return;
    }

    await this.mutate(
      RECONCILE,
      {
        input: {
          receiptId: current.id,
          action: 'ADJUST_TOTAL',
          amount: {
            amountMinor: parsed.money.amountMinor.toString(),
            currency: parsed.money.currency,
          },
        },
      },
      'receipts.error.reconcile',
      'receipts.detail.totalSet',
    );
  }

  /** `ADD_ROUNDING_LINE` — offered only while the receipt claims more than its lines sum to. */
  async addRoundingLine(): Promise<void> {
    const current = this.receipt();
    if (current === null || this.busy() || !this.roundingOfferable()) return;

    const absorbCategoryId = this.absorbCategoryId();
    await this.mutate(
      RECONCILE,
      {
        input: {
          receiptId: current.id,
          action: 'ADD_ROUNDING_LINE',
          ...(absorbCategoryId === '' ? {} : { absorbCategoryId }),
        },
      },
      'receipts.error.reconcile',
      'receipts.detail.roundingAdded',
    );
  }

  /** `ACCEPT_MATCH` — the explicit "yes, these agree" answer. */
  async acceptMatch(): Promise<void> {
    const current = this.receipt();
    if (current === null || this.busy() || !this.canAccept()) return;
    await this.mutate(
      RECONCILE,
      { input: { receiptId: current.id, action: 'ACCEPT_MATCH' } },
      'receipts.error.reconcile',
      null,
    );
  }

  /** `DETACH_TRANSACTION` — unlinks the receipt; the Transaction itself is left alone. */
  async detach(): Promise<void> {
    const current = this.receipt();
    if (current === null || current.transactionId === null || this.busy()) return;
    await this.mutate(
      RECONCILE,
      { input: { receiptId: current.id, action: 'DETACH_TRANSACTION' } },
      'receipts.error.detach',
      'receipts.detail.detached',
    );
  }

  /**
   * `commitReceipt` — one CONFIRMED Transaction with a Split per Category.
   *
   * The button is disabled by the two API gates (see the class doc), so reaching the mutation with
   * them closed means a race; the API's refusal is then shown rather than a success message.
   */
  async post(): Promise<void> {
    const current = this.receipt();
    if (current === null || this.busy() || !canPost(current)) return;

    const accountId = this.accountId();
    if (accountId === '') {
      this.actionError.set('receipts.actions.chooseAccount');
      return;
    }

    await this.mutate(
      COMMIT_RECEIPT,
      { input: { receiptId: current.id, accountId } },
      'receipts.error.commit',
      'receipts.detail.committed',
    );
  }
}

/** One line as this screen renders it (docs/06 §5.9's `ReceiptItemModel`). */
interface ReceiptItemWire {
  readonly id: string;
  readonly lineNo: number;
  readonly rawText: string;
  readonly amount: MoneyWire;
  readonly categoryId: string | null;
  readonly confidence: number | null;
  readonly needsReview: boolean;
}

/** The Receipt as the exact `query Receipt` selection returns it. */
interface ReceiptWire {
  readonly id: string;
  readonly capturedAt: string;
  readonly reconciliation: ReconciliationState;
  readonly total: MoneyWire | null;
  readonly itemsTotal: MoneyWire;
  readonly variance: MoneyWire;
  readonly attachmentId: string | null;
  readonly transactionId: string | null;
  readonly ocrConfidence: number | null;
  readonly items: readonly ReceiptItemWire[];
}

/** The subset of `AttachmentModel` this screen reads (docs/06 §3.2). */
interface AttachmentWire {
  readonly id: string;
  readonly downloadUrl: string | null;
  readonly scanState: string;
}

interface AccountOption {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
}

interface CategoryOption {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly path: readonly string[];
}

const RECEIPT = /* GraphQL */ `
  query Receipt($id: String!) {
    receipt(id: $id) {
      id
      capturedAt
      reconciliation
      total
      itemsTotal
      variance
      attachmentId
      transactionId
      ocrConfidence
      items {
        id
        lineNo
        rawText
        amount
        categoryId
        confidence
        needsReview
      }
    }
  }
`;

const TAXONOMY = /* GraphQL */ `
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

const ATTACHMENT = /* GraphQL */ `
  query Attachment($id: String!) {
    attachment(id: $id) {
      id
      downloadUrl
      scanState
    }
  }
`;

const RECONCILE = /* GraphQL */ `
  mutation Reconcile($input: ReconcileReceiptInput!) {
    reconcileReceipt(input: $input) {
      id
      reconciliation
      total
      itemsTotal
      variance
      items {
        id
        lineNo
        amount
        categoryId
        needsReview
      }
    }
  }
`;

const ADD_ITEM = /* GraphQL */ `
  mutation AddItem($receiptId: String!, $input: ReceiptItemInput!) {
    addReceiptItem(receiptId: $receiptId, input: $input) {
      id
      itemsTotal
      variance
      reconciliation
      items {
        id
        lineNo
        rawText
        amount
        categoryId
        needsReview
      }
    }
  }
`;

const UPDATE_ITEM = /* GraphQL */ `
  mutation UpdateItem($input: UpdateReceiptItemInput!) {
    updateReceiptItem(input: $input) {
      id
      itemsTotal
      variance
      reconciliation
      items {
        id
        lineNo
        amount
        categoryId
        needsReview
        confidence
      }
    }
  }
`;

const REMOVE_ITEM = /* GraphQL */ `
  mutation RemoveItem($receiptItemId: String!) {
    removeReceiptItem(receiptItemId: $receiptItemId) {
      id
      itemsTotal
      variance
      reconciliation
      items {
        id
      }
    }
  }
`;

const COMMIT_RECEIPT = /* GraphQL */ `
  mutation CommitReceipt($input: CommitReceiptInput!) {
    commitReceipt(input: $input) {
      id
      transactionId
      reconciliation
    }
  }
`;
