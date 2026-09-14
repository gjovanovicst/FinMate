import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { GraphqlClient } from '../../core/graphql/graphql.client';
import { I18nService } from '../../core/i18n/i18n.service';
import { normaliseClientSide } from '../../shared/normalise';

interface TagNode {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
  readonly transactionCount: number;
}

const TAGS_QUERY = /* GraphQL */ `
  query Tags {
    tags {
      id
      name
      color
      transactionCount
    }
  }
`;

const CREATE_TAG = /* GraphQL */ `
  mutation CreateTag($name: String!, $color: String) {
    createTag(name: $name, color: $color) {
      id
      name
      color
      transactionCount
    }
  }
`;

const UPDATE_TAG = /* GraphQL */ `
  mutation UpdateTag($id: ID!, $name: String, $color: String) {
    updateTag(id: $id, name: $name, color: $color) {
      id
      name
      color
      transactionCount
    }
  }
`;

const DELETE_TAG = /* GraphQL */ `
  mutation DeleteTag($id: ID!) {
    deleteTag(id: $id)
  }
`;

/**
 * Tags — labels that cut across categories (F-12; docs/02 §4.9).
 *
 * This is the one taxonomy screen with no merge, and the delete behaves differently from every other
 * entity here. Both follow from what a Tag is: a label. There is nothing to reassign `#vanredno` *to*,
 * so `deleteTag` removes the assignments instead of refusing — and the screen says so **before** the
 * confirm, because the user is about to lose the label from Transactions they may not be looking at.
 *
 * Duplicate names are caught before the round trip the same way as Merchants and Counterparties: the
 * API folds for uniqueness, so a client that does not fold would offer a name the server refuses.
 */
@Component({
  selector: 'fm-tags',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule],
  template: `
    <header class="head">
      <div>
        <h1 class="head__title">{{ i18n.t('tags.title') }}</h1>
        <p class="head__sub">{{ i18n.t('tags.subtitle') }}</p>
      </div>
    </header>

    @if (error()) {
      <p class="alert" role="alert">{{ error() }}</p>
    }
    <p class="announce" aria-live="polite">{{ announcement() }}</p>

    <section class="panel">
      <h2 class="panel__title">{{ i18n.t('tags.addTitle') }}</h2>
      <form class="create-form" [formGroup]="createForm" (ngSubmit)="create()" novalidate>
        <label class="field">
          <span class="field__label">{{ i18n.t('tags.name') }}</span>
          <input
            class="field__input"
            type="text"
            formControlName="name"
            [placeholder]="i18n.t('tags.namePlaceholder')"
            required
          />
          @if (duplicateWarning(); as warning) {
            <span class="field__hint field__hint--warn">{{ warning }}</span>
          }
        </label>
        <label class="field field--color">
          <span class="field__label">{{ i18n.t('tags.color') }}</span>
          <input class="field__input field__input--color" type="color" formControlName="color" />
        </label>
        <button class="btn btn--primary" type="submit" [disabled]="busy()">
          {{ busy() ? i18n.t('tags.creating') : i18n.t('tags.create') }}
        </button>
      </form>
      <p class="hint">{{ i18n.t('tags.cascadeWarning') }}</p>
    </section>

    @if (loading()) {
      <p class="muted">{{ i18n.t('accounts.loading') }}</p>
    } @else if (tags().length === 0) {
      <div class="empty">
        <p class="empty__title">{{ i18n.t('tags.empty') }}</p>
        <p class="empty__body">{{ i18n.t('tags.emptyBody') }}</p>
      </div>
    } @else {
      <p class="hint">{{ i18n.t('tags.count', { count: tags().length }) }}</p>
      <ul class="list">
        @for (tag of tags(); track tag.id) {
          <li class="row">
            @if (editingId() === tag.id) {
              <form class="edit-form" [formGroup]="editForm" (ngSubmit)="save(tag.id)" novalidate>
                <label class="field">
                  <span class="field__label">{{ i18n.t('tags.name') }}</span>
                  <input class="field__input" type="text" formControlName="name" required />
                  @if (duplicateWarning(); as warning) {
                    <span class="field__hint field__hint--warn">{{ warning }}</span>
                  }
                </label>
                <label class="field field--color">
                  <span class="field__label">{{ i18n.t('tags.color') }}</span>
                  <input
                    class="field__input field__input--color"
                    type="color"
                    formControlName="color"
                  />
                </label>
                <div class="actions">
                  <button class="btn btn--primary" type="submit" [disabled]="busy()">
                    {{ busy() ? i18n.t('tags.saving') : i18n.t('tags.save') }}
                  </button>
                  <button class="btn" type="button" (click)="editingId.set(null)">
                    {{ i18n.t('tags.cancel') }}
                  </button>
                </div>
              </form>
            } @else {
              <span class="row__main">
                <span class="chip" [style.border-color]="tag.color ?? null">
                  <span
                    class="chip__swatch"
                    aria-hidden="true"
                    [style.background]="tag.color ?? 'transparent'"
                  ></span>
                  <span class="chip__word">{{ tag.name }}</span>
                </span>
                <span class="row__count">
                  {{
                    tag.transactionCount > 0
                      ? i18n.t('tags.usage', { count: tag.transactionCount })
                      : i18n.t('tags.usageNone')
                  }}
                </span>
              </span>
              <span class="actions">
                <button class="btn" type="button" [disabled]="busy()" (click)="startEdit(tag)">
                  {{ i18n.t('tags.edit') }}
                </button>
                <button class="btn btn--danger" type="button" [disabled]="busy()" (click)="remove(tag)">
                  {{ i18n.t('tags.delete') }}
                </button>
              </span>
            }
          </li>
        }
      </ul>
    }
  `,
  styles: [
    `
      .head {
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
      }
      .create-form,
      .edit-form {
        display: grid;
        gap: var(--space-3);
      }
      /* The colour swatch is a narrow control, so it takes its own column rather than half the row. */
      @media (min-width: 700px) {
        .create-form,
        .edit-form {
          grid-template-columns: 1fr 8rem auto;
          align-items: end;
        }
        .edit-form .actions {
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
      .field__input--color {
        padding: var(--space-1);
        block-size: 2.5rem;
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
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        padding: var(--space-3);
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
      }
      .row__main {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-3);
        min-inline-size: 0;
      }
      .row__count {
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        max-inline-size: 100%;
        padding: var(--space-1) var(--space-3);
        font-size: var(--text-sm);
        border: 1px solid var(--color-border);
        border-radius: 999px;
      }
      /* The swatch repeats the colour rather than relying on the border alone: a thin coloured
         outline is not distinguishable enough at chip size to be the only carrier of meaning. */
      .chip__swatch {
        inline-size: 0.7rem;
        block-size: 0.7rem;
        border: 1px solid var(--color-border);
        border-radius: 50%;
      }
      .chip__word {
        overflow-wrap: anywhere;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      .btn {
        padding: var(--space-2) var(--space-3);
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
      .empty {
        padding: var(--space-5);
        border: 1px dashed var(--color-border);
        border-radius: var(--radius-lg);
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
      .hint {
        margin: 0;
        color: var(--color-text-subtle);
        font-size: var(--text-xs);
      }
    `,
  ],
})
export class TagsComponent {
  readonly i18n = inject(I18nService);
  private readonly graphql = inject(GraphqlClient);
  private readonly errors = inject(ErrorMessageService);
  private readonly fb = inject(FormBuilder);

