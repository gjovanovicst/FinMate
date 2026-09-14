import { DOCUMENT } from '@angular/common';
import { Injectable, computed, effect, inject, signal } from '@angular/core';

import {
  DEFAULT_LOCALE,
  findLocale,
  LOCALE_STORAGE_KEY,
  LOCALES,
  type LocaleCode,
  type LocaleDefinition,
} from './locales';
import { CATALOGUES, en, type TranslationKey } from './translations';

export interface TranslateParams {
  readonly [name: string]: string | number;
}

/**
 * Runtime internationalisation (ADR-019).
 *
 * Design notes that matter:
 *
 *  - **Signals, not a pipe.** `t()` reads the locale signal, so a template that calls
 *    `i18n.t('key')` re-renders when the locale changes, with `OnPush` and no impure pipe. An
 *    impure pipe would re-run on every change-detection cycle.
 *  - **No build-time locale bundles.** Switching language is a signal write: no reload, no rebuild.
 *  - **English is primary and the fallback.** A missing key (which the types prevent) would render
 *    the English string, then the key itself, so the failure is visible rather than blank.
 *  - **Server messages are not localised server-side.** The API returns a stable code; the client
 *    owns the wording. Adding a language therefore never touches the backend.
 */
@Injectable({ providedIn: 'root' })
export class I18nService {
  private readonly document = inject(DOCUMENT);

  private readonly localeSignal = signal<LocaleCode>(this.resolveInitialLocale());

  readonly locale = this.localeSignal.asReadonly();
  readonly available = LOCALES;

  /** The active locale's definition: BCP-47 tag, labels. */
  readonly definition = computed<LocaleDefinition>(
    () => findLocale(this.localeSignal()) ?? LOCALES[0]!,
  );

  /** BCP-47 tag for `Intl` formatting — numbers, currency and dates follow the language. */
  readonly tag = computed(() => this.definition().tag);

  constructor() {
    // Keep the document honest: `<html lang>` drives screen-reader pronunciation and hyphenation,
    // so a stale value is a real accessibility defect, not a cosmetic detail.
    effect(() => {
      const definition = this.definition();
      this.document.documentElement.lang = definition.tag;
      // All three supported locales are left-to-right; `dir` is set explicitly so a future RTL
      // locale cannot be added without noticing this line (ADR-019).
      this.document.documentElement.dir = 'ltr';
    });
  }

  /** Translate a key, interpolating `{name}` placeholders. */
  t(key: TranslationKey, params?: TranslateParams): string {
    const catalogue = CATALOGUES[this.localeSignal()] as Partial<Record<TranslationKey, string>>;
    const template = catalogue[key] ?? en[key] ?? key;
    return params ? interpolate(template, params) : template;
  }

  /** Switch language. Persisted so the choice survives a reload. */
  setLocale(code: LocaleCode): void {
    this.localeSignal.set(code);
    try {
      this.document.defaultView?.localStorage.setItem(LOCALE_STORAGE_KEY, code);
    } catch {
      // Storage can be unavailable (private mode, blocked cookies). The session still switches;
      // only the memory of it is lost, which is not worth failing a page load over.
    }
  }

  /**
   * Resolution order: a previously chosen locale, then the browser's preference, then English.
   *
   * A stored choice wins over the browser because it is an explicit decision by this person —
   * re-deriving from `navigator.language` on every load would silently undo it.
   */
  private resolveInitialLocale(): LocaleCode {
    const stored = this.readStoredLocale();
    if (stored) return stored;

    const preferred = this.document.defaultView?.navigator.languages ?? [];
    for (const candidate of preferred) {
      const match = findLocale(candidate);
      if (match) return match.code;
    }
    return DEFAULT_LOCALE;
  }

  private readStoredLocale(): LocaleCode | null {
    try {
      const stored = this.document.defaultView?.localStorage.getItem(LOCALE_STORAGE_KEY);
      return stored ? (findLocale(stored)?.code ?? null) : null;
    } catch {
      return null;
    }
  }
}

/**
 * Replace `{name}` placeholders in one pass.
 *
 * A single pass matters: a translated value that itself contains braces (a JSON example in a hint,
 * say) must not be re-scanned and corrupted.
 */
export function interpolate(template: string, params: TranslateParams): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}
