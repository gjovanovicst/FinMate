/** Anything carrying a list of aliases. Merchants, Counterparties and (later) anything else. */
export interface Aliased {
  readonly aliases: readonly { readonly alias: string }[];
}

/**
 * The alias set a merge would produce: both sides, de-duplicated, sorted.
 *
 * Shared between Merchants and Counterparties because the server's merge is the same union for both,
 * and the preview shown before committing has to be the list that lands. One definition means the two
 * previews cannot disagree about what a merge does.
 *
 * The client computes this only for the *preview*; the server recomputes on write rather than
 * trusting it.
 */
export function aliasUnion(
  source: Aliased | null,
  target: Aliased | null,
): readonly string[] {
  if (!source || !target) return [];
  const all = [...target.aliases, ...source.aliases].map((entry) => entry.alias);
  return [...new Set(all)].sort((a, b) => a.localeCompare(b));
}