  readonly tags = signal<readonly TagNode[]>([]);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly announcement = signal('');
  readonly editingId = signal<string | null>(null);

  readonly createForm = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(60)]],
    color: ['#888888'],
  });

  readonly editForm = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(60)]],
    color: ['#888888'],
  });

  /**
   * Warn about a duplicate before the request.
   *
   * Checked against the create form or the edit form depending on which is open, and excluding the
   * tag being renamed — otherwise every rename would warn about itself.
   */
  readonly duplicateWarning = computed(() => {
    const editing = this.editingId();
    const name = editing ? this.editForm.controls.name.value : this.createForm.controls.name.value;
    if (!name.trim()) return null;
    const folded = normaliseClientSide(name);
    const clash = this.tags().some(
      (tag) => tag.id !== editing && normaliseClientSide(tag.name) === folded,
    );
    return clash ? this.i18n.t('tags.duplicateName') : null;
  });

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const result = await this.graphql.query<{ tags: TagNode[] }>(TAGS_QUERY);
      this.tags.set(result.tags);
      const editing = this.editingId();
      if (editing && !result.tags.some((tag) => tag.id === editing)) this.editingId.set(null);
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.loading.set(false);
    }
  }

  startEdit(tag: TagNode): void {
    this.editingId.set(tag.id);
    this.editForm.patchValue({ name: tag.name, color: tag.color ?? '#888888' });
  }

  async create(): Promise<void> {
    if (this.createForm.invalid || this.busy()) {
      this.createForm.markAllAsTouched();
      return;
    }
    const { name, color } = this.createForm.getRawValue();

    this.busy.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(CREATE_TAG, { name, color });
      this.createForm.patchValue({ name: '' });
      await this.load();
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.busy.set(false);
    }
  }

  async save(id: string): Promise<void> {
    if (this.editForm.invalid || this.busy()) {
      this.editForm.markAllAsTouched();
      return;
    }
    const { name, color } = this.editForm.getRawValue();

    this.busy.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(UPDATE_TAG, { id, name, color });
      this.editingId.set(null);
      await this.load();
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.busy.set(false);
    }
  }

  async remove(tag: TagNode): Promise<void> {
    if (this.busy()) return;
    if (!globalThis.confirm(this.i18n.t('tags.deleteConfirm'))) return;

    this.busy.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(DELETE_TAG, { id: tag.id });
      await this.load();
      // Worth saying out loud: the label also came off any Transaction carrying it.
      this.announcement.set(this.i18n.t('tags.cascadeWarning'));
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.busy.set(false);
    }
  }
}
