import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { I18nService } from '../../../core/i18n/i18n.service';
import type { LocaleCode } from '../../../core/i18n/locales';
import { IconComponent } from '../icon/icon.component';

/**
 * Language switcher.
 *
 * A native `<select>` rather than a custom menu: it is keyboard-accessible, works with screen
 * readers and on mobile it opens the platform picker, all for free. A custom dropdown would have to
 * reimplement every one of those behaviours.
 *
 * Option labels are written in their own language — a language list you cannot read is useless to
 * the person who needs it.
 *
 * The globe beside it is `fm-icon`, not the `🌐` emoji this shipped with: chrome must not depend on a
 * platform's emoji font, which is the rule ADR-039 applied to the navigation (the emoji rendered as a
 * blank box in this project's own headless captures).
 */
@Component({
  selector: 'fm-language-switcher',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <label class="switcher">
      <span class="fm-visually-hidden">{{ i18n.t('app.language') }}</span>
      <span class="switcher__globe" aria-hidden="true"><fm-icon name="globe" [size]="16" /></span>
      <select
        class="switcher__select"
        [value]="i18n.locale()"
        (change)="onChange($event)"
        [attr.aria-label]="i18n.t('app.language')"
      >
        @for (locale of i18n.available; track locale.code) {
          <option [value]="locale.code" [selected]="locale.code === i18n.locale()">
            {{ locale.nativeLabel }}
          </option>
        }
      </select>
    </label>
  `,
  styles: [
    `
      .switcher {
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
      }
      .switcher__globe {
        display: inline-flex;
        color: var(--color-text-subtle);
        line-height: 0;
      }
      .switcher__select {
        /* Inherits the surrounding type so it sits comfortably in both the sidebar and the
           compact footer without a second set of sizes. */
        font: inherit;
        font-size: var(--text-xs);
        color: var(--color-text-muted);
        background: transparent;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        padding: var(--space-1) var(--space-2);
        cursor: pointer;
      }
      .switcher__select:hover {
        color: var(--color-text);
        border-color: var(--color-text-muted);
      }
    `,
  ],
})
export class LanguageSwitcherComponent {
  readonly i18n = inject(I18nService);

  onChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as LocaleCode;
    this.i18n.setLocale(value);
  }
}
