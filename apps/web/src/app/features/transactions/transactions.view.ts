import { addMoney, type Money } from '@finmate/domain';

import { moneyFromWire } from '../../shared/money-text';
import type { MoneyWire } from '../../shared/ui/money/money.component';

export type TransactionKind = 'EXPENSE' | 'INCOME';
export type TransactionStatus = 'CONFIRMED' | 'PENDING' | 'VOID';

/**
 * One part of a divided Transaction (invariant I-1: the parts sum exactly to the parent amount).
 *
 * A Transaction with splits carries NO category of its own — the category lives on each part.
 */
export interface SplitRow {
  readonly id: string;
  readonly amount: MoneyWire;
  readonly categoryId: string;
}

/** A Transaction as the list screen needs it. Mirrors `TransactionModel` (docs/06 §5). */
export interface TransactionRow {
  readonly id: string;
  readonly kind: TransactionKind;
  readonly status: TransactionStatus;
  readonly amount: MoneyWire;
  readonly description: string;
  readonly note: string | null;
  readonly occurredAt: string;
  readonly occurredLocalDate: string;
  readonly categoryId: string | null;
  readonly accountId: string;
  readonly needsReview: boolean;
  /** Optimistic concurrency. Sent back on update; a mismatch is a CONFLICT. */
  readonly version: number;
  readonly splits: readonly SplitRow[];
}

/**
 * One calendar day of Transactions.
 *
 * `expenseTotal`/`incomeTotal` are **null when the day is truncated**, which is the point of this
 * type: the list is cursor-paginated newest-first, so the oldest day in the window may be missing
 * rows. Summing whatever happens to be loaded and labelling it "total" would show a number that
 * silently grows as the user scrolls — a wrong number presented as a fact about their money. The
 * grouping therefore refuses to state a total it cannot know.
 *
 * Expense and income are summed separately rather than netted: `Money` is non-negative and carries
 * direction in `kind` (ADR-003), so subtracting one from the other would be a type error in the
 * domain and a lie on the screen ("I spent −15.000" is not a thing).
 */
export interface DayGroup {
  readonly date: string;
  readonly rows: readonly TransactionRow[];
  readonly expenseTotal: Money | null;
  readonly incomeTotal: Money | null;
}

/**
 * Group rows into days, newest day first.
 *
 * `hasMore` is the connection's `hasNextPage`. When it is true the last group is the truncated one;
 * every earlier group is complete because the ordering is stable (`occurred_local_date desc, id
 * desc`). Zero-amount sums come back as `null` too, so the UI renders nothing for a day with no
 * expenses rather than a "0,00" that looks like a calculated fact.
 */
export function groupByDay(rows: readonly TransactionRow[], hasMore: boolean): readonly DayGroup[] {
  const byDate = new Map<string, TransactionRow[]>();
  for (const row of rows) {
    const bucket = byDate.get(row.occurredLocalDate);
    if (bucket) bucket.push(row);
    else byDate.set(row.occurredLocalDate, [row]);
  }

  const groups: DayGroup[] = [];
  for (const [date, dayRows] of byDate) {
    // Only the group holding the oldest row can be cut by the page boundary, and only while another
    // page exists. `byDate` preserves insertion order, which is the server's newest-first order.
    const isLast = groups.length === byDate.size - 1;
    const truncated = hasMore && isLast;
    const expense = sumOf(dayRows, 'EXPENSE');
    const income = sumOf(dayRows, 'INCOME');
    groups.push({
      date,
      rows: dayRows,
      expenseTotal: truncated ? null : expense,
      incomeTotal: truncated ? null : income,
    });
  }
  return groups;
}

/** `null` for an empty or zero sum: "no expenses" and "0,00 of expenses" read differently. */
function sumOf(rows: readonly TransactionRow[], kind: TransactionKind): Money | null {
  const total = totalOf(
    rows.filter((row) => row.kind === kind).map((row) => moneyFromWire(row.amount)),
  );
  return total?.amountMinor === 0n ? null : total;
}

/**
 * Sum Money exactly, or `null` when there is nothing to sum.
 *
 * Uses the domain's `addMoney`, which rejects mixed currencies rather than silently adding them
 * (ADR-011: one ledger currency per Household). Integer minor units mean this is exact — the reason
 * `0.1 + 0.2` is not a hazard anywhere in this codebase (ADR-003).
 */
