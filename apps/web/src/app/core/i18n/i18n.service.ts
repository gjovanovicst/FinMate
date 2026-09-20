import { DOCUMENT } from '@angular/common';
import { Injectable, computed, effect, inject, signal } from '@angular/core';

import {
  DEFAULT_LOCALE,
  findLocale,
  LOCALE_STORAGE_KEY,
  LOCALES,
  type LocaleCode,
  type LocaleDefinition,
  type TextDirection,
} from './locales';
import { en, loadCatalogue, type Catalogue, type TranslationKey } from './translations';

export interface TranslateParams {
  readonly [name: string]: string | number;
}

/**
 * Runtime internationalisation (ADR-019, opened up by ADR-044).
 *
 * Design notes that matter:
 *
 *  - **Signals, not a pipe.** `t()` reads the catalogue signal, so a template that calls
 *    `i18n.t('key')` re-renders when the locale changes, with `OnPush` and no impure pipe. An impure
 *    pipe would re-run on every change-detection cycle.
 *  - **No build-time locale bundles.** Switching language is a signal write plus, at most, one chunk
 *    fetch: no reload, no rebuild.
 *  - **English is primary and the fallback.** A missing key (which the types prevent) would render the
 *    English string, then the key itself, so the failure is visible rather than blank.
 *  - **Server messages are not localised server-side.** The API returns a stable code; the client owns
 *    the wording. Adding a language therefore never touches the backend.
 *  - **The catalogue is loaded before the first render.** `init()` is awaited by an app initializer, so
 *    a Serbian or German reader never sees a flash of English. Lazy chunks (ADR-044) are what make the
 *    language count free of the shell budget; awaiting `init()` is what makes them invisible.
 */
@Injectable({ providedIn: 'root' })
export class I18nService {
  private readonly document = inject(DOCUMENT);

  private readonly localeSignal = signal<LocaleCode>(this.resolveInitialLocale());

  /**
   * The resident catalogue. Starts as English — a readable fallback rather than `null` — and is
   * replaced by {@link init} or {@link setLocale} once the locale's chunk is in.
   */
  private readonly catalogueSignal = signal<Catalogue>(en);

  readonly locale = this.localeSignal.asReadonly();
  readonly available = LOCALES;

  /** The active locale's definition: BCP-47 tag, labels, direction. */
  readonly definition = computed<LocaleDefinition>(
    () => findLocale(this.localeSignal()) ?? LOCALES[0]!,
  );

  /** BCP-47 tag for `Intl` formatting — numbers, currency and dates follow the language. */
  readonly tag = computed(() => this.definition().tag);

  /** Writing direction, for `documentElement.dir`. */
  readonly direction = computed<TextDirection>(() => this.definition().direction);

  constructor() {
    // Keep the document honest: `<html lang>` drives screen-reader pronunciation and hyphenation, and
    // `dir` drives the entire layout for an RTL locale. A stale value is a real accessibility defect,
    // not a cosmetic detail.
    effect(() => {
      const definition = this.definition();
      this.document.documentElement.lang = definition.tag;
      // ADR-044: this used to be the literal `'ltr'`, which meant the one locale that most needs the
      // attribute — Arabic — could never set it. It now follows the locale.
      this.document.documentElement.dir = definition.direction;
    });
  }

  /**
   * Load the active locale's catalogue. Awaited by an app initializer **before the application
   * renders**, which is what turns a lazy chunk into an invisible one.
   *
   * It never rejects: an unreachable catalogue leaves English in place rather than failing bootstrap.
   */
  async init(): Promise<void> {
    await this.activate(this.localeSignal());
  }

  /** Translate a key, interpolating `{name}` placeholders. */
  t(key: TranslationKey, params?: TranslateParams): string {
    const catalogue = this.catalogueSignal() as Partial<Record<TranslationKey, string>>;
    const template = catalogue[key] ?? en[key] ?? key;
    return params ? interpolate(template, params) : template;
  }

  /**
   * Switch language.
   *
   * Asynchronous since ADR-044 — the catalogue is a lazy chunk — but the switch itself is still a
   * signal write with no reload. Persistence happens only after the catalogue is resident, so a reload
   * during a failed switch cannot strand the reader in a language this build cannot render.
   */
  async setLocale(code: LocaleCode): Promise<void> {
    await this.activate(code);
    try {
      this.document.defaultView?.localStorage.setItem(LOCALE_STORAGE_KEY, code);
    } catch {
      // Storage can be unavailable (private mode, blocked cookies). The session still switches;
      // only the memory of it is lost, which is not worth failing a page load over.
    }
  }

  /**
   * Make `code` the active locale, loading its catalogue first.
   *
   * The catalogue is written **before** the locale so the two cannot disagree for a frame: `t()` reads
   * only the catalogue, so an old catalogue under a new `<html lang>` — which is how a page ends up
   * announcing German text in Serbian — is not reachable.
   */
  private async activate(code: LocaleCode): Promise<void> {
    const catalogue = (await loadCatalogue(code)) ?? en;
    this.catalogueSignal.set(catalogue);
    this.localeSignal.set(code);
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
      // A stored value that is no longer shipped resolves to `undefined` rather than being trusted:
      // `findLocale` is the only thing that decides what a code means.
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
