import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { I18nService } from '../../../core/i18n/i18n.service';
import { ThemeService } from '../../../core/theme/theme.service';
import { IconComponent } from '../icon/icon.component';

/**
 * The one-button theme control (ADR-039).
 *
 * **The glyph shows the current theme; the label names the action.** That is what the mockups do — the
 * dark reference carries a moon and the light one a sun — and it is also the only reading that survives
 * being heard rather than seen: "Switch to light theme" is unambiguous, whereas an accessible name of
 * "Light theme" leaves a listener unable to tell whether it is a state or a button.
 *
 * It toggles between the two themes rather than cycling through three. Choosing system explicitly
 * belongs on /settings, where three options can carry their own labels; a button whose third press
 * means "follow the operating system" is a puzzle, not a control.
 */
@Component({
  selector: 'fm-theme-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <button
      type="button"
      class="fm-icon-btn"
      (click)="theme.toggle()"
      [attr.aria-label]="label()"
      [attr.title]="label()"
    >
      <fm-icon [name]="icon()" [size]="20" />
    </button>
  `,
})
export class ThemeToggleComponent {
  readonly theme = inject(ThemeService);
  private readonly i18n = inject(I18nService);

  /** The theme that is painted now, which is what the glyph shows. */
  protected readonly icon = computed(() => (this.theme.resolved() === 'dark' ? 'moon' : 'sun'));

  protected readonly label = computed(() =>
    this.theme.resolved() === 'dark'
      ? this.i18n.t('theme.switchToLight')
      : this.i18n.t('theme.switchToDark'),
  );
}
