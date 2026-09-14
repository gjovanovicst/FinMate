import { Injectable } from '@nestjs/common';

import {
  allocate,
  DateError,
  pathTo,
  instantForLocalNoon,
  localDate,
  money,
  toLocalDate,
  uuidv7,
  DEFAULT_TIME_ZONE,
  type LocalDate,
  type Money,
} from '@finmate/domain';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import { normalisePageSize, type CursorPage } from '../../graphql/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { transactionsToCsv } from './transactions.csv';
import {
  CategorySource,
  TransactionKind,
  TransactionSource,
  TransactionStatus,
  type TransactionModel,
} from './transaction.model';

export interface TransactionSplitInput {
  readonly categoryId: string;
  readonly amountMinor: bigint;
  readonly note?: string | null;
}

export interface CreateTransactionInput {
  readonly accountId: string;
  readonly kind: TransactionKind;
  readonly amountMinor: bigint;
  readonly description: string;
  readonly occurredAt?: Date | null;
  readonly occurredLocalDate?: string | null;
  readonly categoryId?: string | null;
  readonly merchantId?: string | null;
  readonly counterpartyId?: string | null;
  readonly note?: string | null;
  readonly rawInput?: string | null;
  readonly status?: TransactionStatus;
  readonly source?: TransactionSource;
  readonly categorySource?: CategorySource | null;
  readonly splits?: readonly TransactionSplitInput[];
  readonly idempotencyKey?: string | null;
}

export interface UpdateTransactionInput {
  readonly version: number;
  readonly amountMinor?: bigint;
  readonly description?: string;
  readonly occurredAt?: Date;
  readonly occurredLocalDate?: string | null;
  readonly categoryId?: string | null;
  readonly merchantId?: string | null;
  readonly counterpartyId?: string | null;
  readonly note?: string | null;
  readonly status?: TransactionStatus;
}

export interface TransactionFilters {
  readonly accountId?: string;
  readonly categoryId?: string;
  readonly kind?: TransactionKind;
  readonly status?: TransactionStatus;
  readonly from?: string;
  readonly to?: string;
  readonly search?: string;
  readonly needsReview?: boolean;
}

/**
 * The ledger — the module that owns money.
 *
 * Its job is to make the data model's invariants true rather than hoped for:
 *
 *  - **I-1** `sum(splits) == amount`, or no splits and a category. Never both, never neither.
 *  - **I-3** a Transaction's category has a matching `kind`.
 *  - **I-7** `PENDING` rows are stored but excluded from every derived figure.
 *  - **I-2** `occurred_local_date` is derived from the instant in the **Household's** timezone.
 *  - **I-10** an idempotency key makes a replay return the original row instead of duplicating it.
 *
 * Every balance, budget and insight in the product reads through here, so a bug in this file is a
 * bug in every number the user sees.
 */
/**
 * The most rows one CSV export will produce.
 *
 * docs/06 §10 rate-limits `EXPORT` at 3/day per household because it is a whole-table scan; a quota
 * needs infrastructure that does not exist yet, so the cap is the guard. It is generous for a
 * household ledger and small enough that generating the file in memory is safe.
 */
export const MAX_EXPORT_ROWS = 50_000;

