import { normaliseClientSide } from '../../shared/normalise';

export type CounterpartyType = 'PERSON' | 'COMPANY' | 'GOVERNMENT' | 'OTHER';

export interface CounterpartyAliasNode {
  readonly id: string;
  readonly alias: string;
}

/** A Counterparty as the screen needs it. Mirrors `CounterpartyModel` (docs/06 §5.0.1). */
export interface CounterpartyNode {
  readonly id: string;
  readonly name: string;
  readonly type: CounterpartyType;
  readonly defaultCategoryId: string | null;
  readonly defaultCategoryPath: readonly string[] | null;
  readonly note: string | null;
  readonly aliases: readonly CounterpartyAliasNode[];
  readonly transactionCount: number;
}

/** The type tabs docs/02 §4.9 shows above the list. `ALL` is not a stored type. */
export type TypeFilter = 'ALL' | CounterpartyType;

export const TYPE_FILTERS: readonly TypeFilter[] = [
  'ALL',
  'PERSON',
  'COMPANY',
  'GOVERNMENT',
  'OTHER',
];

/**
 * Filter by type.
 *
 * Done on the client because the API's `counterparties` query has no `type` argument, and a
 * Household's counterparties are a handful rather than a page. If that stops being true the filter
 * belongs in the API — a client-side filter over a truncated list would silently hide rows.
 */
export function matchesTypeFilter(node: CounterpartyNode, filter: TypeFilter): boolean {
  return filter === 'ALL' || node.type === filter;
}

export type MergeRefusal = 'SAME';

/**
 * Why a merge would be refused.
 *
 * Only self-merge: unlike a Merchant there is no shipped row to protect, because `counterparties` is
 * plain household-scoped with no system data. The server re-checks.
 */
export function mergeRefusal(
  source: CounterpartyNode | null,
  target: CounterpartyNode | null,
): MergeRefusal | null {
  if (!source || !target) return null;
  return source.id === target.id ? 'SAME' : null;
}

/** Whether a Counterparty can be deleted outright: never one Transactions still point at. */
export function deleteRefusal(node: CounterpartyNode | null): 'IN_USE' | null {
  if (!node) return null;
  return node.transactionCount > 0 ? 'IN_USE' : null;
}

/**
 * Whether two names are the same Counterparty.
 *
 * The F-11 case is literally a spelling variant — "Dejan rođa" against "dejan roda" — so the check
 * must fold exactly as the server does or the warning and the `CONFLICT` disagree.
 */
export function sameCounterpartyName(a: string, b: string): boolean {
  return normaliseClientSide(a) === normaliseClientSide(b);
}
