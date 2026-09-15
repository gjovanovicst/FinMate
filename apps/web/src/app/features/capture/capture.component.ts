import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { parseAmount } from '@finmate/domain';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { GraphqlClient } from '../../core/graphql/graphql.client';
import { I18nService } from '../../core/i18n/i18n.service';
import type { TranslationKey } from '../../core/i18n/translations';
import { toMajorString } from '../../shared/money-text';
import { MoneyComponent } from '../../shared/ui/money/money.component';
import {
  ambiguousRows,
  applyFragments,
  blockedRows,
  canCommit,
  chosenAmountMinor,
  confirmableRows,
  directionUnsure,
  laneOf,
  needsAmountChoice,
  parseLocally,
  provenanceOf,
  toCommitRows,
  todayLocally,
  type CaptureLane,
  type CaptureProposal,
  type CaptureRow,
} from './capture.view';

/** The preview query (docs/06 §5.1). `captureParse` is a mutation because it writes audit rows. */
const CAPTURE_PARSE = /* GraphQL */ `
  mutation CaptureParse($text: String!, $occurredLocalDate: LocalDate) {
    captureParse(text: $text, occurredLocalDate: $occurredLocalDate) {
      parseId
      rawText
      degraded
      usedAi
      unresolvedSegments
      fragments {
        id
        categoryId
        decidedBy
        confidence
        needsReview
        advisory
        rationale
        merchantId
        amountMinor
        currency
        description
        needsDirectionConfirmation
        alternatives {
          categoryId
          confidence
        }
      }
    }
  }
`;

/** The atomic write (docs/06 §5.2). A union, so both arms must be selected explicitly. */
const CAPTURE_COMMIT = /* GraphQL */ `
  mutation CaptureCommit($input: CaptureCommitInput!) {
    captureCommit(input: $input) {
      __typename
      ... on CaptureCommitSuccessModel {
        replayed
        committed {
          clientRowId
          wasReplayed
          transaction {
            id
          }
        }
      }
      ... on CaptureCommitRejectedModel {
        code
        message
        rejected {
          clientRowId
          code
          message
          field
        }
      }
    }
  }
`;

const ACCOUNTS_QUERY = /* GraphQL */ `
  query CaptureAccounts {
    accounts(first: 50) {
      edges {
        node {
          id
          name
          currency
          isArchived
        }
      }
    }
  }
`;

const CATEGORIES_QUERY = /* GraphQL */ `
  query CaptureCategories {
    categories {
      id
      name
      kind
      parentId
    }
  }
`;

interface AccountNode {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly isArchived: boolean;
}

interface CategoryNode {
  readonly id: string;
  readonly name: string;
  readonly kind: 'EXPENSE' | 'INCOME';
  readonly parentId: string | null;
}

interface ParseResponse {
  readonly captureParse: {
    readonly parseId: string;
    readonly rawText: string;
    readonly degraded: boolean;
    readonly usedAi: boolean;
    readonly unresolvedSegments: readonly string[];
    readonly fragments: readonly {
      readonly id: string;
      readonly categoryId: string | null;
      readonly decidedBy: string;
      readonly confidence: number;
      readonly needsReview: boolean;
      readonly advisory: boolean;
      readonly rationale: string;
      readonly merchantId: string | null;
      readonly amountMinor: string | null;
      readonly currency: string | null;
      readonly description: string;
      readonly needsDirectionConfirmation: boolean;
      readonly alternatives: readonly { readonly categoryId: string; readonly confidence: number }[];
    }[];
  };
}

interface CommitResponse {
  readonly captureCommit: {
    readonly __typename: string;
    readonly replayed?: boolean;
    readonly reviewQueueCount?: number;
    readonly committed?: readonly {
      readonly clientRowId: string;
      readonly wasReplayed: boolean;
      readonly transaction: { readonly id: string };
    }[];
    readonly code?: string;
    readonly message?: string;
    readonly rejected?: readonly {
      readonly clientRowId: string;
      readonly code: string;
      readonly message: string;
      readonly field: string | null;
    }[];
  };
}