export function totalOf(values: readonly Money[]): Money | null {
  const [first, ...rest] = values;
  if (!first) return null;
  return rest.reduce((running, amount) => addMoney(running, amount), first);
}

/**
 * The instant to send alongside a date-only edit.
 *
 * Local **device** noon, not noon UTC. The server derives the calendar day from the instant in the
 * *Household's* timezone, so `T12:00:00Z` is the 15th for a Household in `Pacific/Auckland`
 * (UTC+13) — and near a month boundary that files the Transaction in the wrong month, which silently
 * corrupts every budget total for that period. Noon local to the device keeps the intended day for
 * any Household in the user's own zone.
 *
 * This is a fallback, not the contract: `occurredLocalDate` is what the server actually keys off.
 * The instant is sent only because `occurredAt` remains a required argument on create.
 */
export function localNoonInstant(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) throw new Error(`Not a calendar date: ${date}`);
  return new Date(year, month - 1, day, 12, 0, 0, 0).toISOString();
}

export interface TransactionFilters {
  readonly search: string;
  readonly kind: TransactionKind | '';
  readonly categoryId: string;
  readonly accountId: string;
  readonly from: string;
  readonly to: string;
  /** The BLOCKING review lane only (invariant I-8), not the advisory band. */
  readonly needsReviewOnly: boolean;
}

export function emptyFilters(): TransactionFilters {
  return {
    search: '',
    kind: '',
    categoryId: '',
    accountId: '',
    from: '',
    to: '',
    needsReviewOnly: false,
  };
}

export function hasActiveFilters(filters: TransactionFilters): boolean {
  return (
    filters.search.trim() !== '' ||
    filters.kind !== '' ||
    filters.categoryId !== '' ||
    filters.accountId !== '' ||
    filters.from !== '' ||
    filters.to !== '' ||
    filters.needsReviewOnly
  );
}

/**
 * The filter as a flat set of parameters.
 *
 * **One definition, two transports.** The list sends these as GraphQL variables and the CSV export
 * sends them as a query string, so that the file always contains what the screen showed. Writing the
 * mapping twice is how an export quietly starts including rows the filter excluded.
 *
 * Absent and empty are different things to the API: an omitted `search` means "no filter", while
 * `''` would be a substring match against the empty string. So every blank field is dropped rather
 * than sent as null-ish filler.
 */
export function filterParams(filters: TransactionFilters): Record<string, string | boolean> {
  const params: Record<string, string | boolean> = {};
  if (filters.search.trim()) params['search'] = filters.search.trim();
  if (filters.kind) params['kind'] = filters.kind;
  if (filters.categoryId) params['categoryId'] = filters.categoryId;
  if (filters.accountId) params['accountId'] = filters.accountId;
  if (filters.from) params['from'] = filters.from;
  if (filters.to) params['to'] = filters.to;
  if (filters.needsReviewOnly) params['needsReview'] = true;
  return params;
}

/** The filter as GraphQL variables, plus paging. */
export function toQueryVariables(
  filters: TransactionFilters,
  options: { readonly first?: number; readonly after?: string | null } = {},
): Record<string, unknown> {
  return {
    first: options.first ?? PAGE_SIZE,
    ...(options.after ? { after: options.after } : {}),
    ...filterParams(filters),
  };
}

/**
 * The download URL for the current filter.
 *
 * `/api` is the browser-facing prefix; the dev proxy and the deployed origin strip it before the API
 * sees it (docs/06). Building it from `filterParams` is what keeps the export equal to the view.
 */
export function exportUrl(filters: TransactionFilters): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filterParams(filters))) {
    search.set(key, String(value));
  }
  const query = search.toString();
  return `/api/export/transactions.csv${query ? `?${query}` : ''}`;
}

/**
 * The keys a drill-through may put in the URL — exactly the `transactions` arguments (docs/06 §4.4).
 *
 * The assistant's `drillThrough.filter` is a bag of *these* names, so this list is the whole contract
 * between the two screens. A key the screen cannot apply must be dropped rather than ignored
 * silently: a URL that claims `merchantId` and shows every Merchant is a link that lies.
 */
export const FILTER_QUERY_KEYS = [
  'from',
  'to',
  'categoryId',
  'accountId',
  'kind',
  'needsReview',
] as const;

export type FilterQueryKey = (typeof FILTER_QUERY_KEYS)[number];

