/**
 * Fold text for comparison, mirroring the server's `common/text/normalise`.
 *
 * **A deliberate second implementation, and a temporary one.** The canonical version belongs in
 * `packages/nlp` so both sides import it (docs/05 §5.3), but that package is still a stub owned by
 * Phase 2 task 2.1.1. Until it exists, the choice is between duplicating twelve lines here or letting
 * the client guess — and a client that guesses differently from the server shows a duplicate-name
 * warning that the API then contradicts.
 *
 * The browser needs it for one thing: telling the user *before* they submit that a name is already
 * taken, rather than after a round trip. Shared rather than per-feature, because Merchants,
 * Counterparties and Tags all refuse a folded duplicate and three copies would drift.
 *
 * `đ` needs its own rule because it has no canonical decomposition, so the combining-mark strip that
 * folds č/ć/š/ž leaves it intact.
 */
export function normaliseClientSide(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('sr-Latn-RS')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ');
}
