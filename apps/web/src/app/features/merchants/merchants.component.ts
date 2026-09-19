import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { GraphqlClient } from '../../core/graphql/graphql.client';
import { I18nService } from '../../core/i18n/i18n.service';
import type { TranslationKey } from '../../core/i18n/translations';
import { AvatarLoaderComponent } from '../../shared/ui/avatar-loader/avatar-loader.component';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import {
  aliasUnion,
  deleteRefusal,
  mergeRefusal,
  sameMerchantName,
  type MerchantNode,
} from './merchants.view';

interface CategoryOption {
  readonly id: string;
  readonly name: string;
  readonly path: readonly string[];
}

const MERCHANT_FIELDS = /* GraphQL */ `
  fragment MerchantFields on MerchantModel {
    id
    name
    defaultCategoryId
    defaultCategoryPath
    aiHint
    isGlobal
    isOwnedByHousehold
    transactionCount
    aliases {
      id
      alias
    }
  }
`;

const MERCHANTS_QUERY = /* GraphQL */ `
  ${MERCHANT_FIELDS}
  query Merchants($search: String, $first: Int) {
    merchants(search: $search, first: $first) {
      totalCount
      pageInfo {
        hasNextPage
      }
      edges {
        node {
          ...MerchantFields
        }
      }
    }
    categories(kind: EXPENSE) {
      id
      name
      path
    }
  }
`;

const CREATE_MERCHANT = /* GraphQL */ `
  ${MERCHANT_FIELDS}
  mutation CreateMerchant($name: String!, $defaultCategoryId: ID, $aiHint: String) {
    createMerchant(name: $name, defaultCategoryId: $defaultCategoryId, aiHint: $aiHint) {
      ...MerchantFields
    }
  }
`;

const UPDATE_MERCHANT = /* GraphQL */ `
  ${MERCHANT_FIELDS}
  mutation UpdateMerchant($id: ID!, $name: String, $defaultCategoryId: ID, $aiHint: String) {
    updateMerchant(id: $id, name: $name, defaultCategoryId: $defaultCategoryId, aiHint: $aiHint) {
      ...MerchantFields
    }
  }
`;

const SET_ALIASES = /* GraphQL */ `
  ${MERCHANT_FIELDS}
  mutation SetMerchantAliases($merchantId: ID!, $aliases: [String!]!) {
    setMerchantAliases(merchantId: $merchantId, aliases: $aliases) {
      ...MerchantFields
    }
  }
`;

const DELETE_MERCHANT = /* GraphQL */ `
  mutation DeleteMerchant($id: ID!) {
    deleteMerchant(id: $id)
  }
`;

const MERGE_MERCHANTS = /* GraphQL */ `
  ${MERCHANT_FIELDS}
  mutation MergeMerchants($sourceId: ID!, $targetId: ID!) {
    mergeMerchants(sourceId: $sourceId, targetId: $targetId) {
      ...MerchantFields
    }
  }
`;

/** The API caps a page at 200, and a household catalogue is far smaller than that in practice. */
const PAGE_SIZE = 200;

/**
 * Merchants (F-10; docs/02 §4.8).
 *
 * Four things here are the product's rules rather than CRUD:
 *
 *  - **A shipped merchant is editable, and saving copies it.** The seeded catalogue is platform
 *    content, so the screen says plainly that saving makes a private copy and moves the household's
 *    transactions onto it — otherwise "why did Lidl become mine?" is a mystery.
 *  - **The merge preview states the consequences before committing** (docs/02 §4.8): the combined
 *    alias list and how many transactions will move. A merge is destructive for the source, and the
 *    only honest way to offer it is with the numbers on screen.
 *  - **A duplicate name is caught before the round trip**, so the warning and the server's `CONFLICT`
 *    cannot disagree about what counts as a duplicate. Both fold the same way.
 *  - **Delete and merge are refused with a reason, not disabled silently.** A greyed button teaches
 *    nothing; the refusal text says which rule applies and what to do instead.
 */