/** One refused row, so the message renders beside the input that caused it. */
interface RowError {
  readonly clientRowId: string;
  readonly message: string;
  readonly field: string | null;
}

/**
 * The capture screen — F-05 (single) and F-06 (bulk), docs/02 §3.
 *
 * The signature interaction of the product: type `Lidl 2000, gorivo 3500, plata 150000` and get
 * three correctly categorised Transactions back in one action.
 *
 * ## What this component does NOT do
 *
 * It does not parse, classify, gate or arithmetic. `capture.view.ts` owns the preview's decisions,
 * `@finmate/nlp` runs the same segmenter the server runs, and the backend owns the gate and every
 * number. A second parser here is exactly how the client and the server start disagreeing about what
 * `1.200` means.
 *
 * ## Local first, server second
 *
 * A row appears the moment the local parse yields an amount and a description, and the server
 * response only fills in a badge (docs/02 §3's progressive preview). Two consequences that are
 * deliberate:
 *
 *  - a response whose `rawText` is no longer the field's text is **discarded**, which is how a
 *    superseded in-flight request is handled (the request itself is not aborted — `HttpClient` is
 *    reached through `firstValueFrom`, which cannot be cancelled — but a stale answer never lands);
 *  - a row never disappears on response, so a category the user picked mid-flight survives.
 */
