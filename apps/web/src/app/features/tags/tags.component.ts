import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import { foldForMatching } from '@finmate/nlp';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { GraphqlClient } from '../../core/graphql/graphql.client';
import { I18nService } from '../../core/i18n/i18n.service';
import { IconComponent } from '../../shared/ui/icon/icon.component';

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
  imports: [ReactiveFormsModule, IconComponent],
  template: `
    <div class="fm-page">
    <header class="fm-page__head">
      <div>
        <h1 class="fm-page__title">{{ i18n.t('tags.title') }}</h1>
        <p class="fm-page__sub">{{ i18n.t('tags.subtitle') }}</p>
      </div>
    </header>

    @if (error()) {
      <p class="alert" role="alert">{{ error() }}</p>
    }
    <p class="fm-visually-hidden" aria-live="polite">{{ announcement() }}</p>

    <section class="fm-card">
      <div class="fm-card__head">
        <h2 class="fm-card__title">
          <fm-icon name="tags" [size]="18" />
          {{ i18n.t('tags.addTitle') }}
        </h2>
      </div>
      <form class="create-form" [formGroup]="createForm" (ngSubmit)="create()" novalidate>
        <label class="fm-field">
          <span class="fm-field__label">{{ i18n.t('tags.name') }}</span>
          <input
            class="fm-field__input"
            type="text"
            formControlName="name"
            [placeholder]="i18n.t('tags.namePlaceholder')"
            required
          />
          @if (duplicateWarning(); as warning) {
            <span class="fm-field__hint fm-field__hint--warn">{{ warning }}</span>
          }
        </label>
        <label class="fm-field">
          <span class="fm-field__label">{{ i18n.t('tags.color') }}</span>
          <input class="fm-field__input color-input" type="color" formControlName="color" />
        </label>
        <button class="fm-btn fm-btn--primary" type="submit" [disabled]="busy()">
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
      <div class="list-region">
      <p class="hint">{{ i18n.t('tags.count', { count: tags().length }) }}</p>
      <ul class="list">
        @for (tag of tags(); track tag.id) {
          <li class="fm-card fm-card--tight row">
            @if (editingId() === tag.id) {
              <form class="edit-form" [formGroup]="editForm" (ngSubmit)="save(tag.id)" novalidate>
                <label class="fm-field">
                  <span class="fm-field__label">{{ i18n.t('tags.name') }}</span>
                  <input class="fm-field__input" type="text" formControlName="name" required />
                  @if (duplicateWarning(); as warning) {
                    <span class="fm-field__hint fm-field__hint--warn">{{ warning }}</span>
                  }
                </label>
                <label class="fm-field">
                  <span class="fm-field__label">{{ i18n.t('tags.color') }}</span>
                  <input
                    class="fm-field__input color-input"
                    type="color"
                    formControlName="color"
                  />
                </label>
                <div class="actions">
                  <button class="fm-btn fm-btn--primary" type="submit" [disabled]="busy()">
                    {{ busy() ? i18n.t('tags.saving') : i18n.t('tags.save') }}
                  </button>
                  <button class="fm-btn" type="button" (click)="editingId.set(null)">
                    {{ i18n.t('tags.cancel') }}
                  </button>
                </div>
              </form>
            } @else {
              <span class="row__main">
                <span class="fm-chip fm-chip--static" [style.border-color]="tag.color ?? null">
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
                <button class="fm-btn" type="button" [disabled]="busy()" (click)="startEdit(tag)">
                  {{ i18n.t('tags.edit') }}
                </button>
                <button class="fm-btn fm-btn--danger" type="button" [disabled]="busy()" (click)="remove(tag)">
                  {{ i18n.t('tags.delete') }}
                </button>
              </span>
            }
          </li>
        }
      </ul>
      </div>
    }
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
      /* The box, its label and its hint come from .fm-field*; only the warning ink and the colour
         input's tighter padding are this screen's. */
      .fm-field {
        min-inline-size: 0;
      }
      .fm-field__hint--warn {
        color: var(--color-warning);
      }
      .color-input {
        padding: var(--space-1);
      }
      /* The count and the rows read as one block, so they share a tighter gap than the page's. */
      .list-region {
        display: grid;
        gap: var(--space-3);
      }
      .list {
        display: grid;
        gap: var(--space-3);
        margin: 0;
        padding: 0;
        list-style: none;
      }
      /* Each tag is a card (--tight); the row layout is this screen's, so it overrides the card's
         own grid. */
      .row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
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
      .empty {
        padding: var(--space-5);
        border: 1px dashed var(--color-border);
        border-radius: var(--radius-lg);
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
    const folded = foldForMatching(name);
    const clash = this.tags().some(
      (tag) => tag.id !== editing && foldForMatching(tag.name) === folded,
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
