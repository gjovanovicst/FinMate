import { Injectable, effect, inject } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';

import { I18nService } from './i18n.service';
import type { TranslationKey } from './translations';

/**
 * The document title, in the reader's language.
 *
 * ## Why this exists
 *
 * Every route's `title` used to be a **Serbian literal** (`'Pregled'`, `'Podešavanja'`, …). Nothing
 * translated it, so the browser tab stayed Serbian after switching to English — the one piece of the
 * interface the language switcher could not reach, and easy to miss because it is never on the page
 * you are looking at.
 *
 * Routes now name a `route.*` translation key and this strategy renders it. `I18nService` is signal
 * based, so an `effect` re-applies the title when the locale changes: switching language renames the
 * tab immediately rather than on the next navigation.
 *
 * ## Why the key is not resolved in `app.routes.ts`
 *
 * A route's `title` is read by Angular **once per navigation**, outside any injection context, so
 * translating it there is not possible. Keeping the key in the route table also makes the mapping
 * greppable and lets `app.routes.spec.ts` assert that every route names a key the primary catalogue
 * actually has, which is the check that would have caught the original defect.
 */
@Injectable({ providedIn: 'root' })
export class LocalizedTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);
  private readonly i18n = inject(I18nService);

  /** The active route's key, so a locale change can re-render the title without a navigation. */
  private activeKey: TranslationKey | null = null;

  constructor() {
    super();
    effect(() => {
      // Reading the locale is what subscribes this effect to the switcher.
      this.i18n.locale();
      this.title.setTitle(
        this.activeKey === null ? this.i18n.t('app.name') : this.i18n.t(this.activeKey),
      );
    });
  }

  override updateTitle(snapshot: RouterStateSnapshot): void {
    // `buildTitle` returns the route's raw `title` — here, a translation key. It is `undefined` for a
    // route that declares none, which falls back to the product name rather than to a blank tab.
    const key = this.buildTitle(snapshot);
    this.activeKey = key === undefined ? null : (key as TranslationKey);
    this.title.setTitle(
      this.activeKey === null ? this.i18n.t('app.name') : this.i18n.t(this.activeKey),
    );
  }
}