@Component({
  selector: 'fm-merchants',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, IconComponent, AvatarLoaderComponent],
  template: `
    <div class="fm-page">
    <header class="fm-page__head">
      <div>
        <h1 class="fm-page__title">{{ i18n.t('merchants.title') }}</h1>
        <p class="fm-page__sub">{{ i18n.t('merchants.subtitle') }}</p>
      </div>
      <div class="fm-page__actions">
        <button class="fm-btn fm-btn--primary" type="button" (click)="startCreate()">
          {{ i18n.t('merchants.add') }}
        </button>
      </div>
    </header>

    @if (error()) {
      <p class="alert" role="alert">{{ error() }}</p>
    }
    <p class="fm-visually-hidden" aria-live="polite">{{ announcement() }}</p>

    @if (creating()) {
      <section class="fm-card">
        <div class="fm-card__head">
          <h2 class="fm-card__title">
            <fm-icon name="merchants" [size]="18" />
            {{ i18n.t('merchants.addTitle') }}
          </h2>
        </div>
        <form class="form" [formGroup]="createForm" (ngSubmit)="create()" novalidate>
          <label class="fm-field">
            <span class="fm-field__label">{{ i18n.t('merchants.name') }}</span>
            <input class="fm-field__input" type="text" formControlName="name" required />
            @if (duplicateWarning()) {
              <span class="fm-field__hint fm-field__hint--warn">{{ duplicateWarning() }}</span>
            }
          </label>
          <label class="fm-field">
            <span class="fm-field__label">{{ i18n.t('merchants.defaultCategory') }}</span>
            <select class="fm-field__input" formControlName="defaultCategoryId">
              <option value="">{{ i18n.t('merchants.noDefaultCategory') }}</option>
              @for (category of categories(); track category.id) {
                <option [value]="category.id">{{ categoryLabel(category) }}</option>
              }
            </select>
          </label>
          <div class="actions">
            <button class="fm-btn fm-btn--primary" type="submit" [disabled]="busy()">
              {{ busy() ? i18n.t('merchants.creating') : i18n.t('merchants.create') }}
            </button>
            <button class="fm-btn" type="button" (click)="creating.set(false)">
              {{ i18n.t('merchants.cancel') }}
            </button>
          </div>
        </form>
      </section>
    }

    <div class="editor">
      <section class="fm-card list-card">
        <label class="fm-field">
          <span class="fm-field__label">{{ i18n.t('merchants.search') }}</span>
          <input
            class="fm-field__input"
            type="search"
            [value]="search()"
            [placeholder]="i18n.t('merchants.searchPlaceholder')"
            (input)="onSearch($any($event.target).value)"
          />
        </label>

        @if (loading()) {
          <fm-avatar-loader [rows]="6" />
        } @else if (rows().length === 0) {
          <div class="empty">
            <p class="empty__title">
              {{ search() ? i18n.t('merchants.emptySearch') : i18n.t('merchants.empty') }}
            </p>
            @if (!search()) {
              <p class="empty__body">{{ i18n.t('merchants.emptyBody') }}</p>
            }
          </div>
        } @else {
          <ul class="list">
            @for (row of rows(); track row.id) {
              <li>
                <button
                  class="row"
                  type="button"
                  [class.row--on]="selectedId() === row.id"
                  [attr.aria-current]="selectedId() === row.id ? 'true' : null"
                  (click)="select(row.id)"
                >
                  <span class="row__main">
                    <span class="row__name">{{ row.name }}</span>
                    <span class="row__meta">
                      {{ categoryPathOf(row) }}
                      @if (row.isGlobal) {
                        <span class="row__badge">{{ i18n.t('merchants.starter') }}</span>
                      }
                    </span>
                  </span>
                  <span class="row__count">
                    {{
                      row.transactionCount > 0
                        ? i18n.t('merchants.usage', { count: row.transactionCount })
                        : i18n.t('merchants.usageNone')
                    }}
                  </span>
                </button>
              </li>
            }
          </ul>
          @if (truncated()) {
            <p class="hint">{{ i18n.t('merchants.truncated') }}</p>
          }
        }
      </section>

      <section class="fm-card editor-card">
        @if (selected(); as node) {
          <div class="fm-card__head">
            <h2 class="fm-card__title">
              <fm-icon name="merchants" [size]="18" />
              {{ node.name }}
            </h2>
          </div>

          @if (node.isGlobal) {
            <p class="notice">{{ i18n.t('merchants.copyOnWrite') }}</p>
          }

          <form class="form" [formGroup]="form" (ngSubmit)="save()" novalidate>
            <label class="fm-field">
              <span class="fm-field__label">{{ i18n.t('merchants.name') }}</span>
              <input class="fm-field__input" type="text" formControlName="name" required />
              @if (duplicateWarning()) {
                <span class="fm-field__hint fm-field__hint--warn">{{ duplicateWarning() }}</span>
              }
            </label>

            <label class="fm-field">
              <span class="fm-field__label">{{ i18n.t('merchants.defaultCategory') }}</span>
              <select class="fm-field__input" formControlName="defaultCategoryId">
                <option value="">{{ i18n.t('merchants.noDefaultCategory') }}</option>
                @for (category of categories(); track category.id) {
                  <option [value]="category.id">{{ categoryLabel(category) }}</option>
                }
              </select>
              <span class="fm-field__hint">{{ i18n.t('merchants.defaultCategoryHint') }}</span>
            </label>

            <label class="fm-field">
              <span class="fm-field__label">{{ i18n.t('merchants.aiHint') }}</span>
              <input class="fm-field__input" type="text" formControlName="aiHint" />
              <span class="fm-field__hint">{{ i18n.t('merchants.aiHintHint') }}</span>
            </label>

            <button class="fm-btn fm-btn--primary" type="submit" [disabled]="busy()">
              {{ busy() ? i18n.t('merchants.saving') : i18n.t('merchants.save') }}
            </button>
          </form>

          <section class="block">
            <h3 class="block__title">{{ i18n.t('merchants.aliases') }}</h3>
            <p class="hint">{{ i18n.t('merchants.aliasesHint') }}</p>

            @if (node.aliases.length === 0) {
              <p class="hint">{{ i18n.t('merchants.noAliases') }}</p>
            } @else {
              <ul class="chips">
                @for (alias of node.aliases; track alias.id) {
                  <li class="chip">
                    <span class="chip__word">{{ alias.alias }}</span>
                    <button
                      class="chip__remove"
                      type="button"
                      [disabled]="busy()"
                      (click)="removeAlias(alias.alias)"
                      [attr.aria-label]="i18n.t('merchants.removeAlias', { alias: alias.alias })"
                    >
                      ×
                    </button>
                  </li>
                }
              </ul>
            }

            <form class="alias-form" [formGroup]="aliasForm" (ngSubmit)="addAlias()" novalidate>
              <label class="fm-field">
                <span class="fm-field__label">{{ i18n.t('merchants.aliases') }}</span>
                <input
                  class="fm-field__input"
                  type="text"
                  formControlName="alias"
                  [placeholder]="i18n.t('merchants.aliasPlaceholder')"
                  required
                />
              </label>
              <button class="fm-btn" type="submit" [disabled]="busy()">
                {{ i18n.t('merchants.addAlias') }}
              </button>
            </form>
          </section>

          <section class="block">
            <h3 class="block__title">{{ i18n.t('merchants.merge') }}</h3>
            <p class="hint">{{ i18n.t('merchants.mergeHint') }}</p>

            <label class="fm-field">
              <span class="fm-field__label">{{ i18n.t('merchants.mergeTarget') }}</span>
              <select
                class="fm-field__input"
                [value]="mergeTargetId()"
                (change)="setMergeTarget($any($event.target).value)"
              >
                <option value="">{{ i18n.t('merchants.chooseTarget') }}</option>
                @for (option of mergeOptions(); track option.id) {
                  <option [value]="option.id">{{ option.name }}</option>
                }
              </select>
            </label>

            @if (refusalKey(); as key) {
              <p class="hint hint--warn">{{ i18n.t(key) }}</p>
            } @else if (mergeTarget(); as target) {
              <!-- The consequences, before committing: a merge is destructive for the source. -->
              <p class="hint">
                {{
                  node.transactionCount > 0
                    ? i18n.t('merchants.mergePreviewCount', { count: node.transactionCount })
                    : i18n.t('merchants.mergePreviewNone')
                }}
              </p>
              <p class="hint">
                {{ i18n.t('merchants.mergePreviewAliases') }}:
                {{ unionPreview().join(', ') || '—' }}
              </p>
              <button class="fm-btn fm-btn--danger" type="button" [disabled]="busy()" (click)="merge()">
                {{ busy() ? i18n.t('merchants.merging') : i18n.t('merchants.mergeConfirm') }}
              </button>
            }
          </section>

          <section class="block">
            <h3 class="block__title">{{ i18n.t('merchants.delete') }}</h3>
            @if (deleteRefusalKey(); as key) {
              <p class="hint hint--warn">{{ i18n.t(key) }}</p>
            } @else {
              <button class="fm-btn fm-btn--danger" type="button" [disabled]="busy()" (click)="remove()">
                {{ busy() ? i18n.t('merchants.deleting') : i18n.t('merchants.delete') }}
              </button>
            }
          </section>
        } @else {
          <p class="muted">{{ i18n.t('merchants.selectPrompt') }}</p>
        }
      </section>
    </div>
    </div>
  `,
  styles: [
    `
      .muted {
        margin: var(--space-1) 0 0;
        color: var(--color-text-muted);
        font-size: var(--text-sm);
      }
      .alert {
        margin: 0;
        padding: var(--space-3);
        border-radius: var(--radius-md);
        background: var(--color-danger-soft);
        color: var(--color-danger);
        font-size: var(--text-sm);
      }
      .editor {
        display: grid;
        gap: var(--space-4);
        align-items: start;
      }
      @media (min-width: 1024px) {
        .editor {
          grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
        }
        /* The editor stays beside the list instead of scrolling away under it. */
        .editor-card {
          position: sticky;
          inset-block-start: var(--space-5);
        }
      }
      /* A long merchant name wraps rather than widening the card. */
      .editor-card .fm-card__title {
        overflow-wrap: anywhere;
      }
      /* PAGE_SIZE is the API's own cap and the seeded catalogue is the whole list, so the list card
         is bounded and scrolls on its own: unbounded it ran thousands of pixels past the editor, and
         the editor's own prompt — "choose a merchant" — was off screen the moment the list began. */
      .list-card {
        max-block-size: 70vh;
        overflow-y: auto;
      }
      .notice {
        margin: 0;
        padding: var(--space-3);
        border-radius: var(--radius-md);
        background: var(--color-primary-soft);
        font-size: var(--text-sm);
      }
      .list,
      .chips {
        display: grid;
        gap: var(--space-1);
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .chips {
        grid-auto-flow: column;
        grid-auto-columns: max-content;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      .row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        inline-size: 100%;
        padding: var(--space-2) var(--space-3);
        font: inherit;
        text-align: start;
        color: inherit;
        background: none;
        border: 1px solid transparent;
        border-radius: var(--radius-md);
        cursor: pointer;
      }
      .row:hover,
      .row:focus-visible {
        border-color: var(--color-primary);
      }
      .row--on {
        background: var(--color-primary-soft);
      }
      .row__main {
        display: grid;
        gap: var(--space-1);
        min-inline-size: 0;
      }
      .row__name {
        overflow-wrap: anywhere;
      }
      .row__meta {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
      }
      .row__badge {
        padding: 0 var(--space-1);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
      }
      .row__count {
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
        white-space: nowrap;
      }
      .empty {
        padding: var(--space-4);
        border: 1px dashed var(--color-border);
        border-radius: var(--radius-md);
        text-align: center;
      }
      .empty__title {
        margin: 0 0 var(--space-1);
        font-weight: var(--weight-semibold);
      }
      .empty__body {
        margin: 0;
        color: var(--color-text-muted);
        font-size: var(--text-sm);
      }
      .form,
      .alias-form {
        display: grid;
        gap: var(--space-3);
      }
      @media (min-width: 700px) {
        .form {
          grid-template-columns: 1fr 1fr;
        }
        .form > .actions,
        .form > .fm-btn {
          grid-column: 1 / -1;
        }
        .alias-form {
          grid-template-columns: 1fr auto;
          align-items: end;
        }
      }
      /* The box, its label and its hint come from .fm-field*; only the warning ink is this screen's. */
      .fm-field {
        min-inline-size: 0;
      }
      .fm-field__hint--warn {
        color: var(--color-warning);
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      .block {
        display: grid;
        gap: var(--space-2);
        padding-block-start: var(--space-3);
        border-block-start: 1px solid var(--color-border);
      }
      .block__title {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--weight-semibold);
      }
      .hint {
        margin: 0;
        color: var(--color-text-subtle);
        font-size: var(--text-xs);
      }
      .hint--warn {
        color: var(--color-warning);
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
        max-inline-size: 100%;
        padding: var(--space-1) var(--space-2);
        font-size: var(--text-sm);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-pill);
      }
      .chip__word {
        overflow-wrap: anywhere;
      }
      .chip__remove {
        padding: 0 var(--space-1);
        font: inherit;
        color: var(--color-text-subtle);
        background: none;
        border: none;
        cursor: pointer;
      }
    `,
  ],
})
export class MerchantsComponent {
  readonly i18n = inject(I18nService);
  private readonly graphql = inject(GraphqlClient);
  private readonly errors = inject(ErrorMessageService);
  private readonly fb = inject(FormBuilder);