@Component({
  selector: 'fm-capture',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MoneyComponent, RouterLink],
  template: `
    <header class="head">
      <div>
        <h1 class="head__title">{{ i18n.t('capture.title') }}</h1>
        <p class="head__sub">{{ i18n.t('capture.subtitle') }}</p>
      </div>
    </header>

    @if (degraded()) {
      <p class="note" role="status">{{ i18n.t('capture.degraded') }}</p>
    }
    @if (error()) {
      <p class="alert" role="alert">{{ error() }}</p>
    }
    @if (saved(); as summary) {
      <p class="success" role="status">{{ summary }}</p>
    }

    @if (noAccounts()) {
      <div class="empty">
        <p class="empty__title">{{ i18n.t('capture.noAccounts') }}</p>
        <p class="empty__body">{{ i18n.t('capture.noAccountsBody') }}</p>
        <p><a routerLink="/accounts">{{ i18n.t('nav.accounts') }}</a></p>
      </div>
    } @else if (loading()) {
      <p class="hint" role="status">{{ i18n.t('accounts.loading') }}</p>
    } @else {
      @if (rejected().length > 0) {
        <section class="panel panel--danger" role="alert">
          <h2 class="panel__title">{{ i18n.t('capture.rejectedTitle') }}</h2>
          <p class="panel__body">{{ i18n.t('capture.rejectedBody') }}</p>
          <ul class="errors">
            @for (entry of rejected(); track entry.clientRowId) {
              <li>
                {{
                  i18n.t('capture.rowError', {
                    field: entry.field ?? i18n.t('capture.description'),
                    message: entry.message
                  })
                }}
              </li>
            }
          </ul>
        </section>
      }

      <section class="field-panel">
        <label class="field">
          <span class="field__label">{{ i18n.t('capture.label') }}</span>
          <textarea
            #input
            class="field__input field__input--capture"
            rows="2"
            autocomplete="off"
            autocapitalize="sentences"
            [placeholder]="i18n.t('capture.placeholder')"
            [value]="text()"
            [attr.aria-describedby]="'capture-hint'"
            (input)="onInput($any($event.target).value)"
            (keydown)="onKeydown($event)"
          ></textarea>
        </label>

        <div class="examples">
          <span class="examples__label">{{ i18n.t('capture.examples') }}</span>
          <button class="link" type="button" (click)="useExample(i18n.t('capture.example1'))">
            {{ i18n.t('capture.example1') }}
          </button>
          <button class="link" type="button" (click)="useExample(i18n.t('capture.example2'))">
            {{ i18n.t('capture.example2') }}
          </button>
        </div>
        <p class="hint" id="capture-hint">{{ i18n.t('capture.confirmHint') }}</p>
      </section>

      @if (rows().length === 0) {
        <div class="empty">
          <p class="empty__title">{{ i18n.t('capture.empty') }}</p>
          <p class="empty__body">{{ i18n.t('capture.emptyBody') }}</p>
        </div>
      } @else {
        <section class="preview">
          <h2 class="preview__title">{{ i18n.t('capture.previewTitle') }}</h2>

          <ul class="rows">
            @for (row of rows(); track row.clientRowId) {
              <li
                class="row"
                [class.row--removed]="row.removed"
                [class.row--blocked]="laneOf(row) === 'ASK'"
                [attr.data-lane]="laneOf(row)"
              >
                <div class="row__head">
                  <span class="badge" [attr.data-lane]="laneOf(row)">
                    <span class="badge__glyph" aria-hidden="true">{{ glyphFor(laneOf(row)) }}</span>
                    <span class="badge__label">{{ laneLabel(laneOf(row)) }}</span>
                    @if (row.proposal; as proposal) {
                      <span class="badge__percent">
                        {{ i18n.t('capture.confidence', { percent: percent(proposal.confidence) }) }}
                      </span>
                    }
                  </span>
                  <button
                    class="row__remove"
                    type="button"
                    (click)="toggleRemoved(row)"
                    [attr.aria-label]="row.removed ? i18n.t('capture.restore') : i18n.t('capture.remove')"
                  >
                    {{ row.removed ? i18n.t('capture.restore') : '×' }}
                  </button>
                </div>

                @if (row.removed) {
                  <p class="row__removed">{{ i18n.t('capture.removed') }}</p>
                } @else {
                  <p class="row__text">{{ row.rawText }}</p>

                  @if (directionUnsure(row)) {
                    <p class="row__warn">{{ i18n.t('capture.directionUnsure') }}</p>
                  }

                  @if (needsAmountChoice(row)) {
                    <div class="chips" role="group" [attr.aria-label]="i18n.t('capture.ambiguous')">
                      <span class="chips__label">{{ i18n.t('capture.ambiguous') }}</span>
                      @for (candidate of row.candidates; track candidate.amountMinor) {
                        <button
                          class="chip"
                          type="button"
                          (click)="pickAmount(row, candidate.amountMinor)"
                        >
                          <fm-money
                            [amount]="{ amountMinor: candidate.amountMinor.toString(), currency: row.currency }"
                          />
                        </button>
                      }
                    </div>
                  }

                  <div class="row__fields">
                    <label class="field field--amount">
                      <span class="field__label">{{ i18n.t('capture.amount') }}</span>
                      <input
                        class="field__input"
                        type="text"
                        inputmode="decimal"
                        [value]="amountText(row)"
                        (change)="setAmount(row, $any($event.target).value)"
                      />
                      @if (chosenAmountMinor(row); as minor) {
                        <span class="field__hint">
                          <fm-money [amount]="{ amountMinor: minor.toString(), currency: row.currency }" />
                        </span>
                      }
                    </label>

                    <label class="field">
                      <span class="field__label">{{ i18n.t('capture.kind') }}</span>
                      <select
                        class="field__input"
                        [value]="row.kind === 'INCOME' ? 'INCOME' : 'EXPENSE'"
                        (change)="setKind(row, $any($event.target).value)"
                      >
                        <option value="EXPENSE">{{ i18n.t('transactionKind.EXPENSE') }}</option>
                        <option value="INCOME">{{ i18n.t('transactionKind.INCOME') }}</option>
                      </select>
                    </label>

                    <label class="field field--grow">
                      <span class="field__label">{{ i18n.t('capture.category') }}</span>
                      <select
                        class="field__input"
                        [value]="row.categoryId ?? row.proposal?.categoryId ?? ''"
                        (change)="setCategory(row, $any($event.target).value)"
                      >
                        <option value="">{{ i18n.t('capture.noCategory') }}</option>
                        @for (category of categoriesFor(row); track category.id) {
                          <option [value]="category.id">{{ category.name }}</option>
                        }
                      </select>
                    </label>

                    <label class="field field--grow">
                      <span class="field__label">{{ i18n.t('capture.description') }}</span>
                      <input
                        class="field__input"
                        type="text"
                        [value]="row.description"
                        (change)="setDescription(row, $any($event.target).value)"
                      />
                    </label>

                    <label class="field">
                      <span class="field__label">{{ i18n.t('capture.date') }}</span>
                      <input
                        class="field__input"
                        type="date"
                        [value]="row.occurredOn ?? ''"
                        (change)="setDate(row, $any($event.target).value)"
                      />
                    </label>

                    @if (accounts().length > 1) {
                      <label class="field">
                        <span class="field__label">{{ i18n.t('capture.account') }}</span>
                        <select
                          class="field__input"
                          [value]="accountId()"
                          (change)="accountId.set($any($event.target).value)"
                        >
                          @for (account of accounts(); track account.id) {
                            <option [value]="account.id">{{ account.name }}</option>
                          }
                        </select>
                      </label>
                    }
                  </div>

                  <p class="row__provenance">{{ provenanceLabel(row) }}</p>
                  @if (rowError(row); as entry) {
                    <p class="row__error" role="alert">
                      {{
                        i18n.t('capture.rowError', {
                          field: entry.field ?? i18n.t('capture.description'),
                          message: entry.message
                        })
                      }}
                    </p>
                  }
                }
              </li>
            }
          </ul>

          <div class="actions">
            <button
              class="btn btn--primary"
              type="button"
              [disabled]="busy() || !canCommit(rows())"
              (click)="commit()"
            >
              {{ busy() ? i18n.t('capture.confirming') : confirmLabel() }}
            </button>
            <button class="btn" type="button" [disabled]="busy()" (click)="clear()">
              {{ i18n.t('capture.clear') }}
            </button>
          </div>
          @if (blockedRows(rows()).length > 0) {
            <p class="hint">{{ i18n.t('capture.blockedNote') }}</p>
          }
        </section>
      }
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .head__title {
        margin: 0;
        font-size: var(--text-xl);
      }
      .head__sub {
        margin: var(--space-1) 0 var(--space-4);
        color: var(--color-text-muted);
      }
      .alert,
      .note,
      .success {
        margin: 0 0 var(--space-3);
        padding: var(--space-3);
        border-radius: var(--radius-md);
        border: 1px solid var(--color-border);
      }
      .alert {
        border-color: var(--color-danger);
        color: var(--color-danger);
      }
      .note {
        background: color-mix(in srgb, var(--color-warning, #b45309) 12%, transparent);
      }
      .success {
        border-color: var(--color-success, #15803d);
      }
      .panel {
        margin-block-end: var(--space-4);
        padding: var(--space-4);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
      }
      .panel--danger {
        border-color: var(--color-danger);
      }
      .panel__title {
        margin: 0 0 var(--space-2);
        font-size: var(--text-lg);
      }
      .panel__body {
        margin: 0 0 var(--space-2);
        color: var(--color-text-muted);
      }
      .errors {
        margin: 0;
        padding-inline-start: var(--space-4);
      }
      .field-panel {
        padding: var(--space-4);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-surface);
      }
      .field {
        display: grid;
        gap: var(--space-1);
        min-inline-size: 0;
      }
      .field--grow {
        flex: 1 1 12rem;
      }
      .field--amount {
        flex: 0 1 8rem;
      }
      .field__label {
        font-size: var(--text-sm);
        color: var(--color-text-muted);
      }
      .field__input {
        inline-size: 100%;
        min-inline-size: 0;
        padding: var(--space-2);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg);
        color: var(--color-text);
        font: inherit;
      }
      .field__input--capture {
        font-size: var(--text-lg);
        resize: vertical;
      }
      .field__hint {
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
      }
      .examples {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-2);
        margin-block-start: var(--space-2);
      }
      .examples__label {
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
      }
      .link {
        background: none;
        border: none;
        padding: 0;
        color: var(--color-primary);
        font: inherit;
        font-size: var(--text-sm);
        text-decoration: underline;
        cursor: pointer;
      }
      .hint {
        margin: var(--space-2) 0 0;
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
      }
      .empty {
        margin-block-start: var(--space-5);
        text-align: center;
        color: var(--color-text-muted);
      }
      .empty__title {
        margin: 0;
        font-size: var(--text-lg);
      }
      .empty__body {
        margin: var(--space-1) 0 0;
      }
      .preview {
        margin-block-start: var(--space-5);
      }
      .preview__title {
        margin: 0 0 var(--space-2);
        font-size: var(--text-lg);
      }
      .rows {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: var(--space-3);
      }
      .row {
        padding: var(--space-3);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-surface);
      }
      .row--blocked {
        border-inline-start: 3px solid var(--color-danger);
      }
      .row--removed {
        opacity: 0.6;
      }
      .row__head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-2);
      }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-xs);
      }
      .badge__glyph {
        font-weight: 700;
      }
      .badge[data-lane='AUTO'] .badge__glyph {
        color: var(--color-success, #15803d);
      }
      .badge[data-lane='ADVISORY'] .badge__glyph {
        color: var(--color-warning, #b45309);
      }
      .badge[data-lane='ASK'] .badge__glyph {
        color: var(--color-danger);
      }
      .badge__label,
      .badge__percent {
        color: var(--color-text-muted);
      }
      .row__remove {
        background: none;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        color: var(--color-text-muted);
        padding: var(--space-1) var(--space-2);
        font: inherit;
        cursor: pointer;
      }
      .row__text {
        margin: var(--space-2) 0;
        overflow-wrap: anywhere;
      }
      .row__warn,
      .row__removed,
      .row__provenance,
      .row__error {
        margin: var(--space-1) 0 0;
        font-size: var(--text-xs);
      }
      .row__warn {
        color: var(--color-warning, #b45309);
      }
      .row__provenance {
        color: var(--color-text-subtle);
      }
      .row__error {
        color: var(--color-danger);
      }
      .row__fields {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        margin-block-start: var(--space-2);
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-2);
        margin-block-start: var(--space-2);
      }
      .chips__label {
        font-size: var(--text-xs);
        color: var(--color-text-muted);
      }
      .chip {
        padding: var(--space-1) var(--space-3);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        background: var(--color-bg);
        color: inherit;
        font: inherit;
        cursor: pointer;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        margin-block-start: var(--space-4);
      }
      .btn {
        padding: var(--space-2) var(--space-4);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg);
        color: inherit;
        font: inherit;
        cursor: pointer;
      }
      .btn--primary {
        background: var(--color-primary);
        border-color: var(--color-primary);
        color: var(--color-primary-contrast);
      }
      .btn:disabled {
        opacity: 0.6;
        cursor: default;
      }
    `,
  ],
})
export class CaptureComponent {
  readonly i18n = inject(I18nService);
  private readonly graphql = inject(GraphqlClient);
  private readonly errors = inject(ErrorMessageService);

