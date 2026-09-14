import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { aliasUnion } from '../../shared/aliases';
import { ErrorMessageService } from '../../core/api/error-message.service';
import { GraphqlClient } from '../../core/graphql/graphql.client';
import { I18nService } from '../../core/i18n/i18n.service';
import type { TranslationKey } from '../../core/i18n/translations';
import {
  deleteRefusal,
  matchesTypeFilter,
  mergeRefusal,
  sameCounterpartyName,
  TYPE_FILTERS,
  type CounterpartyNode,
  type CounterpartyType,
  type TypeFilter,
} from './counterparties.view';

interface CategoryOption {
  readonly id: string;
  readonly name: string;
  readonly path: readonly string[];
}

const COUNTERPARTY_FIELDS = /* GraphQL */ `
  fragment CounterpartyFields on CounterpartyModel {
    id
    name
    type
    defaultCategoryId
    defaultCategoryPath
    note
    transactionCount
    aliases {
      id
      alias
    }
  }
`;

const COUNTERPARTIES_QUERY = /* GraphQL */ `
  ${COUNTERPARTY_FIELDS}
  query Counterparties($search: String, $first: Int) {
    counterparties(search: $search, first: $first) {
      totalCount
      pageInfo {
        hasNextPage
      }
      edges {
        node {
          ...CounterpartyFields
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

const CREATE_COUNTERPARTY = /* GraphQL */ `
  ${COUNTERPARTY_FIELDS}
  mutation CreateCounterparty(
    $name: String!
    $type: CounterpartyType
    $defaultCategoryId: ID
    $note: String
  ) {
    createCounterparty(
      name: $name
      type: $type
      defaultCategoryId: $defaultCategoryId
      note: $note
    ) {
      ...CounterpartyFields
    }
  }
`;

const UPDATE_COUNTERPARTY = /* GraphQL */ `
  ${COUNTERPARTY_FIELDS}
  mutation UpdateCounterparty(
    $id: ID!
    $name: String
    $type: CounterpartyType
    $defaultCategoryId: ID
    $note: String
  ) {
    updateCounterparty(
      id: $id
      name: $name
      type: $type
      defaultCategoryId: $defaultCategoryId
      note: $note
    ) {
      ...CounterpartyFields
    }
  }
`;

const SET_ALIASES = /* GraphQL */ `
  ${COUNTERPARTY_FIELDS}
  mutation SetCounterpartyAliases($counterpartyId: ID!, $aliases: [String!]!) {
    setCounterpartyAliases(counterpartyId: $counterpartyId, aliases: $aliases) {
      ...CounterpartyFields
    }
  }
`;

const MERGE_COUNTERPARTIES = /* GraphQL */ `
  ${COUNTERPARTY_FIELDS}
  mutation MergeCounterparties($sourceId: ID!, $targetId: ID!) {
    mergeCounterparties(sourceId: $sourceId, targetId: $targetId) {
      ...CounterpartyFields
    }
  }
`;

const DELETE_COUNTERPARTY = /* GraphQL */ `
  mutation DeleteCounterparty($id: ID!) {
    deleteCounterparty(id: $id)
  }
