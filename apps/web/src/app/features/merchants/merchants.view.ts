import { normaliseClientSide } from './normalise';

export interface MerchantAliasNode {
  readonly id: string;
  readonly alias: string;
}

/** A Merchant as the editor needs it. Mirrors `MerchantModel` (docs/06 §5.0). */
export interface MerchantNode {
  readonly id: string;
  readonly name: string;
  readonly defaultCategoryId: string | null;
  readonly defaultCategoryPath: readonly string[] | null;
  readonly aiHint: string | null;
  readonly isGlobal: boolean;
  readonly isOwnedByHousehold: boolean;
  readonly aliases: readonly MerchantAliasNode[];
  readonly transactionCount: number;
}

/**
 * The alias set a merge would produce.
 *
 * Mirrors the server's union exactly (fold, de-duplicate, sort), so the list shown before committing
 * is the list that lands. It is computed here only for the *preview*: the server remains the one that
 * writes, and it recomputes rather than trusting this.
 */
export function aliasUnion(
  source: MerchantNode | null,
  target: MerchantNode | null,
): readonly string[] {
  if (!source || !target) return [];
  const all = [...target.aliases, ...source.aliases].map((alias) => alias.alias);
  return [...new Set(all)].sort((a, b) => a.localeCompare(b));
}

export type MergeRefusal = 'SAME' | 'SHIPPED_SOURCE';

/**
 * Why a merge would be refused, or `null` when it is fine.
 *
 * A shipped source cannot be merged away — it is platform content, and the server refuses it too.
 * A shipped *target* is fine: the server copies it on write, which is how a Household ends up owning
 * its own "Lidl" carrying the union.
 */
export function mergeRefusal(source: MerchantNode | null, target: MerchantNode | null): MergeRefusal | null {
  if (!source || !target) return null;
  if (source.id === target.id) return 'SAME';
  if (source.isGlobal) return 'SHIPPED_SOURCE';
  return null;
}

/** Whether a Merchant can be deleted outright: never a shipped one, never one still referenced. */
export function deleteRefusal(merchant: MerchantNode | null): 'SHIPPED' | 'IN_USE' | null {
  if (!merchant) return null;
  if (merchant.isGlobal) return 'SHIPPED';
  if (merchant.transactionCount > 0) return 'IN_USE';
  return null;
}

/**
 * Whether two strings name the same Merchant.
 *
 * Used to warn before a duplicate is attempted. It must fold the same way the server does, or the
 * warning and the `CONFLICT` disagree — and a user who is told a name is free and then refused will
 * believe the app is broken.
 */
export function sameMerchantName(a: string, b: string): boolean {
  return normaliseClientSide(a) === normaliseClientSide(b);
}