  readonly text = signal('');
  readonly rows = signal<readonly CaptureRow[]>([]);
  readonly accounts = signal<readonly AccountNode[]>([]);
  readonly categories = signal<readonly CategoryNode[]>([]);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly saved = signal<string | null>(null);
  readonly degraded = signal(false);
  readonly noAccounts = signal(false);
  readonly rejected = signal<readonly RowError[]>([]);
  readonly accountId = signal('');

  /** The preview this draft belongs to, sent back with the commit so a stale one is refused. */
  private parseId: string | null = null;
  /** Monotonic guard: a response for an older text never lands (docs/02 §3's supersede). */
  private parseToken = 0;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  /** Row id → the refusal that names it, so the message renders beside its input. */
  private readonly rowErrors = signal<ReadonlyMap<string, RowError>>(new Map());

  // Bound for the template: the view helpers are pure functions, not component state.
  readonly laneOf = laneOf;
  readonly needsAmountChoice = needsAmountChoice;
  readonly directionUnsure = directionUnsure;
  readonly chosenAmountMinor = chosenAmountMinor;
  readonly blockedRows = blockedRows;
  readonly canCommit = canCommit;

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const [accounts, categories] = await Promise.all([
        this.graphql.query<{ accounts: { edges: { node: AccountNode }[] } }>(ACCOUNTS_QUERY),
        this.graphql.query<{ categories: CategoryNode[] }>(CATEGORIES_QUERY),
      ]);