`;

/** The API caps a page at 200. A household's counterparties are a handful. */
const PAGE_SIZE = 200;

/**
 * Counterparties — the people and companies money moved to or from (F-11; docs/02 §4.9).
 *
 * F-11's stated requirement is literally a spelling variant: "Dejan rođa" must be one Counterparty,
 * not two. So the two things this screen is built around are **aliases** and **merge**:
 *
 *  - **The duplicate check folds before the round trip**, exactly as the server does, so a name the
 *    screen accepts is a name the API accepts. A warning that says "free" followed by a `CONFLICT`
 *    reads as a broken app, and this is the one entity where the user is most likely to retype a name
 *    they already have.
 *  - **The merge preview states the alias union and how many Transactions move** before committing,
 *    the same contract as Merchants. Merging is destructive for the source and the numbers go on
 *    screen first.
 *
 * The type tabs (All / People / Companies / Government / Other) filter on the client: the API's
 * `counterparties` query takes no `type` argument, and the list is small enough that pagination is
 * not in play. If a Household ever has hundreds, that filter belongs in the API.
 */
@Component({
  selector: 'fm-counterparties',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule],
  template: `
    <header class="head">
      <div>
        <h1 class="head__title">{{ i18n.t('counterparties.title') }}</h1>
        <p class="head__sub">{{ i18n.t('counterparties.subtitle') }}</p>
      </div>
      <button class="btn btn--primary" type="button" (click)="startCreate()">
        {{ i18n.t('counterparties.add') }}
      </button>
    </header>

    @if (error()) {
      <p class="alert" role="alert">{{ error() }}</p>
    }
    <p class="announce" aria-live="polite">{{ announcement() }}</p>

    @if (creating()) {
      <section class="panel">
        <h2 class="panel__title">{{ i18n.t('counterparties.addTitle') }}</h2>
        <form class="form" [formGroup]="createForm" (ngSubmit)="create()" novalidate>
          <label class="field">
            <span class="field__label">{{ i18n.t('counterparties.name') }}</span>
            <input class="field__input" type="text" formControlName="name" required />
            @if (duplicateWarning()) {
              <span class="field__hint field__hint--warn">{{ duplicateWarning() }}</span>
            }
          </label>
          <label class="field">
            <span class="field__label">{{ i18n.t('counterparties.type') }}</span>
            <select class="field__input" formControlName="type">
              @for (option of types; track option) {
                <option [value]="option">{{ typeLabel(option) }}</option>
              }
            </select>
          </label>
          <label class="field">
            <span class="field__label">{{ i18n.t('counterparties.defaultCategory') }}</span>
            <select class="field__input" formControlName="defaultCategoryId">
              <option value="">{{ i18n.t('counterparties.noDefaultCategory') }}</option>
              @for (category of categories(); track category.id) {
                <option [value]="category.id">{{ categoryLabel(category) }}</option>
              }
            </select>
          </label>
          <div class="actions">
            <button class="btn btn--primary" type="submit" [disabled]="busy()">
              {{ busy() ? i18n.t('counterparties.creating') : i18n.t('counterparties.create') }}
            </button>
            <button class="btn" type="button" (click)="creating.set(false)">
              {{ i18n.t('counterparties.cancel') }}
            </button>
          </div>
        </form>
      </section>
    }

    <div class="editor">
      <section class="panel">
        <label class="field">
          <span class="field__label">{{ i18n.t('counterparties.search') }}</span>
          <input
            class="field__input"
            type="search"
            [value]="search()"
            [placeholder]="i18n.t('counterparties.searchPlaceholder')"
            (input)="onSearch($any($event.target).value)"
          />
        </label>

        <div class="tabs" role="group" [attr.aria-label]="i18n.t('counterparties.type')">
          @for (option of typeFilters; track option) {
            <button
              class="tabs__tab"
              type="button"
              [class.tabs__tab--on]="typeFilter() === option"
              [attr.aria-pressed]="typeFilter() === option"
              (click)="typeFilter.set(option)"
            >
              {{ typeFilterLabel(option) }}
              <span class="tabs__count">{{ countFor(option) }}</span>
            </button>
          }
        </div>

        @if (loading()) {
          <p class="muted">{{ i18n.t('accounts.loading') }}</p>
        } @else if (visible().length === 0) {
          <div class="empty">
            <p class="empty__title">
              {{
                search() || typeFilter() !== 'ALL'
                  ? i18n.t('counterparties.emptyFiltered')
                  : i18n.t('counterparties.empty')
              }}
            </p>
            @if (!search() && typeFilter() === 'ALL') {
              <p class="empty__body">{{ i18n.t('counterparties.emptyBody') }}</p>
            }
          </div>
        } @else {
          <ul class="list">
            @for (row of visible(); track row.id) {
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
                      {{ typeLabel(row.type) }}
                      @if (categoryPathOf(row); as path) {
                        · {{ path }}
                      }
                    </span>
                  </span>
                  <span class="row__count">
                    {{
                      row.transactionCount > 0
                        ? i18n.t('counterparties.usage', { count: row.transactionCount })
                        : i18n.t('counterparties.usageNone')
                    }}
                  </span>
                </button>
              </li>
            }
          </ul>
          @if (truncated()) {
            <p class="hint">{{ i18n.t('counterparties.truncated') }}</p>
          }
        }
      </section>

      <section class="panel">
        @if (selected(); as node) {
          <h2 class="panel__title">{{ node.name }}</h2>

          <form class="form" [formGroup]="form" (ngSubmit)="save()" novalidate>
            <label class="field">
              <span class="field__label">{{ i18n.t('counterparties.name') }}</span>
              <input class="field__input" type="text" formControlName="name" required />
              @if (duplicateWarning()) {
                <span class="field__hint field__hint--warn">{{ duplicateWarning() }}</span>
              }
            </label>

            <label class="field">
              <span class="field__label">{{ i18n.t('counterparties.type') }}</span>
              <select class="field__input" formControlName="type">
                @for (option of types; track option) {
                  <option [value]="option">{{ typeLabel(option) }}</option>
                }
              </select>
            </label>

            <label class="field">
              <span class="field__label">{{ i18n.t('counterparties.defaultCategory') }}</span>
              <select class="field__input" formControlName="defaultCategoryId">
                <option value="">{{ i18n.t('counterparties.noDefaultCategory') }}</option>
                @for (category of categories(); track category.id) {
                  <option [value]="category.id">{{ categoryLabel(category) }}</option>
                }
              </select>
              <span class="field__hint">{{ i18n.t('counterparties.defaultCategoryHint') }}</span>
            </label>

            <label class="field">
              <span class="field__label">{{ i18n.t('counterparties.note') }}</span>
              <input class="field__input" type="text" formControlName="note" />
            </label>

            <button class="btn btn--primary" type="submit" [disabled]="busy()">
              {{ busy() ? i18n.t('counterparties.saving') : i18n.t('counterparties.save') }}
            </button>
          </form>

          <section class="block">
            <h3 class="block__title">{{ i18n.t('counterparties.aliases') }}</h3>
            <p class="hint">{{ i18n.t('counterparties.aliasesHint') }}</p>

            @if (node.aliases.length === 0) {
              <p class="hint">{{ i18n.t('counterparties.noAliases') }}</p>
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
                      [attr.aria-label]="
                        i18n.t('counterparties.removeAlias', { alias: alias.alias })
                      "
                    >
                      ×
                    </button>
                  </li>
                }
              </ul>
            }

            <form class="alias-form" [formGroup]="aliasForm" (ngSubmit)="addAlias()" novalidate>
              <label class="field">
                <span class="field__label">{{ i18n.t('counterparties.aliases') }}</span>
                <input
                  class="field__input"
                  type="text"
                  formControlName="alias"
                  [placeholder]="i18n.t('counterparties.aliasPlaceholder')"
                  required
                />
              </label>
              <button class="btn" type="submit" [disabled]="busy()">
                {{ i18n.t('counterparties.addAlias') }}
              </button>
            </form>
          </section>

          <section class="block">
            <h3 class="block__title">{{ i18n.t('counterparties.merge') }}</h3>
            <p class="hint">{{ i18n.t('counterparties.mergeHint') }}</p>

            <label class="field">
              <span class="field__label">{{ i18n.t('counterparties.mergeTarget') }}</span>
              <select
                class="field__input"
                [value]="mergeTargetId()"
                (change)="setMergeTarget($any($event.target).value)"
              >
                <option value="">{{ i18n.t('counterparties.chooseTarget') }}</option>
                @for (option of mergeOptions(); track option.id) {
                  <option [value]="option.id">{{ option.name }}</option>
                }
              </select>
            </label>

            @if (refusalKey(); as key) {
              <p class="hint hint--warn">{{ i18n.t(key) }}</p>
            } @else if (mergeTarget(); as target) {
              <p class="hint">
                {{
                  node.transactionCount > 0
                    ? i18n.t('counterparties.mergePreviewCount', { count: node.transactionCount })
                    : i18n.t('counterparties.mergePreviewNone')
                }}
              </p>
              <p class="hint">
                {{ i18n.t('counterparties.mergePreviewAliases') }}:
                {{ unionPreview().join(', ') || '—' }}
              </p>
              <button class="btn btn--danger" type="button" [disabled]="busy()" (click)="merge()">
                {{ busy() ? i18n.t('counterparties.merging') : i18n.t('counterparties.mergeConfirm') }}
              </button>
            }
          </section>

          <section class="block">
            <h3 class="block__title">{{ i18n.t('counterparties.delete') }}</h3>
            @if (deleteRefusalKey(); as key) {
              <p class="hint hint--warn">{{ i18n.t(key) }}</p>
            } @else {
              <button class="btn btn--danger" type="button" [disabled]="busy()" (click)="remove()">
                {{ busy() ? i18n.t('counterparties.deleting') : i18n.t('counterparties.delete') }}
              </button>
            }
          </section>
        } @else {
          <p class="muted">{{ i18n.t('counterparties.selectPrompt') }}</p>
        }
      </section>
    </div>
  `,
  styles: [
    `
      .head {
        display: flex;
        flex-wrap: wrap;
        align-items: start;
        justify-content: space-between;
        gap: var(--space-3);
        margin-block-end: var(--space-4);
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
      .announce {
        position: absolute;
        inline-size: 1px;
        block-size: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
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
      }
      .panel {
        display: grid;
        gap: var(--space-3);
        padding: var(--space-4);
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        margin-block-end: var(--space-4);
      }
      .panel__title {
        margin: 0;
        font-size: var(--text-lg);
        overflow-wrap: anywhere;
      }
      .tabs {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-1);
      }
      .tabs__tab {
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
        padding: var(--space-1) var(--space-2);
        font: inherit;
        font-size: var(--text-sm);
        color: var(--color-text-muted);
        background: var(--color-bg);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        cursor: pointer;
      }
      .tabs__tab--on {
        color: var(--color-primary-contrast);
        background: var(--color-primary);
        border-color: transparent;
      }
      .tabs__count {
        font-size: var(--text-xs);
        opacity: 0.8;
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
        background: color-mix(in srgb, var(--color-primary) 12%, transparent);
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
        font-weight: 600;
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
        .form,
        .alias-form {
          grid-template-columns: 1fr 1fr;
        }
        .form > .actions,
        .form > .btn {
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
      .field__hint--warn {
        color: var(--color-warning);
      }
      .field__input {
        padding: var(--space-2);
        font: inherit;
        color: var(--color-text);
        background: var(--color-bg);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        min-inline-size: 0;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      .btn {
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
      .block {
        display: grid;
        gap: var(--space-2);
        padding-block-start: var(--space-3);
        border-block-start: 1px solid var(--color-border);
      }
      .block__title {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: 600;
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
        border-radius: 999px;
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
export class CounterpartiesComponent {
  readonly i18n = inject(I18nService);
  private readonly graphql = inject(GraphqlClient);
  private readonly errors = inject(ErrorMessageService);
  private readonly fb = inject(FormBuilder);

  readonly types: readonly CounterpartyType[] = ['PERSON', 'COMPANY', 'GOVERNMENT', 'OTHER'];
  readonly typeFilters = TYPE_FILTERS;

  readonly rows = signal<readonly CounterpartyNode[]>([]);
  readonly categories = signal<readonly CategoryOption[]>([]);
  readonly selectedId = signal<string | null>(null);
  readonly search = signal('');
  readonly typeFilter = signal<TypeFilter>('ALL');
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
    type: ['PERSON' as CounterpartyType, [Validators.required]],
    defaultCategoryId: [''],
  });

  readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    type: ['PERSON' as CounterpartyType, [Validators.required]],
    defaultCategoryId: [''],
    note: [''],
  });

  readonly aliasForm = this.fb.nonNullable.group({
    alias: ['', [Validators.required, Validators.maxLength(120)]],
  });

  /** The list after the type tab, which is the only client-side filter here. */
  readonly visible = computed(() =>
    this.rows().filter((row) => matchesTypeFilter(row, this.typeFilter())),
  );

  readonly selected = computed(() => {
    const id = this.selectedId();
    return id ? (this.rows().find((row) => row.id === id) ?? null) : null;
  });

  readonly mergeTarget = computed(() => {
    const id = this.mergeTargetId();
    return id ? (this.rows().find((row) => row.id === id) ?? null) : null;
  });

  readonly mergeOptions = computed(() => {
    const source = this.selected();
    return this.rows().filter((row) => row.id !== source?.id);
  });

  readonly unionPreview = computed(() => aliasUnion(this.selected(), this.mergeTarget()));

  readonly refusalKey = computed<TranslationKey | null>(() => {
    const refusal = mergeRefusal(this.selected(), this.mergeTarget());
    return refusal ? (`counterparties.refusal${refusal}` as TranslationKey) : null;
  });

  readonly deleteRefusalKey = computed<TranslationKey | null>(() => {
    const refusal = deleteRefusal(this.selected());
    return refusal ? (`counterparties.deleteRefusal${refusal}` as TranslationKey) : null;
  });

  readonly duplicateWarning = computed(() => {
    const name = this.creating()
      ? this.createForm.controls.name.value
      : this.form.controls.name.value;
    if (!name.trim()) return null;
    const exceptId = this.creating() ? null : (this.selectedId() ?? null);
    const clash = this.rows().some(
      (row) => row.id !== exceptId && sameCounterpartyName(row.name, name),
    );
    return clash ? this.i18n.t('counterparties.duplicateName') : null;
  });

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const result = await this.graphql.query<{
        counterparties: {
          totalCount: number;
          pageInfo: { hasNextPage: boolean };
          edges: { node: CounterpartyNode }[];
        };
        categories: CategoryOption[];
      }>(COUNTERPARTIES_QUERY, { search: this.search().trim() || null, first: PAGE_SIZE });

      this.rows.set(result.counterparties.edges.map((edge) => edge.node));
      this.categories.set(result.categories);
      this.truncated.set(result.counterparties.pageInfo.hasNextPage);

      const current = this.selectedId();
      if (current && !this.rows().some((row) => row.id === current)) this.selectedId.set(null);
      else if (current) this.select(current);
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.loading.set(false);
    }
  }

  /** How many rows each tab would show, so the tab strip is not a guess. */
  countFor(filter: TypeFilter): number {
    return this.rows().filter((row) => matchesTypeFilter(row, filter)).length;
  }

  typeLabel(type: CounterpartyType): string {
    return this.i18n.t(`counterpartyType.${type}` as TranslationKey);
  }

  typeFilterLabel(filter: TypeFilter): string {
    return filter === 'ALL'
      ? this.i18n.t('counterparties.typeAll')
      : this.typeLabel(filter);
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
        type: node.type,
        defaultCategoryId: node.defaultCategoryId ?? '',
        note: node.note ?? '',
      });
    }
  }

  categoryLabel(category: CategoryOption): string {
    return category.path.join(' › ');
  }

  categoryPathOf(row: CounterpartyNode): string | null {
    return row.defaultCategoryPath && row.defaultCategoryPath.length > 0
      ? row.defaultCategoryPath.join(' › ')
      : null;
  }

  setMergeTarget(value: string): void {
    this.mergeTargetId.set(value);
  }

  startCreate(): void {
    this.creating.set(true);
    this.createForm.reset({ name: '', type: 'PERSON', defaultCategoryId: '' });
  }

  async create(): Promise<void> {
    if (this.createForm.invalid || this.busy()) {
      this.createForm.markAllAsTouched();
      return;
    }
    const { name, type, defaultCategoryId } = this.createForm.getRawValue();

    this.busy.set(true);
    this.error.set(null);
    try {
      const result = await this.graphql.query<{ createCounterparty: CounterpartyNode }>(
        CREATE_COUNTERPARTY,
        { name, type, defaultCategoryId: defaultCategoryId === '' ? null : defaultCategoryId },
      );
      this.creating.set(false);
      await this.load();
      this.select(result.createCounterparty.id);
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
    const { name, type, defaultCategoryId, note } = this.form.getRawValue();

    this.busy.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(UPDATE_COUNTERPARTY, {
        id: node.id,
        name,
        type,
        // An empty field means clear it: the user can see it is empty, so saving must honour that.
        defaultCategoryId: defaultCategoryId === '' ? null : defaultCategoryId,
        note: note.trim() === '' ? null : note.trim(),
      });
      await this.load();
      this.select(node.id);
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
      await this.graphql.query(SET_ALIASES, { counterpartyId: node.id, aliases: [...aliases] });
      await this.load();
      this.select(node.id);
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
    await this.writeAliases(
      node.aliases.filter((existing) => existing.alias !== alias).map((existing) => existing.alias),
    );
  }

  async merge(): Promise<void> {
    const source = this.selected();
    const target = this.mergeTarget();
    if (!source || !target || this.refusalKey() || this.busy()) return;

    this.busy.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(MERGE_COUNTERPARTIES, { sourceId: source.id, targetId: target.id });
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
    if (!globalThis.confirm(this.i18n.t('counterparties.deleteConfirm'))) return;

    this.busy.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(DELETE_COUNTERPARTY, { id: node.id });
      this.selectedId.set(null);
      await this.load();
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.busy.set(false);
    }
  }
}
