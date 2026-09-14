import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { GraphqlClient, GraphQLRequestError } from '../../core/graphql/graphql.client';
import { I18nService } from '../../core/i18n/i18n.service';
import type { TranslationKey } from '../../core/i18n/translations';
import {
  buildTree,
  moveRefusal,
  nestParentFor,
  reorderChanges,
  unnestParentFor,
  visibleRows,
  type CategoryKind,
  type CategoryNode,
  type KeywordMatchMode,
  type KeywordPolarity,
} from './categories.view';

/** The `totalCount` of a filtered Transaction page — reused here as a cheap scoped COUNT. */
interface UsageResult {
  readonly totalCount: number;
}

const CATEGORIES_QUERY = /* GraphQL */ `
  query Categories($kind: CategoryKind) {
    categories(kind: $kind) {
      id
      name
      kind
      parentId
      depth
      path
      sortOrder
      icon
      color
      aiDescription
      isSystem
      keywords {
        id
        keyword
        matchMode
        polarity
        weight
      }
    }
  }
`;

const CREATE_CATEGORY = /* GraphQL */ `
  mutation CreateCategory($kind: CategoryKind!, $name: String!, $parentId: ID) {
    createCategory(kind: $kind, name: $name, parentId: $parentId) {
      id
    }
  }
`;

const UPDATE_CATEGORY = /* GraphQL */ `
  mutation UpdateCategory(
    $id: ID!
    $name: String
    $parentId: ID
    $icon: String
    $color: String
    $aiDescription: String
    $sortOrder: Float
  ) {
    updateCategory(
      id: $id
      name: $name
      parentId: $parentId
      icon: $icon
      color: $color
      aiDescription: $aiDescription
      sortOrder: $sortOrder
    ) {
      id
    }
  }
`;

const DELETE_CATEGORY = /* GraphQL */ `
  mutation DeleteCategory($id: ID!, $reassignToId: ID) {
    deleteCategory(id: $id, reassignToId: $reassignToId)
  }
`;

const ADD_KEYWORD = /* GraphQL */ `
  mutation AddCategoryKeyword(
    $categoryId: ID!
    $keyword: String!
    $polarity: KeywordPolarity!
    $matchMode: String
  ) {
    addCategoryKeyword(
      categoryId: $categoryId
      keyword: $keyword
      polarity: $polarity
      matchMode: $matchMode
    )
  }
`;

const REMOVE_KEYWORD = /* GraphQL */ `
  mutation RemoveCategoryKeyword($keywordId: ID!) {
    removeCategoryKeyword(keywordId: $keywordId)
  }
`;

const CATEGORY_USAGE = /* GraphQL */ `
  query CategoryUsage($categoryId: ID) {
    transactions(first: 1, categoryId: $categoryId) {
      totalCount
    }
  }
`;

/**
 * The Category tree editor (F-02, F-03; docs/02 §4.7).
 *
 * Three things here are about refusing to paper over the tree's structure:
 *
 *  - **Illegal moves are explained, not attempted.** `moveRefusal` runs the same I-11 checks the
 *    server runs and names the reason (inside itself, inside its own descendant, past the five-level
 *    cap) before any request. The server re-checks, because a client is not a security boundary.
 *  - **Deleting something in use asks where its contents go.** The API refuses with `CONFLICT` (I-12)
 *    and the UI turns that into a reassignment target rather than a dead end. Nothing is moved until
 *    the user picks a destination.
 *  - **Keywords are the manual tier of categorisation** (docs/04 §5.4). `SUBSTRING` is labelled as
 *    deliberately weak, because a user who reads "matches anywhere" as "better" will make their
 *    classifier worse.
 *
 * Reordering and re-nesting are keyboard operations (Alt + arrows) plus an explicit Parent select.
 * Drag-and-drop is not implemented; the select and the arrows cover reparenting without it.
 */