      const live = accounts.accounts.edges
        .map((edge) => edge.node)
        .filter((account) => !account.isArchived);
      this.accounts.set(live);
      this.categories.set(categories.categories.filter((category) => category.name !== ''));
      this.noAccounts.set(live.length === 0);
      this.accountId.set(live[0]?.id ?? '');
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.loading.set(false);
    }
  }

  /** The Household ledger currency, as the account carries it. Used only as a parser default. */
  private currency(): string {
    return this.accounts()[0]?.currency ?? 'RSD';
  }

  /**
   * A keystroke: parse locally (synchronously, per docs/02 §3) and schedule the server preview.
   *
   * The debounce is reset on every keystroke, so the request fires 250 ms after the *last* one. The
   * local rows are updated immediately and are never reverted.
   */
  onInput(value: string): void {
    this.text.set(value);
    this.saved.set(null);

    this.rows.set(
      parseLocally(value, {
        currency: this.currency(),
        today: todayLocally(),
        previous: this.rows(),
      }),
    );
    this.parseId = null;

    if (this.debounce !== null) clearTimeout(this.debounce);
    if (value.trim() === '') return;

    this.debounce = setTimeout(() => {
      void this.parse(value);
    }, 250);
  }

  /** The server preview (docs/06 §5.1). Superseded if the text moved on while it was in flight. */
  private async parse(rawText: string): Promise<void> {
    const token = (this.parseToken += 1);
    try {
      const response = await this.graphql.query<ParseResponse>(CAPTURE_PARSE, {
        text: rawText,
        occurredLocalDate: null,
      });

      // A stale answer must not overwrite a newer preview — the user may have kept typing, and
      // applying it would attach categories to rows that no longer exist.
      if (token !== this.parseToken || response.captureParse.rawText !== this.text()) return;

      const parse = response.captureParse;
      this.degraded.set(parse.degraded);
      this.parseId = parse.parseId;
      this.rows.set(applyFragments(this.rows(), parse.fragments.map(toProposal)));
      this.rejected.set([]);
    } catch (error) {
      if (token !== this.parseToken) return;
      // A failed preview is not a failed entry: the rows are still there and the commit path
      // classifies anything the preview never reached (docs/06 §5.2).
      this.error.set(this.errors.for(error));
    }
  }

  /**
   * `Enter` confirms when every row is ready; otherwise it refuses to guess.
   *
   * docs/02 §3: "Confirm all confirmable rows; if any row is blocked or ambiguous, focus it instead".
   * `Ctrl`/`⌘+Enter` force-confirms — the blocked rows are persisted `PENDING` rather than being
   * written as confident, which is the server's rule, not this component's (`confirmDespiteLowConfidence`
   * stays false).
   */
  onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey) return;
    const force = event.ctrlKey || event.metaKey;
    if (!this.canCommit(this.rows())) return;
    if (!force && (this.blockedRows(this.rows()).length > 0 || ambiguousRows(this.rows()).length > 0)) {
      // The first problem row is already visible; the note under the button says what to do.
      this.error.set(this.i18n.t('capture.confirmBlockedTitle'));
      return;
    }
    event.preventDefault();
    void this.commit();
  }

  useExample(value: string): void {
    this.onInput(value);
  }

  percent(confidence: number): number {
    return Math.round(confidence * 100);
  }

  glyphFor(lane: CaptureLane): string {
    return lane === 'AUTO' ? '●' : lane === 'ADVISORY' ? '◐' : lane === 'ASK' ? '!' : '…';
  }

  laneLabel(lane: CaptureLane): string {
    // A closed list, so a new arm in the view is a compile error here rather than a raw key on screen.
    const keys: Record<CaptureLane, TranslationKey> = {
      AUTO: 'capture.lane.AUTO',
      ADVISORY: 'capture.lane.ADVISORY',
      ASK: 'capture.lane.ASK',
      AWAITING: 'capture.lane.AWAITING',
    };
    return this.i18n.t(keys[lane]);
  }

  provenanceLabel(row: CaptureRow): string {
    const source = provenanceOf(row);
    const known: Record<string, TranslationKey> = {
      USER: 'capture.provenance.USER',
      RULE: 'capture.provenance.RULE',
      KEYWORD: 'capture.provenance.KEYWORD',
      MERCHANT_DEFAULT: 'capture.provenance.MERCHANT_DEFAULT',
      COUNTERPARTY_DEFAULT: 'capture.provenance.COUNTERPARTY_DEFAULT',
      AI: 'capture.provenance.AI',
      FALLBACK: 'capture.provenance.FALLBACK',
      NONE: 'capture.provenance.NONE',
    };
    return this.i18n.t(known[source] ?? 'capture.provenance.NONE');
  }

  confirmLabel(): string {
    const rows = this.rows();
    const count = confirmableRows(rows).length;
    const review = blockedRows(rows).length;
    return review > 0
      ? this.i18n.t('capture.confirmWithReview', { count, review })
      : this.i18n.t('capture.confirm', { count });
  }

  amountText(row: CaptureRow): string {
    const minor = chosenAmountMinor(row);
    if (minor === null) return '';
    // The domain's own formatter, so the digits in the input match the digits in the preview and a
    // second currency (JPY has no minor unit) needs no change here. A `Number(minor) / 100` would be
    // a float in the money path — display-only or not, ADR-003 does not carve that out.
    return toMajorString(minor, row.currency);
  }

  categoriesFor(row: CaptureRow): readonly CategoryNode[] {
    const kind = row.kind === 'INCOME' ? 'INCOME' : 'EXPENSE';
    // I-3: an EXPENSE can never take an INCOME category, so the picker never offers one.
    return this.categories().filter((category) => category.kind === kind);
  }

  rowError(row: CaptureRow): RowError | undefined {
    return this.rowErrors().get(row.clientRowId);
  }

  pickAmount(row: CaptureRow, amountMinor: bigint): void {
    this.update(row.clientRowId, (current) => ({ ...current, pickedAmountMinor: amountMinor }));
  }

  /**
   * A typed amount.
   *
   * Parsed with the domain's own `parseAmount`, so `1.200` means what it means everywhere else in the
   * product. An unparseable value is ignored rather than clearing the row: losing the parsed amount
   * because of a half-typed edit would be worse than leaving the previous one.
   */
  setAmount(row: CaptureRow, value: string): void {
    const parsed = parseAmount(value, row.currency);
    if (!parsed.money) return;
    const amountMinor = parsed.money.amountMinor;
    this.update(row.clientRowId, (current) => ({
      ...current,
      pickedAmountMinor: amountMinor,
      // An explicit amount is also the user's answer to an ambiguity.
      candidates:
        current.candidates.length > 0
          ? current.candidates
          : [{ amountMinor, reason: 'USER' }],
    }));
  }

  setKind(row: CaptureRow, value: string): void {
    const kind = value === 'INCOME' ? 'INCOME' : 'EXPENSE';
    this.update(row.clientRowId, (current) => {
      const allowed = this.categories().filter((category) => category.kind === kind);
      const keep =
        current.categoryId !== null && allowed.some((category) => category.id === current.categoryId);
      // Changing the direction drops a category of the other kind rather than sending it and having
      // the server refuse the row with I-3 (docs/02 §3: the picker is filtered by `kind`).
      return { ...current, kind, categoryId: keep ? current.categoryId : null };
    });
  }

  setCategory(row: CaptureRow, value: string): void {
    this.update(row.clientRowId, (current) => ({ ...current, categoryId: value === '' ? null : value }));
  }

  setDescription(row: CaptureRow, value: string): void {
    this.update(row.clientRowId, (current) => ({ ...current, description: value }));
  }

  setDate(row: CaptureRow, value: string): void {
    this.update(row.clientRowId, (current) => ({ ...current, occurredOn: value === '' ? null : value }));
  }

  toggleRemoved(row: CaptureRow): void {
    this.update(row.clientRowId, (current) => ({ ...current, removed: !current.removed }));
    this.rejected.set([]);
  }

  clear(): void {
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.parseToken += 1;
    this.text.set('');
    this.rows.set([]);
    this.parseId = null;
    this.error.set(null);
    this.saved.set(null);
    this.rejected.set([]);
    this.rowErrors.set(new Map());
  }

  /** One `captureCommit` call for the whole batch (docs/06 §5.2). Atomic and idempotent. */
  async commit(): Promise<void> {
    const payload = toCommitRows(this.rows());
    if (payload.length === 0) return;
    const blockedBefore = blockedRows(this.rows()).length;

    this.busy.set(true);
    this.error.set(null);
    this.saved.set(null);
    this.rejected.set([]);
    this.rowErrors.set(new Map());

    try {
      const response = await this.graphql.query<CommitResponse>(CAPTURE_COMMIT, {
        input: {
          parseId: this.parseId,
          rows: payload,
          defaultAccountId: this.accountId() === '' ? null : this.accountId(),
          occurredLocalDate: null,
          discardProposalIds: this.discardedProposalIds(),
          allowAi: true,
        },
      });

      const result = response.captureCommit;
      if (result.__typename === 'CaptureCommitRejectedModel') {
        const refused: RowError[] = (result.rejected ?? []).map((entry) => ({
          clientRowId: entry.clientRowId,
          message: entry.message,
          field: entry.field,
        }));
        this.rejected.set(refused);
        this.rowErrors.set(new Map(refused.map((entry) => [entry.clientRowId, entry])));
        return;
      }

      const count = result.committed?.length ?? 0;
      const replay = result.replayed === true;
      const summary = replay
        ? this.i18n.t('capture.savedReplay')
        : this.i18n.t('capture.saved', { count });
      this.saved.set(
        // The blocked rows were counted *before* the commit cleared the batch, and they are the ones
        // the server wrote PENDING. Saying so is the difference between "it worked" and "it worked,
        // and two of them are waiting for you".
        blockedBefore > 0
          ? `${summary} ${this.i18n.t('capture.savedReview', { count: blockedBefore })}`
          : summary,
      );

      // The field is cleared only on success: a failed commit must leave the user's text exactly
      // where it was, and the rows' `idempotencyKey`s are what make the retry safe.
      this.text.set('');
      this.rows.set([]);
      this.parseId = null;
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.busy.set(false);
    }
  }

  /** Fragments the user removed, so their decisions are labelled rejected (docs/04 §6.4). */
  private discardedProposalIds(): readonly string[] {
    return this.rows()
      .filter((row) => row.removed && row.proposal !== null)
      .map((row) => row.proposal!.id);
  }

  private update(clientRowId: string, change: (row: CaptureRow) => CaptureRow): void {
    this.rows.set(this.rows().map((row) => (row.clientRowId === clientRowId ? change(row) : row)));
  }
}

/** The server fragment → the view's proposal shape, keeping money as `bigint`. */
function toProposal(fragment: ParseResponse['captureParse']['fragments'][number]): CaptureProposal {
  return {
    id: fragment.id,
    categoryId: fragment.categoryId,
    decidedBy: fragment.decidedBy,
    confidence: fragment.confidence,
    needsReview: fragment.needsReview,
    advisory: fragment.advisory,
    rationale: fragment.rationale,
    merchantId: fragment.merchantId,
    alternatives: fragment.alternatives,
    // `amountMinor` crosses the wire as a string so it cannot be rounded (ADR-003); this is the one
    // place the preview converts it, and it converts straight to `bigint`.
    amountMinor: fragment.amountMinor === null ? null : BigInt(fragment.amountMinor),
    currency: fragment.currency,
    description: fragment.description,
    needsDirectionConfirmation: fragment.needsDirectionConfirmation,
  };
}