  readonly rows = signal<readonly MerchantNode[]>([]);
  readonly categories = signal<readonly CategoryOption[]>([]);
  readonly selectedId = signal<string | null>(null);
  readonly search = signal('');
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly creating = signal(false);
  readonly error = signal<string | null>(null);
  readonly announcement = signal('');
  readonly truncated = signal(false);
  readonly mergeTargetId = signal('');

  private searchTimer: ReturnType<typeof setTimeout> | undefined;

  readonly createForm = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    defaultCategoryId: [''],
  });

  readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    defaultCategoryId: [''],
    aiHint: [''],
  });

  readonly aliasForm = this.fb.nonNullable.group({
    alias: ['', [Validators.required, Validators.maxLength(120)]],
  });

  readonly selected = computed(() => {
    const id = this.selectedId();
    return id ? (this.rows().find((row) => row.id === id) ?? null) : null;
  });

  readonly mergeTarget = computed(() => {
    const id = this.mergeTargetId();
    return id ? (this.rows().find((row) => row.id === id) ?? null) : null;
  });

  /** Everything except the source itself: merging a merchant into itself is never a choice. */
  readonly mergeOptions = computed(() => {
    const source = this.selected();
    return this.rows().filter((row) => row.id !== source?.id);
  });

  readonly unionPreview = computed(() => aliasUnion(this.selected(), this.mergeTarget()));

  readonly refusalKey = computed<TranslationKey | null>(() => {
    const refusal = mergeRefusal(this.selected(), this.mergeTarget());
    return refusal ? (`merchants.refusal${refusal}` as TranslationKey) : null;
  });

  readonly deleteRefusalKey = computed<TranslationKey | null>(() => {
    const refusal = deleteRefusal(this.selected());
    return refusal ? (`merchants.deleteRefusal${refusal}` as TranslationKey) : null;
  });

  /**
   * Warn about a duplicate before the request.
   *
   * The warning and the server's `CONFLICT` must agree on what a duplicate is, which is why both
   * fold the same way — a warning that says "free" followed by a refusal reads as a broken app.
   */
  readonly duplicateWarning = computed(() => {
    const name = this.creating()
      ? this.createForm.controls.name.value
      : this.form.controls.name.value;
    if (!name.trim()) return null;
    const exceptId = this.creating() ? null : (this.selectedId() ?? null);
    const clash = this.rows().some(
      (row) => row.id !== exceptId && sameMerchantName(row.name, name),
    );
    return clash ? this.i18n.t('merchants.duplicateName') : null;
  });

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const result = await this.graphql.query<{
        merchants: {
          totalCount: number;
          pageInfo: { hasNextPage: boolean };
          edges: { node: MerchantNode }[];
        };
        categories: CategoryOption[];
      }>(MERCHANTS_QUERY, { search: this.search().trim() || null, first: PAGE_SIZE });

      this.rows.set(result.merchants.edges.map((edge) => edge.node));
      this.categories.set(result.categories);
      this.truncated.set(result.merchants.pageInfo.hasNextPage);

      // The selected row is re-read from the fresh page so an edit is reflected without a refetch.
      const current = this.selectedId();
      if (current && !this.rows().some((row) => row.id === current)) this.selectedId.set(null);
      else if (current) this.select(current);
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.loading.set(false);
    }
  }

  onSearch(value: string): void {
    this.search.set(value);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => void this.load(), 300);
  }

  select(id: string): void {
    this.selectedId.set(id);
    this.mergeTargetId.set('');
    this.announcement.set('');
    const node = this.rows().find((row) => row.id === id);
    if (node) {
      this.form.patchValue({
        name: node.name,
        defaultCategoryId: node.defaultCategoryId ?? '',
        aiHint: node.aiHint ?? '',
      });
    }
  }

  categoryLabel(category: CategoryOption): string {
    return category.path.join(' › ');
  }

  categoryPathOf(row: MerchantNode): string {
    if (row.defaultCategoryPath && row.defaultCategoryPath.length > 0) {
      return row.defaultCategoryPath.join(' › ');
    }
    return this.i18n.t('merchants.noDefaultCategory');
  }

  setMergeTarget(value: string): void {
    this.mergeTargetId.set(value);
  }

  startCreate(): void {
    this.creating.set(true);
    this.createForm.reset({ name: '', defaultCategoryId: '' });
  }

  async create(): Promise<void> {
    if (this.createForm.invalid || this.busy()) {
      this.createForm.markAllAsTouched();
      return;
    }
    const { name, defaultCategoryId } = this.createForm.getRawValue();

    this.busy.set(true);
    this.error.set(null);
    try {
      const result = await this.graphql.query<{ createMerchant: MerchantNode }>(CREATE_MERCHANT, {
        name,
        defaultCategoryId: defaultCategoryId === '' ? null : defaultCategoryId,
      });
      this.creating.set(false);
      await this.load();
      this.select(result.createMerchant.id);
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.busy.set(false);
    }
  }

  async save(): Promise<void> {
    const node = this.selected();
    if (!node || this.form.invalid || this.busy()) {
      this.form.markAllAsTouched();
      return;
    }
    const { name, defaultCategoryId, aiHint } = this.form.getRawValue();

    this.busy.set(true);
    this.error.set(null);
    try {
      const result = await this.graphql.query<{ updateMerchant: MerchantNode }>(UPDATE_MERCHANT, {
        id: node.id,
        name,
        // An empty field means "clear it": the user can see it is empty, so saving must make it so.
        defaultCategoryId: defaultCategoryId === '' ? null : defaultCategoryId,
        aiHint: aiHint.trim() === '' ? null : aiHint.trim(),
      });
      await this.load();
      this.select(result.updateMerchant.id);
      // A copy-on-write edit returns a different id, and that is the thing worth saying out loud.
      if (result.updateMerchant.id !== node.id) {
        this.announcement.set(this.i18n.t('merchants.copyOnWrite'));
      }
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.busy.set(false);
    }
  }

  private async writeAliases(aliases: readonly string[]): Promise<void> {
    const node = this.selected();
    if (!node || this.busy()) return;

    this.busy.set(true);
    this.error.set(null);
    try {
      const result = await this.graphql.query<{ setMerchantAliases: MerchantNode }>(SET_ALIASES, {
        merchantId: node.id,
        aliases: [...aliases],
      });
      await this.load();
      this.select(result.setMerchantAliases.id);
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.busy.set(false);
    }
  }

  async addAlias(): Promise<void> {
    const node = this.selected();
    if (!node || this.aliasForm.invalid || this.busy()) {
      this.aliasForm.markAllAsTouched();
      return;
    }
    const { alias } = this.aliasForm.getRawValue();
    this.aliasForm.patchValue({ alias: '' });
    // The API replaces the whole set, so the client sends the set it is showing plus the new value.
    await this.writeAliases([...node.aliases.map((existing) => existing.alias), alias]);
  }

  async removeAlias(alias: string): Promise<void> {
    const node = this.selected();
    if (!node) return;
    await this.writeAliases(node.aliases.filter((existing) => existing.alias !== alias).map((existing) => existing.alias));
  }

  async merge(): Promise<void> {
    const source = this.selected();
    const target = this.mergeTarget();
    if (!source || !target || this.refusalKey() || this.busy()) return;

    this.busy.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(MERGE_MERCHANTS, { sourceId: source.id, targetId: target.id });
      this.selectedId.set(null);
      this.mergeTargetId.set('');
      await this.load();
      this.announcement.set(`${source.name} → ${target.name}`);
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.busy.set(false);
    }
  }

  async remove(): Promise<void> {
    const node = this.selected();
    if (!node || this.busy() || this.deleteRefusalKey()) return;
    if (!globalThis.confirm(this.i18n.t('merchants.deleteConfirm'))) return;

    this.busy.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(DELETE_MERCHANT, { id: node.id });
      this.selectedId.set(null);
      await this.load();
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.busy.set(false);
    }
  }
}
