import { Injectable, inject } from '@angular/core';

import { I18nService } from '../i18n/i18n.service';
import type { TranslationKey } from '../i18n/translations';
import { isUnreachable } from './unreachable';

/**
 * Turn a typed API error into a message in the active language.
 *
 * The API returns a stable `code` (docs/06 §10) plus a safe English `message`. The client localises
 * by code, which keeps the backend locale-agnostic: adding a language is a client data change and
 * never touches the server, and the API has no idea who is reading.
 *
 * The server's own message is the last resort — the API never returns internals, so showing it is
 * safe, and a code we do not yet have wording for degrades to something truthful rather than blank.
 *
 * ## A transport failure is not an internal error
 *
 * When nothing is listening there is no API `code` to localise: Angular reports `status: 0` for a
 * request that never arrived, and a proxy with no upstream answers `502`/`503`/`504`. All of those
 * used to fall through to *"Something went wrong. Please try again."* — untrue, because retrying
 * cannot help a server that is not running, and useless to the person reading it, because the one
 * thing worth checking is the connection. They get their own message now: the message a developer
 * hitting an unstarted dev API needs, and the honest one for a real outage.
 */
@Injectable({ providedIn: 'root' })
export class ErrorMessageService {
  private readonly i18n = inject(I18nService);

  for(error: unknown): string {
    // Before any code lookup: a request that never reached the API has no code. The rule lives in
    // `unreachable.ts`, because the auth store and the offline shell ask the same question (ADR-033).
    if (isUnreachable(error)) return this.i18n.t('error.UNREACHABLE');

    const code = apiErrorCode(error);
    const key = code ? (`error.${code}` as TranslationKey) : undefined;

    // `t` falls back to the key itself when it is unknown, so a new server code shows as
    // "error.SOME_NEW_CODE" — visible in the UI and obvious in a bug report, rather than invisible.
    if (key && this.i18n.t(key) !== key) return this.i18n.t(key);

    const serverMessage = readServerMessage(error);
    return serverMessage ?? this.i18n.t('error.INTERNAL');
  }
}

/**
 * The API's stable error `code`, read structurally.
 *
 * Exported because a screen sometimes has to branch on the code rather than render a sentence for it —
 * `/reset-password` treats `VALIDATION_FAILED` as "this link is dead" (task 5.8). One reader, so the two
 * places cannot disagree about where a code lives (docs/15).
 */
export function apiErrorCode(error: unknown): string | null {
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