/** The recognised, non-empty entries of a drill-through bag, in a stable order. */
export function filterQueryFromBag(
  bag: Readonly<Record<string, string>> | null | undefined,
): Record<FilterQueryKey, string> {
  const query = {} as Record<FilterQueryKey, string>;
  if (!bag) return query;
  for (const key of FILTER_QUERY_KEYS) {
    const value = bag[key];
    if (typeof value === 'string' && value.length > 0) query[key] = value;
  }
  return query;
}

/** The same bag as a query string (no leading `?`), for a drill-through link. */
export function filterQueryString(bag: Readonly<Record<string, string>> | null | undefined): string {
  return new URLSearchParams(filterQueryFromBag(bag)).toString();
}

/**
 * Read a drill-through out of the URL into the screen's filter.
 *
 * Two decisions worth keeping:
 *
 *  - **Only the keys present are applied**, merged onto `base`, so a link carrying just a period does
 *    not silently clear a Category the user had already chosen.
 *  - **A `kind` that is not a `TransactionKind` is dropped**, not forwarded. The URL is
 *    user-editable, and sending `kind=nonsense` to the API turns a typo into a validation error on a
 *    screen that did nothing wrong.
 */
export function filtersFromQuery(
  query: Readonly<Record<string, string | null>>,
  base: TransactionFilters = emptyFilters(),
): TransactionFilters {
  const bag = filterQueryFromBag(
    Object.fromEntries(
      Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
  );

  const kind = bag.kind;
  return {
    ...base,
    ...(bag.from === undefined ? {} : { from: bag.from }),
    ...(bag.to === undefined ? {} : { to: bag.to }),
    ...(bag.categoryId === undefined ? {} : { categoryId: bag.categoryId }),
    ...(bag.accountId === undefined ? {} : { accountId: bag.accountId }),
    ...(kind === undefined || (kind !== 'EXPENSE' && kind !== 'INCOME') ? {} : { kind }),
    ...(bag.needsReview === undefined ? {} : { needsReviewOnly: bag.needsReview === 'true' }),
  };
}

/**
 * The filename the API chose, from `Content-Disposition`.
 *
 * Returns null rather than a guess when the header is missing or unparseable, so the caller decides
 * the fallback instead of this function inventing a name.
 */
export function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  const name = match?.[1]?.trim();
  if (!name) return null;
  try {
    return decodeURIComponent(name);
  } catch {
    // A malformed percent-escape is not worth failing a download over.
    return name;
  }
}

/** What an edit sheet's save actually has to do. */
export interface EditPlan {
  /** The category changed, so this is a **Correction** and carries a learning signal. */
  readonly categoryChanged: boolean;
  /** Something other than the category changed, so a plain update still has work to do. */
  readonly otherFieldsChanged: boolean;
  /** The category to store, `null` meaning "clear it". */
  readonly nextCategoryId: string | null;
}

/**
 * Decide which write an edit sheet's Save needs.
 *
 * **This is the decision that routes a save to `correctTransaction` instead of `updateTransaction`**,
 * and it is pure because getting it wrong is silent in both directions: send a category change
 * through a plain update and the Correction is never recorded (the learning loop loses its signal,
 * with no error anywhere); send an unchanged category through a correction and the `corrections`
 * table fills with rows that say nothing changed.
 *
 * A split Transaction has no transaction-level category — its parts carry their own — so a category
 * edit is not applicable and never counts as a correction (`categoryId` is passed as `null` and
 * `current.categoryId` is `null` too, which this comparison treats as unchanged).
 */
export function planEdit(args: {
  readonly current: TransactionRow;
  readonly categoryId: string | null;
  readonly description: string;
  readonly occurredOn: string;
  readonly status: TransactionStatus;
  readonly note: string;
  /** `null` for a split Transaction, whose total is fixed by its parts (I-1). */
  readonly amountMinor: bigint | null;
}): EditPlan {
  const nextCategoryId = args.categoryId;

  return {
    categoryChanged: nextCategoryId !== args.current.categoryId,
    otherFieldsChanged:
      args.description !== args.current.description ||
      args.occurredOn !== args.current.occurredLocalDate ||
      args.status !== args.current.status ||
      args.note.trim() !== (args.current.note ?? '') ||
      // A `null` amount means "not editable here", never "no change to zero" — comparing it against
      // the stored figure would report every split Transaction as edited on every save.
      (args.amountMinor !== null && args.amountMinor !== BigInt(args.current.amount.amountMinor)),
    nextCategoryId,
  };
}

/** One screenful. Small enough to keep the first paint quick, large enough to fill a phone twice. */
export const PAGE_SIZE = 25;