@Component({
  selector: 'fm-categories',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule],
  template: `
    <header class="head">
      <div>
        <h1 class="head__title">{{ i18n.t('categories.title') }}</h1>
        <p class="head__sub">{{ i18n.t('categories.subtitle') }}</p>
      </div>
      <button class="btn btn--primary" type="button" (click)="startCreate(null)">
        {{ i18n.t('categories.add') }}
      </button>
    </header>

    <!-- Segmented control: depth and kind are structural, so the two trees never mix (I-3). -->
    <div class="segmented" role="group" [attr.aria-label]="i18n.t('categories.title')">
      <button
        class="segmented__option"
        type="button"
        [class.segmented__option--on]="kind() === 'EXPENSE'"
        [attr.aria-pressed]="kind() === 'EXPENSE'"
        (click)="setKind('EXPENSE')"
      >
        {{ i18n.t('categories.expenses') }}
      </button>
      <button
        class="segmented__option"
        type="button"
        [class.segmented__option--on]="kind() === 'INCOME'"
        [attr.aria-pressed]="kind() === 'INCOME'"
        (click)="setKind('INCOME')"
      >
        {{ i18n.t('categories.income') }}
      </button>
    </div>

    @if (error()) {
      <p class="alert" role="alert">{{ error() }}</p>
    }

    <!-- Announcements for moves, which otherwise change the list silently for a screen reader. -->
    <p class="announce" aria-live="polite">{{ announcement() }}</p>

    @if (creatingParent() !== undefined) {
      <section class="create">
        <h2 class="create__title">{{ i18n.t('categories.addTitle') }}</h2>
        <form class="create__form" [formGroup]="createForm" (ngSubmit)="create()" novalidate>
          <label class="field">
            <span class="field__label">{{ i18n.t('categories.name') }}</span>
            <input class="field__input" type="text" formControlName="name" required />
          </label>
          <label class="field">
            <span class="field__label">{{ i18n.t('categories.parent') }}</span>
            <select class="field__input" formControlName="parentId">
              <option value="">{{ i18n.t('categories.topLevel') }}</option>
              @for (option of parentOptions(null); track option.id) {
                <option [value]="option.id">{{ option.path.join(' › ') }}</option>
              }
            </select>
          </label>
          <div class="create__actions">
            <button class="btn btn--primary" type="submit" [disabled]="busy()">
              {{ busy() ? i18n.t('categories.creating') : i18n.t('categories.create') }}
            </button>
            <button class="btn" type="button" (click)="cancelCreate()">
              {{ i18n.t('categories.cancel') }}
            </button>
          </div>
        </form>
      </section>
    }

    <div class="editor">
      <section class="pane">
        @if (loading()) {
          <p class="muted">{{ i18n.t('accounts.loading') }}</p>
        } @else if (rows().length === 0) {
          <div class="empty">
            <p class="empty__title">{{ i18n.t('categories.empty') }}</p>
            <p class="empty__body">{{ i18n.t('categories.emptyBody') }}</p>
          </div>
        } @else {
          <ul class="tree" role="tree" [attr.aria-label]="i18n.t('categories.title')">
            @for (row of rows(); track row.node.id) {
              <li class="tree__item" role="treeitem" [attr.aria-level]="row.depth + 1">
                <div
                  class="tree__row"
                  [class.tree__row--on]="selectedId() === row.node.id"
                  [style.padding-inline-start.rem]="1 + row.depth * 1.25"
                >
                  @if (row.hasChildren) {
                    <button
                      class="tree__twisty"
                      type="button"
                      (click)="toggleCollapsed(row.node.id)"
                      [attr.aria-label]="
                        row.expanded ? i18n.t('categories.collapse') : i18n.t('categories.expand')
                      "
                      [attr.aria-expanded]="row.expanded"
                    >
                      {{ row.expanded ? '▾' : '▸' }}
                    </button>
                  } @else {
                    <span class="tree__twisty" aria-hidden="true"></span>
                  }

                  <button
                    class="tree__select"
                    type="button"
                    [attr.aria-current]="selectedId() === row.node.id ? 'true' : null"
                    (click)="select(row.node.id)"
                    (keydown)="onKeydown($event, row.node.id)"
                  >
                    <span class="tree__icon" aria-hidden="true">{{ row.node.icon ?? '•' }}</span>
                    <span class="tree__name">{{ row.node.name }}</span>
                    @if (row.node.isSystem) {
                      <span class="tree__badge">{{ i18n.t('categories.starter') }}</span>
                    }
                    @if (row.node.keywords.length > 0) {
                      <span class="tree__count">{{ row.node.keywords.length }}</span>
                    }
                  </button>
                </div>
              </li>
            }
          </ul>
          <p class="hint">{{ i18n.t('categories.keyboardHint') }}</p>
        }
      </section>

      <section class="pane pane--detail">
        @if (selected(); as node) {
          <h2 class="detail__title">{{ node.path.join(' › ') }}</h2>
          <p class="hint">{{ usageText() }}</p>
          <p class="hint">{{ i18n.t('categories.usageNote') }}</p>

          <form class="detail__form" [formGroup]="form" (ngSubmit)="save()" novalidate>
            <label class="field">
              <span class="field__label">{{ i18n.t('categories.name') }}</span>
              <input class="field__input" type="text" formControlName="name" required />
            </label>

            <label class="field">
              <span class="field__label">{{ i18n.t('categories.parent') }}</span>
              <select class="field__input" formControlName="parentId">
                <option value="">{{ i18n.t('categories.topLevel') }}</option>
                @for (option of parentOptions(node.id); track option.id) {
                  <option [value]="option.id">{{ option.path.join(' › ') }}</option>
                }
              </select>
            </label>

            <label class="field">
              <span class="field__label">{{ i18n.t('categories.icon') }}</span>
              <input class="field__input" type="text" maxlength="4" formControlName="icon" />
              <span class="field__hint">{{ i18n.t('categories.iconHint') }}</span>
            </label>

            <label class="field">
              <span class="field__label">{{ i18n.t('categories.color') }}</span>
              <input class="field__input field__input--color" type="color" formControlName="color" />
            </label>

            <label class="field field--wide">
              <span class="field__label">{{ i18n.t('categories.aiDescription') }}</span>
              <input class="field__input" type="text" formControlName="aiDescription" />
              <span class="field__hint">{{ i18n.t('categories.aiDescriptionHint') }}</span>
            </label>

            <div class="detail__actions field--wide">
              <button class="btn btn--primary" type="submit" [disabled]="busy()">
                {{ busy() ? i18n.t('categories.saving') : i18n.t('categories.save') }}
              </button>
              <button class="btn" type="button" (click)="startCreate(node.id)">
                {{ i18n.t('categories.addChild') }}
              </button>
            </div>
          </form>

          <section class="keywords">
            <h3 class="keywords__title">{{ i18n.t('categories.keywords') }}</h3>
            <p class="hint">{{ i18n.t('categories.keywordsHint') }}</p>

            @if (node.keywords.length === 0) {
              <p class="hint">{{ i18n.t('categories.noKeywords') }}</p>
            } @else {
              <ul class="keywords__list">
                @for (keyword of node.keywords; track keyword.id) {
                  <li class="chip" [class.chip--exclude]="keyword.polarity === 'EXCLUDE'">
                    <span class="chip__mark" aria-hidden="true">
                      {{ keyword.polarity === 'EXCLUDE' ? '−' : '+' }}
                    </span>
                    <span class="chip__word">{{ keyword.keyword }}</span>
                    <span class="chip__mode">{{ matchModeLabel(keyword.matchMode) }}</span>
                    <button
                      class="chip__remove"
                      type="button"
                      (click)="removeKeyword(keyword.id)"
                      [attr.aria-label]="
                        i18n.t('categories.removeKeyword', { keyword: keyword.keyword })
                      "
                    >
                      ×
                    </button>
                  </li>
                }
              </ul>
            }

            <form class="keywords__form" [formGroup]="keywordForm" (ngSubmit)="addKeyword()" novalidate>
              <label class="field">
                <span class="field__label">{{ i18n.t('categories.keywords') }}</span>
                <input
                  class="field__input"
                  type="text"
                  formControlName="keyword"
                  [placeholder]="i18n.t('categories.keywordPlaceholder')"
                  aria-describedby="keyword-normalised"
                  required
                />
                <!-- The server strips accents and case to match how the pipeline normalises text, so
                     the stored chip differs from what was typed. Explained up front, because a
                     silently rewritten input reads as a bug. -->
                <span class="field__hint" id="keyword-normalised">
                  {{ i18n.t('categories.keywordNormalised') }}
                </span>
              </label>
              <label class="field">
                <span class="field__label">{{ i18n.t('categories.polarity') }}</span>
                <select class="field__input" formControlName="polarity">
                  <option value="INCLUDE">{{ i18n.t('categories.polarityInclude') }}</option>
                  <option value="EXCLUDE">{{ i18n.t('categories.polarityExclude') }}</option>
                </select>
              </label>
              <label class="field">
                <span class="field__label">{{ i18n.t('categories.matchMode') }}</span>
                <select class="field__input" formControlName="matchMode">
                  <option value="WORD">{{ i18n.t('categories.matchWord') }}</option>
                  <option value="PREFIX">{{ i18n.t('categories.matchPrefix') }}</option>
                  <option value="SUBSTRING">{{ i18n.t('categories.matchSubstring') }}</option>
                </select>
              </label>
              <button class="btn" type="submit" [disabled]="busy()">
                {{ i18n.t('categories.addKeyword') }}
              </button>
            </form>

            @if (keywordForm.controls.matchMode.value === 'SUBSTRING') {
              <p class="hint hint--warn">{{ i18n.t('categories.substringWarning') }}</p>
            }
          </section>

          <section class="danger">
            <h3 class="danger__title">{{ i18n.t('categories.delete') }}</h3>

            @if (deleteRefused()) {
              <p class="alert" role="alert">{{ deleteRefused() }}</p>
              <p class="hint">{{ i18n.t('categories.deleteRefusedBody') }}</p>
              <label class="field">
                <span class="field__label">{{ i18n.t('categories.reassignTo') }}</span>
                <select class="field__input" [value]="reassignTo()" (change)="setReassignTo($event)">
                  <option value="">{{ i18n.t('categories.chooseTarget') }}</option>
                  @for (option of parentOptions(node.id); track option.id) {
                    <option [value]="option.id">{{ option.path.join(' › ') }}</option>
                  }
                </select>
              </label>
            }

            <button
              class="btn btn--danger"
              type="button"
              [disabled]="busy() || (deleteRefused() !== null && reassignTo() === '')"
              (click)="remove()"
            >
              {{
                busy()
                  ? i18n.t('categories.deleting')
                  : deleteRefused()
                    ? i18n.t('categories.reassignAndDelete')
                    : i18n.t('categories.delete')
              }}
            </button>
          </section>
        } @else {
          <p class="muted">{{ i18n.t('categories.selectPrompt') }}</p>
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
      /* Announced, never shown: the move already changed the list visually. */
      .announce {
        position: absolute;
        inline-size: 1px;
        block-size: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
      }
      .segmented {
        display: inline-flex;
        margin-block-end: var(--space-4);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .segmented__option {
        padding: var(--space-2) var(--space-4);
        font: inherit;
        font-size: var(--text-sm);
        color: var(--color-text-muted);
        background: var(--color-surface);
        border: none;
        cursor: pointer;
      }
      .segmented__option--on {
        color: var(--color-primary-contrast);
        background: var(--color-primary);
      }
      .create,
      .pane {
        padding: var(--space-4);
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
      }
      .create {
        margin-block-end: var(--space-4);
      }
      .create__title {
        margin: 0 0 var(--space-3);
        font-size: var(--text-lg);
      }
      .create__form {
        display: grid;
        gap: var(--space-3);
      }
      @media (min-width: 700px) {
        .create__form {
          grid-template-columns: 1fr 1fr;
          align-items: end;
        }
        .create__actions {
          grid-column: 1 / -1;
        }
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
      .empty {
        padding: var(--space-5);
        border: 1px dashed var(--color-border);
        border-radius: var(--radius-md);
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
      .tree,
      .keywords__list {
        display: grid;
        gap: var(--space-1);
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .tree__row {
        display: flex;
        align-items: center;
        gap: var(--space-1);
        border-radius: var(--radius-md);
      }
      .tree__row--on {
        background: color-mix(in srgb, var(--color-primary) 12%, transparent);
      }
      .tree__twisty {
        inline-size: 1.5rem;
        padding: 0;
        font: inherit;
        color: var(--color-text-muted);
        background: none;
        border: none;
        cursor: pointer;
      }
      .tree__select {
        display: flex;
        flex: 1;
        align-items: center;
        gap: var(--space-2);
        min-inline-size: 0;
        padding: var(--space-2);
        font: inherit;
        text-align: start;
        color: inherit;
        background: none;
        border: none;
        cursor: pointer;
      }
      .tree__name {
        overflow-wrap: anywhere;
      }
      .tree__badge {
        padding: 0 var(--space-1);
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
      }
      .tree__count {
        margin-inline-start: auto;
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
      }
      .hint {
        margin: var(--space-2) 0 0;
        color: var(--color-text-subtle);
        font-size: var(--text-xs);
      }
      .hint--warn {
        color: var(--color-warning);
      }
      .pane--detail {
        display: grid;
        gap: var(--space-3);
      }
      .detail__title {
        margin: 0;
        font-size: var(--text-lg);
      }
      .detail__form {
        display: grid;
        gap: var(--space-3);
      }
      @media (min-width: 700px) {
        .detail__form {
          grid-template-columns: 1fr 1fr;
        }
        .field--wide {
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
        padding: var(--space-2);
        font: inherit;
        color: var(--color-text);
        background: var(--color-bg);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        min-inline-size: 0;
      }
      .field__input--color {
        padding: var(--space-1);
        block-size: 2.5rem;
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
      .detail__actions,
      .create__actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      .keywords {
        display: grid;
        gap: var(--space-2);
        padding-block-start: var(--space-3);
        border-block-start: 1px solid var(--color-border);
      }
      .keywords__title,
      .danger__title {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: 600;
      }
      .keywords__form {
        display: grid;
        gap: var(--space-2);
      }
      @media (min-width: 700px) {
        .keywords__form {
          grid-template-columns: 1.4fr 0.9fr 1fr auto;
          align-items: end;
        }
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
        inline-size: fit-content;
        padding: var(--space-1) var(--space-2);
        font-size: var(--text-sm);
        border: 1px solid var(--color-border);
        border-radius: 999px;
      }
      /* Exclude reads as a negation, so it is marked with a minus rather than a colour alone. */
      .chip--exclude {
        border-style: dashed;
      }
      .chip__mark {
        font-weight: 700;
      }
      .chip__mode {
        color: var(--color-text-subtle);
        font-size: var(--text-xs);
      }
      .chip__remove {
        padding: 0 var(--space-1);
        font: inherit;
        color: var(--color-text-subtle);
        background: none;
        border: none;
        cursor: pointer;
      }
      .danger {
        display: grid;
        gap: var(--space-2);
        padding-block-start: var(--space-3);
        border-block-start: 1px solid var(--color-border);
      }
    `,
  ],
})
export class CategoriesComponent {
  readonly i18n = inject(I18nService);
  private readonly graphql = inject(GraphqlClient);
  private readonly errors = inject(ErrorMessageService);
  private readonly fb = inject(FormBuilder);

