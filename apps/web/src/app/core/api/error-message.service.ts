import { Injectable, inject } from '@angular/core';

import { I18nService } from '../i18n/i18n.service';
import type { TranslationKey } from '../i18n/translations';

/**
 * Turn a typed API error into a message in the active language.
 *
 * The API returns a stable `code` (docs/06 §10) plus a safe English `message`. The client localises
 * by code, which keeps the backend locale-agnostic: adding a language is a client data change and
 * never touches the server, and the API has no idea who is reading.
 *
 * The server's own message is the last resort — the API never returns internals, so showing it is
 * safe, and a code we do not yet have wording for degrades to something truthful rather than blank.
 */
@Injectable({ providedIn: 'root' })
export class ErrorMessageService {
  private readonly i18n = inject(I18nService);

  for(error: unknown): string {
    const code = readCode(error);
    const key = code ? (`error.${code}` as TranslationKey) : undefined;

    // `t` falls back to the key itself when it is unknown, so a new server code shows as
    // "error.SOME_NEW_CODE" — visible in the UI and obvious in a bug report, rather than invisible.
    if (key && this.i18n.t(key) !== key) return this.i18n.t(key);

    const serverMessage = readServerMessage(error);
    return serverMessage ?? this.i18n.t('error.INTERNAL');
  }
}

function readCode(error: unknown): string | null {
  if (error && typeof error === 'object') {
    // GraphQLRequestError exposes `code` directly.
    if ('code' in error && typeof (error as { code?: unknown }).code === 'string') {
      return (error as { code: string }).code;
    }
    // Angular's HttpErrorResponse nests the API body: { error: { code, message } }.
    const body = (error as { error?: { error?: { code?: unknown } } }).error;
    const nested = body?.error?.code;
    if (typeof nested === 'string') return nested;
  }
  return null;
}

function readServerMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  // Angular prefixes its own transport failures with "Http failure…", which is not user-facing.
  if (/^Http failure/i.test(error.message)) return null;
  return error.message.length > 0 ? error.message : null;
}
