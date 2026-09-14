/**
 * Translate a typed API error code into a message a person can act on.
 *
 * The API already returns user-safe messages, so this exists for two narrower jobs: giving a
 * *better* message where the generic one is unhelpful (a rate limit needs "try again in a moment",
 * not "too many requests"), and — more importantly — never leaking a raw stack or an internal code
 * into the UI.
 *
 * Serbian (latin) is the source language; the English catalogue lands with the runtime i18n work
 * (ADR-019). Strings live here, not inline in templates, so that extraction is mechanical.
 */
const MESSAGES: Readonly<Record<string, string>> = {
  UNAUTHENTICATED: 'Pogrešan email ili lozinka.',
  FORBIDDEN: 'Nemaš dozvolu za ovu radnju.',
  NOT_FOUND: 'Traženi podatak ne postoji.',
  VALIDATION_FAILED: 'Proveri unete podatke.',
  CONFLICT: 'Već postoji zapis sa tim podacima.',
  RATE_LIMITED: 'Previše pokušaja. Pokušaj ponovo za nekoliko minuta.',
  AI_UNAVAILABLE: 'AI trenutno nije dostupan. Unos i dalje radi ručno.',
  QUOTA_EXCEEDED: 'Potrošio si mesečni limit za AI unos.',
  INTERNAL: 'Došlo je do greške. Pokušaj ponovo.',
};

export function messageForError(error: unknown): string {
  const code = readCode(error);
  if (code && MESSAGES[code]) return MESSAGES[code]!;

  // The server's own message is safe to show (the API never returns internals), so prefer it over
  // a generic string when it exists and is not a bare status code.
  if (error instanceof Error && error.message && !/^Http failure/i.test(error.message)) {
    return error.message;
  }
  return MESSAGES['INTERNAL']!;
}

function readCode(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  // Angular's HttpErrorResponse carries the API's error body.
  if (error && typeof error === 'object' && 'error' in error) {
    const body = (error as { error?: { error?: { code?: unknown } } }).error;
    const code = body?.error?.code;
    if (typeof code === 'string') return code;
  }
  return null;
}