  readonly kind = signal<CategoryKind>('EXPENSE');
  readonly categories = signal<readonly CategoryNode[]>([]);
  readonly selectedId = signal<string | null>(null);
  readonly collapsed = signal<ReadonlySet<string>>(new Set());
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly announcement = signal('');
  readonly usageCount = signal<number | null>(null);
  /** `undefined` = not creating; `null` = creating at top level; a string = creating under that parent. */
  readonly creatingParent = signal<string | null | undefined>(undefined);
  readonly deleteRefused = signal<string | null>(null);
  readonly reassignTo = signal('');

  readonly createForm = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(80)]],
    parentId: [''],
  });

  readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(80)]],
    parentId: [''],
    icon: [''],
    color: ['#888888'],
    aiDescription: [''],
  });

  readonly keywordForm = this.fb.nonNullable.group({
    keyword: ['', [Validators.required, Validators.maxLength(60)]],
    polarity: ['INCLUDE' as KeywordPolarity, [Validators.required]],
    matchMode: ['WORD' as KeywordMatchMode, [Validators.required]],
  });

  private readonly tree = computed(() => buildTree(this.categories()));
  readonly rows = computed(() => visibleRows(this.tree(), this.collapsed()));
  readonly selected = computed(() => {
    const id = this.selectedId();
    return id ? (this.categories().find((node) => node.id === id) ?? null) : null;
  });

  readonly usageText = computed(() => {
    const count = this.usageCount();
    if (count === null) return '';
    return count === 0
      ? this.i18n.t('categories.usageNone')
      : this.i18n.t('categories.usage', { count });
  });

  constructor() {
    void this.load();
  }

  /**
   * Parents a Category may move under: same kind, and not itself or its own descendants.
   *
   * Filtered here so an illegal parent is not offerable at all, which is friendlier than offering it
   * and refusing on save. The server still rejects it (I-11).
   */
  parentOptions(excludeId: string | null): readonly CategoryNode[] {
    const all = this.categories();
    if (!excludeId) return all;
    return all.filter((node) => node.id !== excludeId && moveRefusal(all, excludeId, node.id) === null);
  }

  // -------------------------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------------------------

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const result = await this.graphql.query<{ categories: CategoryNode[] }>(CATEGORIES_QUERY, {
        kind: this.kind(),
      });
      this.categories.set(result.categories);
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.loading.set(false);
    }
  }

  setKind(kind: CategoryKind): void {
    if (this.kind() === kind) return;
    this.kind.set(kind);
    // The two trees are disjoint, so a selection from the other one is not carried across.
    this.selectedId.set(null);
    this.deleteRefused.set(null);
    this.creatingParent.set(undefined);
    void this.load();
  }

  select(id: string): void {
    this.selectedId.set(id);
    this.deleteRefused.set(null);
    this.reassignTo.set('');
    this.announcement.set('');
    const node = this.categories().find((candidate) => candidate.id === id);
    if (node) {
      this.form.patchValue({
        name: node.name,
        parentId: node.parentId ?? '',
        icon: node.icon ?? '',
        color: node.color ?? '#888888',
        aiDescription: node.aiDescription ?? '',
      });
      void this.loadUsage(id);
    }
  }

  private async loadUsage(categoryId: string): Promise<void> {
    this.usageCount.set(null);
    try {
      const result = await this.graphql.query<{ transactions: UsageResult }>(CATEGORY_USAGE, {
        categoryId,
      });
      // Guard against a late response for a category the user has already navigated away from.
      if (this.selectedId() === categoryId) this.usageCount.set(result.transactions.totalCount);
    } catch {
      // A usage count is supporting information; failing to load it must not break the editor.
      if (this.selectedId() === categoryId) this.usageCount.set(null);
    }
  }

  toggleCollapsed(id: string): void {
    this.collapsed.update((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // -------------------------------------------------------------------------------------------
  // Keyboard moves: Alt + arrows (docs/02 §4.7)
  // -------------------------------------------------------------------------------------------

  async onKeydown(event: KeyboardEvent, id: string): Promise<void> {
    if (!event.altKey) return;
    const key = event.key;

    if (key === 'ArrowUp' || key === 'ArrowDown') {
      event.preventDefault();
      await this.reorder(id, key === 'ArrowUp' ? -1 : 1);
      return;
    }

    if (key === 'ArrowRight') {
      event.preventDefault();
      const parentId = nestParentFor(this.categories(), id);
      if (parentId === null) {
        this.announceRefusal('CYCLE');
        return;
      }
      await this.move(id, parentId);
      return;
    }

    if (key === 'ArrowLeft') {
      event.preventDefault();
      const parentId = unnestParentFor(this.categories(), id);
      if (parentId === undefined) return;
      await this.move(id, parentId);
    }
  }

  private async reorder(id: string, direction: -1 | 1): Promise<void> {
    const changes = reorderChanges(this.categories(), id, direction);
    if (changes.length === 0) return;

    try {
      for (const change of changes) {
        await this.graphql.query(UPDATE_CATEGORY, {
          id: change.id,
          sortOrder: change.sortOrder,
        });
      }
      await this.afterMutation(id);
    } catch (error) {
      this.error.set(this.errors.for(error));
    }
  }

  private async move(id: string, parentId: string | null): Promise<void> {
    const refusal = moveRefusal(this.categories(), id, parentId);
    if (refusal) {
      this.announceRefusal(refusal);
      return;
    }

    try {
      await this.graphql.query(UPDATE_CATEGORY, { id, parentId });
      await this.afterMutation(id);
    } catch (error) {
      // The server re-checks I-11, so a refusal here means the client's view of the tree was stale.
      this.error.set(this.errors.for(error));
    }
  }

  private announceRefusal(refusal: 'SELF' | 'CYCLE' | 'TOO_DEEP'): void {
    this.announcement.set(this.i18n.t(`categories.refusal${refusal}` as TranslationKey));
  }

  /** Reload and re-announce where the node ended up, so the move is not silent. */
  private async afterMutation(id: string): Promise<void> {
    await this.load();
    const node = this.categories().find((candidate) => candidate.id === id);
    if (node) {
      this.announcement.set(
        this.i18n.t('categories.moved', { name: node.name, path: node.path.join(' › ') }),
      );
    }
    this.deleteRefused.set(null);
    this.error.set(null);
  }

  // -------------------------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------------------------

  startCreate(parentId: string | null): void {
    this.creatingParent.set(parentId);
    this.createForm.reset({ name: '', parentId: parentId ?? '' });
  }

  cancelCreate(): void {
    this.creatingParent.set(undefined);
  }

  async create(): Promise<void> {
    if (this.createForm.invalid || this.busy()) {
      this.createForm.markAllAsTouched();
      return;
    }
    const { name, parentId } = this.createForm.getRawValue();

    this.busy.set(true);
    this.error.set(null);
    try {
      const result = await this.graphql.query<{ createCategory: { id: string } }>(CREATE_CATEGORY, {
        kind: this.kind(),
        name,
        parentId: parentId === '' ? null : parentId,
      });
      this.creatingParent.set(undefined);
      await this.load();
      this.select(result.createCategory.id);
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
    const { name, parentId, icon, color, aiDescription } = this.form.getRawValue();
    const nextParent = parentId === '' ? null : parentId;

    if (nextParent !== node.parentId) {
      const refusal = moveRefusal(this.categories(), node.id, nextParent);
      if (refusal) {
        this.announceRefusal(refusal);
        return;
      }
    }

    this.busy.set(true);
    this.error.set(null);
    this.deleteRefused.set(null);
    try {
      await this.graphql.query(UPDATE_CATEGORY, {
        id: node.id,
        name,
        parentId: nextParent,
        // Empty means "clear it", not "leave it" — an emptied field the user can see must take effect.
        icon: icon.trim() === '' ? null : icon.trim(),
        color: color === '' ? null : color,
        aiDescription: aiDescription.trim() === '' ? null : aiDescription.trim(),
      });
      await this.afterMutation(node.id);
      this.select(node.id);
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.busy.set(false);
    }
  }

  setReassignTo(event: Event): void {
    this.reassignTo.set((event.target as HTMLSelectElement).value);
  }

  async remove(): Promise<void> {
    const node = this.selected();
    if (!node || this.busy()) return;

    const target = this.reassignTo();
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(DELETE_CATEGORY, {
        id: node.id,
        reassignToId: target === '' ? null : target,
      });
      this.selectedId.set(null);
      this.deleteRefused.set(null);
      this.reassignTo.set('');
      await this.load();
      this.announcement.set('');
    } catch (error) {
      // I-12: the category is still referenced. Surface the server's counts and offer the target
      // picker rather than leaving the user with a refusal and no way forward.
      if (error instanceof GraphQLRequestError && error.code === 'CONFLICT') {
        this.deleteRefused.set(this.errors.for(error));
      } else {
        this.error.set(this.errors.for(error));
      }
    } finally {
      this.busy.set(false);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Keywords
  // -------------------------------------------------------------------------------------------

  async addKeyword(): Promise<void> {
    const node = this.selected();
    if (!node || this.keywordForm.invalid || this.busy()) {
      this.keywordForm.markAllAsTouched();
      return;
    }
    const { keyword, polarity, matchMode } = this.keywordForm.getRawValue();

    this.busy.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(ADD_KEYWORD, {
        categoryId: node.id,
        keyword,
        polarity,
        matchMode,
      });
      this.keywordForm.patchValue({ keyword: '' });
      await this.load();
      this.select(node.id);
      // Re-select cleared the keyword form's other fields, so restore the user's chosen mode.
      this.keywordForm.patchValue({ polarity, matchMode });
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.busy.set(false);
    }
  }

  async removeKeyword(keywordId: string): Promise<void> {
    const node = this.selected();
    if (!node || this.busy()) return;

    this.busy.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(REMOVE_KEYWORD, { keywordId });
      await this.load();
      this.select(node.id);
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.busy.set(false);
    }
  }

  matchModeLabel(matchMode: string): string {
    const key = `categories.match${matchMode}` as TranslationKey;
    return this.i18n.t(key);
  }
}
