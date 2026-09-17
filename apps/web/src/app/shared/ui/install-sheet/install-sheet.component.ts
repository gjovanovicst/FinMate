import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';

import { I18nService } from '../../../core/i18n/i18n.service';
import type { TranslationKey } from '../../../core/i18n/translations';
import type { InstallPromptKind } from '../../../core/install/install.view';

/**
 * The Add-to-Home-Screen sheet — docs/07 §4.7, task 4.3.2b.
 *
 * §4.7's table is two different sheets wearing one name, so this is one component with two bodies:
 *
 * - **Chromium** has a real API, so the sheet carries a real *Instaliraj* button that calls
 *   `beforeinstallprompt`'s `prompt()`. The browser owns the dialog; we own the invitation.
 * - **iOS Safari** has no API at all, so the sheet is **instructions** — Share → *Add to Home Screen* —
 *   and its only verb is *understood*. There is no button that could install anything, and inventing
 *   one that claims to have done it is the failure mode this branch exists to avoid.
 *
 * ## It is not modal, and it does not steal focus
 *
 * docs/07 §7.4 asks a sheet to move focus to its first control and trap it. That row is about a sheet
 * the **user opened**, and this one is the opposite: it appears on its own after a capture the person
 * just confirmed, and §4.7's prose is explicit that *"never block the app behind install"*. So it is a
 * labelled `region` in the content flow — after the update line, above the screen — with real buttons,
 * no trap, no scroll lock and no focus move. The difference from §7.4 is deliberate and recorded in
 * docs/02 §2; what §7.5 asks for (readable, with its steps in an ordered list, as a small panel rather
 * than a full page) is honoured.
 *
 * @module apps/web/src/app/shared/ui/install-sheet
 */
@Component({
  selector: 'fm-install-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="sheet" role="region" [attr.aria-labelledby]="titleId">
      <h2 class="sheet__title" [id]="titleId">{{ i18n.t(titleKey()) }}</h2>
      <p class="muted">{{ i18n.t(whyKey()) }}</p>

      @if (kind() === 'IOS_INSTRUCTIONS') {
        <!-- The three steps Safari actually requires, in order. A screenshot would say the same thing
             with more bytes and no translation. -->
        <ol class="steps">
          <li>{{ i18n.t('install.ios.step1') }}</li>
          <li>{{ i18n.t('install.ios.step2') }}</li>
          <li>{{ i18n.t('install.ios.step3') }}</li>
        </ol>
        <p class="muted small">{{ i18n.t('install.ios.after') }}</p>
      } @else {
        <p class="muted small">{{ i18n.t('install.native.note') }}</p>
      }

      @if (failed()) {
        <!-- The browser refused to open its prompt. Named, with the way out, instead of a sheet that
             closes itself and leaves the person believing something happened. -->
        <p class="alert" role="alert">{{ i18n.t('install.failed') }}</p>
      }

      <div class="actions">
        @if (kind() === 'NATIVE') {
          <button type="button" class="btn btn--primary" [disabled]="busy()" (click)="install.emit()">
            {{ busy() ? i18n.t('install.working') : i18n.t('install.accept') }}
          </button>
          <button type="button" class="link" [disabled]="busy()" (click)="dismiss.emit()">
            {{ i18n.t('install.dismiss') }}
          </button>
        } @else {
          <button type="button" class="btn btn--primary" (click)="dismiss.emit()">
            {{ i18n.t('install.understood') }}
          </button>
        }
      </div>
    </section>
  `,
  styles: `
    .sheet {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      margin-block-end: var(--space-4);
      padding: 0.75rem 1rem;
      border: 1px solid var(--color-primary);
      border-radius: 0.5rem;
      background: var(--color-surface-raised);
    }
    .sheet__title {
      font-size: 1.1rem;
      margin: 0;
    }
    p {
      margin: 0;
    }
    .muted {
      color: var(--color-text-muted);
    }
    .small {
      font-size: 0.85rem;
    }
    .steps {
      margin: 0;
      padding-inline-start: 1.25rem;
      display: grid;
      gap: 0.25rem;
    }
    .alert {
      color: var(--color-danger);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: center;
      margin-block-start: 0.25rem;
    }
    /* The two verbs the rest of the app uses (capture, consent): a filled primary and a plain link. */
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
    .link {
      background: none;
      border: none;
      color: var(--color-primary-text);
      font: inherit;
      text-decoration: underline;
      cursor: pointer;
      padding: var(--space-2);
    }
    .link:disabled {
      opacity: 0.6;
      cursor: default;
    }
  `,
})
export class InstallSheetComponent {
  readonly i18n = inject(I18nService);

  readonly kind = input.required<InstallPromptKind>();
  readonly busy = input(false);
  readonly failed = input(false);

  /** *Install* — run the browser's own prompt. Chromium only; the iOS branch has no such output. */
  readonly install = output<void>();
  /** *Not now* / *Got it* — close, and start §4.7's 30-day suppression. */
  readonly dismiss = output<void>();

  /** One sheet exists at a time, so a constant id labels the region by its own heading. */
  readonly titleId = 'install-sheet-title';

  readonly titleKey = computed<TranslationKey>(() =>
    this.kind() === 'IOS_INSTRUCTIONS' ? 'install.title.ios' : 'install.title.native',
  );

  readonly whyKey = computed<TranslationKey>(() =>
    this.kind() === 'IOS_INSTRUCTIONS' ? 'install.why.ios' : 'install.why.native',
  );
}