@Injectable()
export class TransactionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    householdId: string,
    filters: TransactionFilters,
    page: { first?: number; after?: string },
  ): Promise<CursorPage<TransactionModel>> {
    const take = normalisePageSize(page.first);

    // Keyset on the UUIDv7 primary key: it is time-ordered, so `id desc` is newest-first and an
    // OFFSET page would shift under the client as rows arrive.
    // One filter, one builder: the page and its `totalCount` used to be assembled separately, and
    // the count quietly ignored the date range, so a date-filtered list read "8 transactions" above
    // seven rows. Anything that filters Transactions goes through `buildWhere` now.
    const where = {
      ...this.buildWhere(householdId, filters),
      ...(page.after ? { id: { lt: page.after } } : {}),
    };

    const [rows, totalCount] = await Promise.all([
      this.prisma.client.transactions.findMany({
        where,
        orderBy: [{ occurred_local_date: 'desc' }, { id: 'desc' }],
        take: take + 1,
        include: { transaction_splits: true },
      }),
      this.prisma.client.transactions.count({
        where: this.buildWhere(householdId, filters),
      }),
    ]);

    const hasNextPage = rows.length > take;
    const items = (hasNextPage ? rows.slice(0, take) : rows).map((row) => this.toModel(row));

    return { items, totalCount, hasNextPage, endCursor: items.at(-1)?.id ?? null };
  }

  /**
   * The filtered Transactions as CSV (F-25).
   *
   * **Oldest first**, unlike the list: a CSV is a document to open in a spreadsheet, and reading a
   * ledger backwards to reconcile it is work the export should not create.
   *
   * The row cap is a refusal rather than a truncation. A file that silently stops at 50,000 rows is
   * indistinguishable from a complete one once it is in a spreadsheet, and every total taken from it
   * would be quietly short. Naming the count and the cap tells the user exactly how to proceed.
   *
   * Not rate-limited: docs/06 §10 sets an `exports_monthly` quota, which needs the quota
   * infrastructure that does not exist yet. The cap is what bounds the work today.
   */
  async exportCsv(
    householdId: string,
    filters: TransactionFilters,
  ): Promise<{ csv: string; rowCount: number; totalMatching: number }> {
    const where = this.buildWhere(householdId, filters);

    const totalMatching = await this.prisma.client.transactions.count({ where });
    if (totalMatching > MAX_EXPORT_ROWS) {
      throw new ApiError(
        'VALIDATION_FAILED',
        `That filter matches ${totalMatching} transactions, which is more than the ` +
          `${MAX_EXPORT_ROWS} an export can hold. Narrow the date range and export again.`,
      );
    }

    const [rows, categories] = await Promise.all([
      this.prisma.client.transactions.findMany({
        where,
        orderBy: [{ occurred_local_date: 'asc' }, { id: 'asc' }],
        include: { transaction_splits: true, accounts: true, categories: true },
      }),
      // Few enough to hold in memory, and the only way to render a full breadcrumb: a category's
      // path is a walk up its ancestors, which Prisma cannot include recursively.
      this.prisma.client.categories.findMany({
        where: { household_id: householdId, deleted_at: null },
        select: { id: true, name: true, parent_id: true },
      }),
    ]);

    const csv = transactionsToCsv(
      rows.map((row) => ({
        occurredLocalDate: row.occurred_local_date.toISOString().slice(0, 10),
        occurredAt: row.occurred_at,
        kind: row.kind,
        status: row.status,
        amount: money(row.amount_minor, row.currency),
        description: row.description,
        categoryPath: row.categories ? this.categoryPath(categories, row.categories.id) : null,
        splits: row.transaction_splits.map((split) => ({
          categoryPath: this.categoryPath(categories, split.category_id),
          amount: money(split.amount_minor, row.currency),
        })),
        accountName: row.accounts.name,
        note: row.note,
        needsReview: row.needs_review,
        source: row.source,
        id: row.id,
      })),
    );

    return { csv, rowCount: rows.length, totalMatching };
  }

  /** A Category's breadcrumb by name, from the root down. */
  private categoryPath(
    categories: readonly { id: string; name: string; parent_id: string | null }[],
    id: string,
  ): string {
    const byId = new Map(categories.map((category) => [category.id, category]));
    return pathTo(
      categories.map((category) => ({ id: category.id, parentId: category.parent_id })),
      id,
    )
      .map((ancestorId) => byId.get(ancestorId)?.name ?? '')
      .filter((name) => name !== '')
      .join(' › ');
  }

  async getById(householdId: string, id: string): Promise<TransactionModel> {
    const row = await this.prisma.client.transactions.findFirst({
      where: { id, household_id: householdId, deleted_at: null },
      include: { transaction_splits: true },
    });
    if (!row) throw new ApiError('NOT_FOUND', 'Transaction not found.');
    return this.toModel(row);
  }

  async create(householdId: string, input: CreateTransactionInput): Promise<TransactionModel> {
    if (input.amountMinor <= 0n) {
      throw new ApiError('VALIDATION_FAILED', 'Amount must be greater than zero.');
    }

    const description = input.description.trim();
    if (description.length === 0) {
      throw new ApiError('VALIDATION_FAILED', 'A description is required.');
    }

    // I-10: a replay of the same input returns the original row rather than duplicating money.
    if (input.idempotencyKey) {
      const existing = await this.prisma.client.transactions.findFirst({
        where: { household_id: householdId, idempotency_key: input.idempotencyKey },
        include: { transaction_splits: true },
      });
      if (existing) return this.toModel(existing);
    }

    const household = await this.prisma.client.households.findFirst({ where: { id: householdId } });
    if (!household) throw new ApiError('NOT_FOUND', 'Household not found.');
    const currency = household.ledger_currency;

    await this.validateClassification(householdId, input.kind, input.categoryId, input.splits);

    const amount = money(input.amountMinor, currency);
    // I-1, enforced here rather than trusted from the client: `proposeSplits` allocates exactly, but
    // a client may send arbitrary amounts, and a ledger whose splits do not add up to the payment is
    // one nobody can reconcile.
    if (input.splits?.length) this.assertSplitsBalance(amount, input.splits);

    const timeZone = household.iana_timezone || DEFAULT_TIME_ZONE;
    const occurrence = this.resolveOccurrence(input.occurredAt, input.occurredLocalDate, timeZone);

    const result = await this.prisma.client.$transaction(async (tx) => {
      const created = await tx.transactions.create({
        data: {
          id: uuidv7(),
          household_id: householdId,
          account_id: input.accountId,
          kind: input.kind,
          amount_minor: input.amountMinor,
          currency,
          // I-1: a Transaction with splits carries no category of its own, and vice versa.
          category_id: input.splits?.length ? null : (input.categoryId ?? null),
          merchant_id: input.merchantId ?? null,
          counterparty_id: input.counterpartyId ?? null,
          description,
          note: input.note ?? null,
          raw_input: input.rawInput ?? null,
          occurred_at: occurrence.occurredAt,
          occurred_local_date: occurrence.occurredLocalDate,
          status: input.status ?? TransactionStatus.CONFIRMED,
          source: input.source ?? TransactionSource.MANUAL,
          category_source: input.splits?.length ? null : (input.categorySource ?? null),
          idempotency_key: input.idempotencyKey ?? null,
        },
      });

      if (input.splits?.length) {
        await tx.transaction_splits.createMany({
          data: input.splits.map((split) => ({
            id: uuidv7(),
            household_id: householdId,
            transaction_id: created.id,
            category_id: split.categoryId,
            amount_minor: split.amountMinor,
            note: split.note ?? null,
            category_source: CategorySource.USER,
          })),
        });
      }

      return created;
    });

    return this.getById(householdId, result.id);
  }

  /**
   * Update with optimistic concurrency.
   *
   * Two users (or two devices) editing the same Transaction must not silently overwrite each other,
   * so the caller sends the `version` it read. A mismatch is a `CONFLICT` carrying the current state
   * rather than a last-write-wins that loses money.
   */
  async update(
    householdId: string,
    id: string,
    input: UpdateTransactionInput,
  ): Promise<TransactionModel> {
    const existing = await this.prisma.client.transactions.findFirst({
      where: { id, household_id: householdId, deleted_at: null },
      include: { transaction_splits: true },
    });
    if (!existing) throw new ApiError('NOT_FOUND', 'Transaction not found.');

    if (existing.version !== input.version) {
      throw new ApiError(
        'CONFLICT',
        'This transaction was changed somewhere else. Reload it and try again.',
      );
    }

    if (input.amountMinor !== undefined && input.amountMinor <= 0n) {
      throw new ApiError('VALIDATION_FAILED', 'Amount must be greater than zero.');
    }

    // I-1 spans two tables, so PostgreSQL cannot enforce it as a CHECK — a CHECK sees only its own
    // row and cannot sum a sibling table. `create` calls `assertSplitsBalance`; without the same
    // guard here an amount edit would leave the splits summing to a total that no longer exists.
    // The splits are refused rather than deleted: discarding the user's categorisation to satisfy
    // the invariant would be data loss.
    if (
      input.amountMinor !== undefined &&
      input.amountMinor !== existing.amount_minor &&
      existing.transaction_splits.length > 0
    ) {
      throw new ApiError(
        'VALIDATION_FAILED',
        `This transaction is divided into ${existing.transaction_splits.length} split(s), so its ` +
          `amount is the sum of those splits (invariant I-1). Change the splits rather than the ` +
          `amount, or delete this transaction and record it again.`,
      );
    }

    if (input.categoryId !== undefined) {
      await this.validateClassification(householdId, existing.kind as TransactionKind, input.categoryId, undefined);
    }

    const household = await this.prisma.client.households.findFirst({ where: { id: householdId } });
    const timeZone = household?.iana_timezone || DEFAULT_TIME_ZONE;

    // `resolveOccurrence` prefers `occurredLocalDate` when both are sent. Two sources of truth for
    // the day would otherwise disagree silently, and the client-asserted calendar day is the one
    // the user actually picked.
    const occurrence =
      input.occurredLocalDate != null || input.occurredAt !== undefined
        ? this.resolveOccurrence(input.occurredAt, input.occurredLocalDate, timeZone)
        : null;

    const updated = await this.prisma.client.transactions.updateMany({
      where: { id, household_id: householdId, version: input.version },
      data: {
        ...(input.amountMinor !== undefined ? { amount_minor: input.amountMinor } : {}),
        ...(input.description !== undefined ? { description: input.description.trim() } : {}),
        ...(input.categoryId !== undefined ? { category_id: input.categoryId } : {}),
        ...(input.merchantId !== undefined ? { merchant_id: input.merchantId } : {}),
        ...(input.counterpartyId !== undefined ? { counterparty_id: input.counterpartyId } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(occurrence
          ? {
              occurred_at: occurrence.occurredAt,
              occurred_local_date: occurrence.occurredLocalDate,
            }
          : {}),
        version: existing.version + 1,
        updated_at: new Date(),
      },
    });

    // The WHERE carried the version, so zero rows means somebody else won the race.
    if (updated.count === 0) {
      throw new ApiError('CONFLICT', 'This transaction was changed somewhere else. Reload it.');
    }

    return this.getById(householdId, id);
  }

  /** Soft-delete. Financial rows are never hard-deleted, so history stays auditable. */
  async remove(householdId: string, id: string): Promise<void> {
    const result = await this.prisma.client.transactions.updateMany({
      where: { id, household_id: householdId, deleted_at: null },
      data: { deleted_at: new Date(), updated_at: new Date() },
    });
    if (result.count === 0) throw new ApiError('NOT_FOUND', 'Transaction not found.');
  }

  // -------------------------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------------------------

  /**
   * Validate the classification shape and the kind match.
   *
   * The split-sum check is the one that matters most: `allocate()` guarantees it when the client
   * splits a total, but a client can also send arbitrary split amounts, so the sum is verified here
   * rather than trusted. A ledger whose splits do not add up to the payment is a ledger nobody can
   * reconcile.
   */
  private async validateClassification(
    householdId: string,
    kind: TransactionKind,
    categoryId: string | null | undefined,
    splits: readonly TransactionSplitInput[] | undefined,
  ): Promise<void> {
    if (splits && splits.length > 0 && categoryId) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'A transaction either carries a category or is divided into splits, not both (invariant I-1).',
      );
    }

    if (categoryId) {
      const category = await this.prisma.client.categories.findFirst({
        where: { id: categoryId, household_id: householdId, deleted_at: null },
      });
      if (!category) throw new ApiError('NOT_FOUND', 'Category not found.');
      if (category.kind !== kind) {
        // I-3: an expense must never land in an income category.
        throw new ApiError(
          'VALIDATION_FAILED',
          `That category classifies ${category.kind.toLowerCase()} but the transaction is ` +
            `${kind.toLowerCase()} (invariant I-3).`,
        );
      }
    }

    if (splits && splits.length > 0) {
      if (splits.some((split) => split.amountMinor <= 0n)) {
        throw new ApiError('VALIDATION_FAILED', 'Every split must be greater than zero.');
      }
      // The SUM is checked by `assertSplitsBalance` against the transaction total; here only the
      // per-split shape and kind are validated.
      for (const split of splits) {
        const category = await this.prisma.client.categories.findFirst({
          where: { id: split.categoryId, household_id: householdId, deleted_at: null },
        });
        if (!category) throw new ApiError('NOT_FOUND', `Split category ${split.categoryId} not found.`);
        if (category.kind !== kind) {
          throw new ApiError(
            'VALIDATION_FAILED',
            `Split category "${category.name}" classifies ${category.kind.toLowerCase()} but the ` +
              `transaction is ${kind.toLowerCase()} (invariant I-3).`,
          );
        }
      }
    }
  }

  /**
   * Assert that a set of splits sums to the transaction amount (invariant I-1).
   *
   * Exposed separately from `create` so the same check is available to the capture pipeline in
   * Phase 2, where a model proposes the split amounts and the backend must verify them.
   */
  assertSplitsBalance(amount: Money, splits: readonly TransactionSplitInput[]): void {
    const total = splits.reduce((sum, split) => sum + split.amountMinor, 0n);
    if (total !== amount.amountMinor) {
      throw new ApiError(
        'VALIDATION_FAILED',
        `Splits total ${total} but the transaction is ${amount.amountMinor}; they must match exactly ` +
          `(invariant I-1).`,
      );
    }
  }

  /** Split a total across categories without losing a para, using the domain allocator. */
  proposeSplits(amount: Money, categoryIds: readonly string[]): TransactionSplitInput[] {
    if (categoryIds.length === 0) {
      throw new ApiError('VALIDATION_FAILED', 'At least one category is required to split.');
    }
    return allocate(amount, categoryIds.map(() => 1)).map((part, index) => ({
      categoryId: categoryIds[index]!,
      amountMinor: part.amountMinor,
    }));
  }

  // -------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------

  /**
   * Resolve both date columns from whichever source the caller supplied.
   *
   * `occurredLocalDate` is the preferred direction — the user asserts the calendar day and the
   * server chooses the instant — so a client that only knows the day the user picked never has to
   * know the Household timezone. Deriving the day from a client-invented instant instead can only be
   * right by accident, which is how a transaction lands a day late across a positive offset
   * (invariant I-2).
   */
  private resolveOccurrence(
    occurredAt: Date | null | undefined,
    occurredLocalDate: string | null | undefined,
    timeZone: string,
  ): { occurredAt: Date; occurredLocalDate: Date } {
    if (occurredLocalDate) {
      try {
        const day = localDate(occurredLocalDate);
        return {
          occurredAt: instantForLocalNoon(day, timeZone),
          occurredLocalDate: this.dateColumn(day),
        };
      } catch (error) {
        // The GraphQL LocalDate scalar already rejects a malformed string, so this is the belt to
        // its braces: a bad day (or a Household carrying a broken timezone) becomes a typed client
        // error instead of an INTERNAL_SERVER_ERROR escaping from `Intl`.
        if (error instanceof DateError) throw new ApiError('VALIDATION_FAILED', error.message);
        throw error;
      }
    }

    if (occurredAt) {
      return { occurredAt, occurredLocalDate: this.localDateFor(occurredAt, timeZone) };
    }

    throw new ApiError(
      'VALIDATION_FAILED',
      'Either occurredAt or occurredLocalDate is required to place the transaction in time.',
    );
  }

  private localDateFor(instant: Date, timeZone: string): Date {
    // Stored as a `date` column, so Prisma wants a Date at UTC midnight of the intended day —
    // which is exactly what the domain helper returns as a string.
    return this.dateColumn(toLocalDate(instant, timeZone));
  }

  /** A calendar day as the `date` column's UTC-midnight `Date`. */
  private dateColumn(day: LocalDate): Date {
    return new Date(`${day}T00:00:00.000Z`);
  }

  /** The filter subset used for the total count, so a page and its total agree. */
  /**
   * The single definition of "which Transactions does this filter select".
   *
   * `list` uses it for both the page and the `totalCount`, and the CSV export uses it too — so an
   * export can never contain a different set from the screen that offered it. Every predicate must
   * live here, because a predicate added to only one caller is exactly how the two drift apart.
   */
  /**
   * A date filter as a `Date`, or `VALIDATION_FAILED`.
   *
   * The GraphQL `LocalDate` scalar guarantees a well-formed day, but the CSV export is a REST route
   * and a query string is just text: `?from=notadate` reached Prisma as an Invalid Date and surfaced
   * as an INTERNAL 500, which tells the caller nothing and looks like a server fault. Validating here
   * rather than in the controller keeps the guarantee at the one place every filter passes through.
   */
  private calendarBound(value: string, field: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
      throw new ApiError('VALIDATION_FAILED', `"${field}" must be a date as YYYY-MM-DD.`);
    }
    return new Date(value);
  }

  private buildWhere(
    householdId: string,
    filters: TransactionFilters,
  ): Record<string, unknown> {
    return {
      household_id: householdId,
      deleted_at: null,
      ...(filters.accountId ? { account_id: filters.accountId } : {}),
      ...(filters.categoryId ? { category_id: filters.categoryId } : {}),
      ...(filters.kind ? { kind: filters.kind } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.needsReview !== undefined ? { needs_review: filters.needsReview } : {}),
      ...(filters.from || filters.to
        ? {
            occurred_local_date: {
              ...(filters.from ? { gte: this.calendarBound(filters.from, 'from') } : {}),
              ...(filters.to ? { lte: this.calendarBound(filters.to, 'to') } : {}),
            },
          }
        : {}),
      ...(filters.search
        ? { description: { contains: filters.search, mode: 'insensitive' as const } }
        : {}),
    };
  }

  private toModel(row: {
    id: string;
    kind: string;
    amount_minor: bigint;
    currency: string;
    account_id: string;
    category_id: string | null;
    merchant_id: string | null;
    counterparty_id: string | null;
    description: string;
    note: string | null;
    raw_input: string | null;
    occurred_at: Date;
    occurred_local_date: Date;
    status: string;
    source: string;
    category_source: string | null;
    confidence: unknown;
    needs_review: boolean;
    version: number;
    created_at: Date;
    updated_at: Date;
    transaction_splits?: {
      id: string;
      category_id: string;
      amount_minor: bigint;
      note: string | null;
      confidence: unknown;
      category_source: string | null;
    }[];
  }): TransactionModel {
    return {
      id: row.id,
      kind: row.kind as TransactionKind,
      amount: money(row.amount_minor, row.currency),
      accountId: row.account_id,
      categoryId: row.category_id,
      merchantId: row.merchant_id,
      counterpartyId: row.counterparty_id,
      splits: (row.transaction_splits ?? []).map((split) => ({
        id: split.id,
        categoryId: split.category_id,
        amount: money(split.amount_minor, row.currency),
        note: split.note,
        confidence: split.confidence === null ? null : Number(split.confidence),
        categorySource: split.category_source as CategorySource | null,
      })),
      description: row.description,
      note: row.note,
      rawInput: row.raw_input,
      occurredAt: row.occurred_at,
      occurredLocalDate: row.occurred_local_date.toISOString().slice(0, 10),
      status: row.status as TransactionStatus,
      source: row.source as TransactionSource,
      categorySource: row.category_source as CategorySource | null,
      confidence: row.confidence === null ? null : Number(row.confidence),
      needsReview: row.needs_review,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
