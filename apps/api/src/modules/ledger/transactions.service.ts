import { Injectable } from '@nestjs/common';

import { calibratedConfidenceFromStorage, type CalibratedConfidence } from '@finmate/ai';
import {
  allocate,
  DateError,
  pathTo,
  instantForLocalNoon,
  localDate,
  money,
  todayIn,
  toLocalDate,
  uuidv7,
  DEFAULT_TIME_ZONE,
  type LocalDate,
  type Money,
} from '@finmate/domain';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import { normalisePageSize, type CursorPage } from '../../graphql/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ClassificationService,
  type DecisionOutcome,
  type DecisionSnapshot,
  type FragmentResult,
} from '../classification/classification.service';
import { applyConfidenceGate, resolveLaneThresholds } from '../classification/confidence-gate';
import { TagsService } from '../taxonomy/tags.service';
import { CaptureRejectionCode } from './capture-commit.model';
import {
  DUPLICATE_DATE_TOLERANCE_DAYS,
  DUPLICATE_SUBMISSION_WINDOW_MS,
  findDuplicateSubject,
  type DuplicateCandidate,
} from './duplicate-detection';
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
  /** The Tag set to attach. Omitted means "no tags"; see `update` for the replace-vs-omit rule. */
  readonly tagIds?: readonly string[];
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
  /**
   * Replaces the whole Tag set when present. Omitted leaves the existing assignments alone, and an
   * empty array clears them — the same absent-vs-empty distinction the rest of this input uses.
   */
  readonly tagIds?: readonly string[];
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

/** One row of `captureCommit` (docs/06 §5.2), after the GraphQL scalars have been parsed. */
export interface CaptureCommitRow {
  readonly clientRowId: string;
  readonly idempotencyKey: string;
  readonly clientId?: string | null;
  readonly accountId?: string | null;
  readonly kind: TransactionKind;
  readonly amount: Money;
  readonly categoryId?: string | null;
  readonly merchantId?: string | null;
  readonly counterpartyId?: string | null;
  readonly description?: string | null;
  readonly note?: string | null;
  readonly occurredAt?: Date | null;
  readonly occurredOn?: string | null;
  readonly tagIds?: readonly string[] | null;
  readonly acceptedProposalId?: string | null;
  readonly confirmDespiteLowConfidence?: boolean;
}

/** The whole `captureCommit` request (docs/06 §5.2). */
export interface CaptureCommitRequest {
  readonly parseId?: string | null;
  readonly rows: readonly CaptureCommitRow[];
  readonly defaultAccountId?: string | null;
  readonly occurredAt?: Date | null;
  readonly occurredLocalDate?: string | null;
  readonly discardProposalIds?: readonly string[] | null;
  readonly allowAi?: boolean | null;
}

/** One refused row, with the field at fault when one is nameable (docs/06 §5.2's `RejectedRow`). */
export interface CaptureRejectedRow {
  readonly clientRowId: string;
  readonly code: CaptureRejectionCode;
  readonly message: string;
  readonly field: string | null;
}

/**
 * Thrown instead of returning, so a rejection **cannot** be half-ignored.
 *
 * It is deliberately not an `ApiError`: an `ApiError` becomes a typed GraphQL error and loses the
 * per-row diagnostics, while docs/06 §5.2.1 requires the payload to name **every** offending row.
 * The resolver catches this and returns `CaptureCommitRejected`. Nothing has been written when it is
 * thrown — that is the invariant this class exists to carry.
 */
export class CaptureCommitRejected extends Error {
  constructor(
    readonly rows: readonly CaptureRejectedRow[],
    readonly code: CaptureRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = 'CaptureCommitRejected';
  }
}

/** One written (or replayed) row. */
export interface CaptureCommittedRow {
  readonly clientRowId: string;
  readonly transaction: TransactionModel;
  readonly idempotencyKey: string;
  readonly wasReplayed: boolean;
  readonly decisionId: string | null;
}

export interface CaptureCommitOutcome {
  readonly committed: readonly CaptureCommittedRow[];
  readonly skipped: readonly { readonly clientRowId: string; readonly reason: string }[];
  /** docs/06 §5.2.2's advisory third mechanism. Never a refusal — the row is already written. */
  readonly duplicateSuspects: readonly DuplicateSuspectRow[];
  readonly replayed: boolean;
  readonly cursor: string;
  readonly reviewQueueCount: number;
}

/** One just-written row that looks like a repeat of an existing Transaction. */
export interface DuplicateSuspectRow {
  readonly clientRowId: string;
  readonly transactionId: string;
  readonly existingTransactionId: string;
  readonly existingTransaction: TransactionModel;
  readonly similarity: number;
  readonly matchedOn: readonly string[];
}

/**
 * docs/06 §5.2: `rows` is `1..50`.
 *
 * The cap is not arbitrary politeness — one commit is one interactive transaction, and the row count
 * bounds how long it holds a connection. A whole day typed at once is well under it; a 5 000-row
 * import is a different feature with a different failure model.
 */
export const MAX_CAPTURE_ROWS = 50;

/**
 * The Transaction columns `toModel` reads, plus the relations it may be handed.
 *
 * Named rather than inlined because three call sites share it and two of them are inferred from
 * Prisma's `include` result — an inline structural type would have to be repeated, and a column added
 * in one place but not the other is a silently missing field on the wire.
 */
export interface TransactionRowShape {
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
  transaction_tags?: {
    tags: { id: string; name: string; color: string | null; created_at: Date };
  }[];
}

/** A pending row after the gate has decided everything about it but its Transaction id. */
interface CaptureResolution {
  readonly row: CaptureCommitRow;
  readonly clientRowId: string;
  readonly occurrence: { readonly occurredAt: Date; readonly occurredLocalDate: Date };
  readonly categoryId: string | null;
  readonly confidence: CalibratedConfidence;
  readonly categorySource: CategorySource | null;
  readonly decisionId: string;
  readonly outcome: DecisionOutcome;
  readonly description: string;
  readonly rawText: string;
  readonly status: TransactionStatus;
  readonly needsReview: boolean;
}

/**
 * `classification_decisions.decided_by` → `transactions.category_source`.
 *
 * The two lists are not the same length, and that is not an oversight: `category_source` answers
 * "which *kind* of thing chose this", so the two entity-default arms collapse to `DEFAULT` and
 * `FALLBACK` maps to `null` — an honest "nothing chose it". The precise source survives on the audit
 * row, which is what F-31 reads.
 */
function categorySourceFor(decidedBy: string): CategorySource | null {
  switch (decidedBy) {
    case 'USER':
      return CategorySource.USER;
    case 'RULE':
    case 'KEYWORD':
      return CategorySource.RULE;
    case 'AI':
      return CategorySource.AI;
    case 'MERCHANT_DEFAULT':
    case 'COUNTERPARTY_DEFAULT':
      return CategorySource.DEFAULT;
    default:
      return null;
  }
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly tags: TagsService,
    private readonly classification: ClassificationService,
  ) {}

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
        include: { transaction_splits: true, transaction_tags: { include: { tags: true } } },
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
      include: { transaction_splits: true, transaction_tags: { include: { tags: true } } },
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
        include: { transaction_splits: true, transaction_tags: { include: { tags: true } } },
      });
      if (existing) return this.toModel(existing);
    }

    const household = await this.prisma.client.households.findFirst({ where: { id: householdId } });
    if (!household) throw new ApiError('NOT_FOUND', 'Household not found.');
    const currency = household.ledger_currency;

    await this.validateClassification(householdId, input.kind, input.categoryId, input.splits);

    // A Tag must be one this Household can see; an unknown or foreign id is a typed failure rather
    // than a silently dropped assignment, which would tag the Transaction and then lose the chip.
    const tagIds = [...new Set(input.tagIds ?? [])];
    await this.tags.assertAssignable(tagIds);

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
          // Tags are written through the parent Transaction's nested write: `transaction_tags` has
          // no `household_id`, and the tenancy guard refuses every direct operation on it because
          // there is no tenant predicate it could add (ADR-008).
          ...(tagIds.length > 0
            ? { transaction_tags: { create: tagIds.map((tagId) => ({ tag_id: tagId })) } }
            : {}),
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
   * `captureCommit` — docs/06 §5.2. The write half of the capture path.
   *
   * ## Atomicity is per request, not per row
   *
   * The whole `rows` array is validated before a single Transaction is written, and if **any** row is
   * structurally invalid nothing is written and every offending row is named. The one deliberate
   * exception is a low-confidence row: it is not a validation failure, it is written `PENDING` and
   * enters the review queue, so one ambiguous row never blocks a batch (docs/06 §5.2.1, F-06). That
   * distinction is the most important rule in this method.
   *
   * ## Three mechanisms that are easy to conflate
   *
   * - **Idempotency** (I-10) is retry safety: a row whose `idempotencyKey` already exists short-circuits
   *   and is returned with `wasReplayed = true`. The unique index in Postgres is the authority — this
   *   lookup only avoids the round trip, it does not replace the constraint.
   * - **Client id** is offline dedupe, with the same short-circuit.
   * - **Duplicate suspects** (two genuine submissions of the same thing) are task 2.2.5 and are
   *   deliberately absent: they must *not* block, and returning an empty list today would be
   *   indistinguishable from "checked and found none".
   *
   * ## Money
   *
   * `amount.amountMinor` arrives as a `bigint` from the `Money` scalar and is never converted. The
   * `Money` scalar rejects a JSON number outright, so the cheapest possible mistake — sending `2000`
   * as a float — fails at the edge rather than being rounded (ADR-003).
   */
  async captureCommit(
    householdId: string,
    input: CaptureCommitRequest,
  ): Promise<CaptureCommitOutcome> {
    const rows = [...(input.rows ?? [])];
    if (rows.length === 0) {
      throw new ApiError('VALIDATION_FAILED', 'A capture commit needs at least one row.');
    }
    if (rows.length > MAX_CAPTURE_ROWS) {
      throw new ApiError(
        'VALIDATION_FAILED',
        `A capture commit carries at most ${MAX_CAPTURE_ROWS} rows; this one has ${rows.length}.`,
      );
    }

    const rejected: CaptureRejectedRow[] = [];
    /**
     * Rows already named, so a later phase cannot report the same row twice.
     *
     * Every phase accumulates and the request is refused once, at the end, because docs/06 §5.2.1
     * requires the payload to name every offending row. Without this set a row with both a bad amount
     * and an unknown category would appear twice, and "3 rows could not be committed" would be a
     * count of complaints rather than of rows.
     */
    const rejectedRowIds = new Set<string>();
    const reject = (
      clientRowId: string,
      code: CaptureRejectionCode,
      message: string,
      field: string | null = null,
    ): void => {
      rejected.push({ clientRowId, code, message, field });
      rejectedRowIds.add(clientRowId);
    };

    /**
     * Rejections in the caller's row order, not in phase order.
     *
     * Validation runs in phases (fields, then existence, then previews), so `rejected` accumulates out
     * of order. A client that highlights the offending rows has to zip the payload back against its
     * own list, and a payload that arrives in the order the rows were typed needs no such care. A
     * `discardProposalIds` entry names a decision, not a row, so it sorts last.
     */
    const orderedRejections = (): CaptureRejectedRow[] => {
      const position = new Map(rows.map((entry, index) => [entry.clientRowId, index]));
      return [...rejected].sort(
        (a, b) =>
          (position.get(a.clientRowId) ?? Number.MAX_SAFE_INTEGER) -
          (position.get(b.clientRowId) ?? Number.MAX_SAFE_INTEGER),
      );
    };

    // ---- structural: identities, within the request only ----
    const seenRowIds = new Set<string>();
    const keyOwner = new Map<string, string>();
    for (const [index, row] of rows.entries()) {
      const label = row.clientRowId?.trim() || `#${index}`;
      if (!row.clientRowId?.trim()) {
        reject(label, CaptureRejectionCode.VALIDATION_FAILED, 'clientRowId is required.', 'clientRowId');
        continue;
      }
      if (seenRowIds.has(label)) {
        reject(
          label,
          CaptureRejectionCode.CONFLICT,
          `clientRowId "${label}" appears more than once in this request.`,
          'clientRowId',
        );
        continue;
      }
      seenRowIds.add(label);

      const key = row.idempotencyKey?.trim() ?? '';
      if (key === '') {
        reject(
          label,
          CaptureRejectionCode.VALIDATION_FAILED,
          'idempotencyKey is required (invariant I-10).',
          'idempotencyKey',
        );
        continue;
      }
      const owner = keyOwner.get(key);
      if (owner !== undefined && owner !== label) {
        // Two rows claiming one key would be a unique-index violation on the second insert, which
        // would abort the transaction with an opaque P2002. Refusing it here names both rows.
        reject(
          label,
          CaptureRejectionCode.CONFLICT,
          `idempotencyKey "${key}" is already used by row "${owner}" in this request.`,
          'idempotencyKey',
        );
        continue;
      }
      keyOwner.set(key, label);
    }

    if (rejected.length > 0) throw this.rejection(orderedRejections());

    const household = await this.prisma.client.households.findFirst({ where: { id: householdId } });
    if (!household) throw new ApiError('NOT_FOUND', 'Household not found.');
    const currency = household.ledger_currency;
    const timeZone = household.iana_timezone || DEFAULT_TIME_ZONE;
    const thresholds = resolveLaneThresholds(household.settings);

    // ---- I-10 / offline dedupe: a replay short-circuits before any validation ----
    //
    // Deliberately before validation, not after. A retry echoes a proposal the *first* call has since
    // linked to a Transaction, so validating it would see "this proposal is already committed" and
    // refuse the very retry idempotency exists to serve. A replayed row is not re-examined: it is
    // already written, and the caller asked for it to be there exactly once.
    const replay = await this.findReplays(householdId, rows);
    const replayIds = [...replay.transactions.keys()];
    const linkedDecisions =
      replayIds.length === 0
        ? new Map<string, string>()
        : new Map(
            (
              await this.prisma.client.classification_decisions.findMany({
                where: { household_id: householdId, transaction_id: { in: replayIds } },
                select: { id: true, transaction_id: true },
              })
            ).map((row) => [row.transaction_id as string, row.id]),
          );

    const committed: CaptureCommittedRow[] = [];
    const pending: CaptureCommitRow[] = [];
    for (const row of rows) {
      const existing = replay.for(row);
      if (existing === null) {
        pending.push(row);
        continue;
      }
      committed.push({
        clientRowId: row.clientRowId,
        transaction: this.toModel(existing),
        idempotencyKey: row.idempotencyKey,
        wasReplayed: true,
        decisionId: linkedDecisions.get(existing.id) ?? null,
      });
    }

    // ---- per-row validation, in memory ----
    const occurrenceFor = new Map<string, { occurredAt: Date; occurredLocalDate: Date }>();
    const accountFor = new Map<string, string>();
    const categoryIds = new Set<string>();
    const merchantIds = new Set<string>();
    const counterpartyIds = new Set<string>();
    const tagIds = new Set<string>();
    const proposalIds = new Set<string>();

    for (const row of pending) {
      const label = row.clientRowId.trim();

      if (row.amount.amountMinor <= 0n) {
        reject(label, CaptureRejectionCode.VALIDATION_FAILED, 'Amount must be greater than zero.', 'amount');
        continue;
      }
      if (row.amount.currency !== currency) {
        // ADR-011: one ledger currency per Household. Accepting a foreign amount would put two
        // currencies in one column and make every total a sum of unlike things.
        reject(
          label,
          CaptureRejectionCode.VALIDATION_FAILED,
          `This Household keeps its ledger in ${currency}; the row is in ${row.amount.currency} ` +
            `(ADR-011).`,
          'amount',
        );
        continue;
      }

      const accountId = row.accountId ?? input.defaultAccountId ?? null;
      if (accountId === null) {
        reject(
          label,
          CaptureRejectionCode.VALIDATION_FAILED,
          'A row with no accountId needs a defaultAccountId on the request.',
          'accountId',
        );
        continue;
      }

      let occurrence: { occurredAt: Date; occurredLocalDate: Date };
      try {
        occurrence = this.resolveOccurrence(
          row.occurredAt ?? input.occurredAt ?? null,
          row.occurredOn ?? input.occurredLocalDate ?? null,
          timeZone,
        );
      } catch (error) {
        if (error instanceof ApiError) {
          reject(label, CaptureRejectionCode.VALIDATION_FAILED, error.message, 'occurredOn');
          continue;
        }
        throw error;
      }

      occurrenceFor.set(label, occurrence);
      accountFor.set(label, accountId);
      if (row.categoryId) categoryIds.add(row.categoryId);
      if (row.merchantId) merchantIds.add(row.merchantId);
      if (row.counterpartyId) counterpartyIds.add(row.counterpartyId);
      for (const tagId of row.tagIds ?? []) tagIds.add(tagId);
      if (row.acceptedProposalId) proposalIds.add(row.acceptedProposalId);
    }

    const discardIds = [...new Set(input.discardProposalIds ?? [])];
    for (const decisionId of discardIds) proposalIds.add(decisionId);

    // ---- batch existence checks: one query per table, never one per row ----
    //
    // Deliberately NOT preceded by a throw. docs/06 §5.2.1 says the payload names **every** offending
    // row, and throwing after the in-memory phase would report only the rows with a bad amount and
    // hide the ones with an unknown category — the caller would fix one, resubmit, and be told about
    // the next. Every phase accumulates; exactly one throw happens at the end.
    const [accountIds, categories, merchants, counterparties, unknownTags] = await Promise.all([
      this.existingIds('accounts', [...new Set(accountFor.values())]),
      this.categoryKinds([...categoryIds]),
      this.existingIds('merchants', [...merchantIds]),
      this.existingIds('counterparties', [...counterpartyIds]),
      this.tags.unknownAssignable([...tagIds]),
    ]);

    for (const row of pending) {
      const label = row.clientRowId.trim();
      if (rejectedRowIds.has(label)) continue;
      const accountId = accountFor.get(label);
      if (accountId !== undefined && !accountIds.has(accountId)) {
        reject(
          label,
          CaptureRejectionCode.NOT_FOUND,
          'Account not found in this Household.',
          'accountId',
        );
        continue;
      }

      if (row.categoryId) {
        const kind = categories.get(row.categoryId);
        if (kind === undefined) {
          reject(label, CaptureRejectionCode.NOT_FOUND, 'Category not found.', 'categoryId');
          continue;
        }
        if (kind !== row.kind) {
          // I-3: an expense must never land in an income category.
          reject(
            label,
            CaptureRejectionCode.VALIDATION_FAILED,
            `That category classifies ${kind.toLowerCase()} but the row is ${row.kind.toLowerCase()} ` +
              `(invariant I-3).`,
            'categoryId',
          );
          continue;
        }
      }

      if (row.merchantId && !merchants.has(row.merchantId)) {
        reject(label, CaptureRejectionCode.NOT_FOUND, 'Merchant not found.', 'merchantId');
        continue;
      }
      if (row.counterpartyId && !counterparties.has(row.counterpartyId)) {
        reject(label, CaptureRejectionCode.NOT_FOUND, 'Counterparty not found.', 'counterpartyId');
        continue;
      }
      const badTags = (row.tagIds ?? []).filter((tagId) => unknownTags.includes(tagId));
      if (badTags.length > 0) {
        reject(
          label,
          CaptureRejectionCode.NOT_FOUND,
          `Unknown tag(s): ${badTags.join(', ')}. A tag must belong to this Household (docs/01 F-12).`,
          'tagIds',
        );
      }
    }

    // ---- the preview proposals this commit echoes ----
    const decisions = await this.classification.decisionsByIds(householdId, [...proposalIds]);
    for (const decisionId of discardIds) {
      const snapshot = decisions.get(decisionId);
      if (snapshot === undefined) {
        rejected.push({
          clientRowId: decisionId,
          code: CaptureRejectionCode.NOT_FOUND,
          message: 'Discarded proposal not found in this Household.',
          field: 'discardProposalIds',
        });
        continue;
      }
      if (snapshot.transactionId !== null) {
        rejected.push({
          clientRowId: decisionId,
          code: CaptureRejectionCode.CONFLICT,
          message: 'That proposal was already committed, so it cannot be discarded.',
          field: 'discardProposalIds',
        });
      }
    }

    for (const row of pending) {
      const acceptedId = row.acceptedProposalId;
      if (!acceptedId) continue;
      if (rejectedRowIds.has(row.clientRowId.trim())) continue;
      const snapshot = decisions.get(acceptedId);
      if (snapshot === undefined) {
        reject(
          row.clientRowId,
          CaptureRejectionCode.NOT_FOUND,
          'That proposal is not one this Household can see.',
          'acceptedProposalId',
        );
        continue;
      }
      if (snapshot.transactionId !== null) {
        reject(
          row.clientRowId,
          CaptureRejectionCode.CONFLICT,
          'That proposal was already committed.',
          'acceptedProposalId',
        );
        continue;
      }
      if (input.parseId && snapshot.parseId !== null && snapshot.parseId !== input.parseId) {
        // Committing a proposal against a *different* preview means the user is confirming something
        // they were not shown, which is the one thing the preview exists to prevent.
        reject(
          row.clientRowId,
          CaptureRejectionCode.VALIDATION_FAILED,
          'That proposal came from a different preview than the one this commit names.',
          'acceptedProposalId',
        );
      }
    }

    // ---- rows with neither a proposal nor an override are classified now ----
    const unclassified = pending.filter(
      (row) => !row.categoryId && !row.acceptedProposalId,
    );
    for (const row of unclassified) {
      if (rejectedRowIds.has(row.clientRowId.trim())) continue;
      if ((row.description ?? '').trim() === '') {
        reject(
          row.clientRowId,
          CaptureRejectionCode.VALIDATION_FAILED,
          'A row with no category and no proposal needs a description to classify.',
          'description',
        );
      }
    }
    // The single throw. Every phase above accumulated, so the caller is told about every row it must
    // fix in one round trip rather than discovering them one at a time.
    if (rejected.length > 0) throw this.rejection(orderedRejections());

    const localDay =
      input.occurredLocalDate ?? todayIn(timeZone, input.occurredAt ?? new Date());
    const fresh =
      unclassified.length === 0
        ? []
        : await this.classification.classifyForCommit(
            householdId,
            unclassified.map((row) => ({ rawText: (row.description ?? '').trim() })),
            {
              allowAi: input.allowAi ?? true,
              occurredAt: input.occurredAt ?? null,
              localDay,
            },
          );
    const freshByRowId = new Map(
      unclassified.map((row, index) => [row.clientRowId, fresh[index]!] as const),
    );

    // ---- the gate, then the write ----
    const resolutions: CaptureResolution[] = [];
    for (const row of pending) {
      const label = row.clientRowId.trim();
      const snapshot = row.acceptedProposalId
        ? (decisions.get(row.acceptedProposalId) ?? null)
        : null;
      const classified = freshByRowId.get(row.clientRowId) ?? null;

      const resolution = await this.resolveRow(householdId, {
        row,
        snapshot,
        classified,
        thresholds,
      });
      resolutions.push({ ...resolution, clientRowId: label, occurrence: occurrenceFor.get(label)! });
    }

    const discardedIds = discardIds.filter((id) => decisions.has(id));

    const written = await this.prisma.client.$transaction(async (tx) => {
      const results: CaptureCommittedRow[] = [];

      for (const resolution of resolutions) {
        const { row } = resolution;
        const created = await tx.transactions.create({
          data: {
            id: uuidv7(),
            household_id: householdId,
            account_id: accountFor.get(resolution.clientRowId)!,
            kind: row.kind,
            amount_minor: row.amount.amountMinor,
            currency,
            category_id: resolution.categoryId,
            merchant_id: row.merchantId ?? null,
            counterparty_id: row.counterpartyId ?? null,
            description: resolution.description,
            note: row.note ?? null,
            raw_input: resolution.rawText,
            occurred_at: resolution.occurrence.occurredAt,
            occurred_local_date: resolution.occurrence.occurredLocalDate,
            status: resolution.status,
            // Captured input is a natural-language capture, not a hand-keyed row: the distinction is
            // what lets analytics separate the wedge from manual entry (docs/03 §4).
            source: TransactionSource.NATURAL_LANGUAGE,
            category_source: resolution.categorySource,
            // `numeric(4,3)` as a decimal string — a calibrated probability, three decimals.
            confidence: resolution.confidence.toFixed(3),
            needs_review: resolution.needsReview,
            idempotency_key: row.idempotencyKey,
            client_id: row.clientId ?? null,
            ...(row.tagIds?.length
              ? { transaction_tags: { create: [...new Set(row.tagIds)].map((tagId) => ({ tag_id: tagId })) } }
              : {}),
          },
          include: { transaction_splits: true, transaction_tags: { include: { tags: true } } },
        });

        // Same connection as the write, so the audit link and the money commit together or not at
        // all. `db` is the `tx` — using the outer client here is the stall this codebase has already
        // been bitten by (see AGENTS.md).
        await this.classification.attachToTransaction(
          householdId,
          resolution.decisionId,
          created.id,
          resolution.outcome,
          tx,
        );

        results.push({
          clientRowId: resolution.clientRowId,
          transaction: this.toModel(created),
          idempotencyKey: row.idempotencyKey,
          wasReplayed: false,
          decisionId: resolution.decisionId,
        });
      }

      if (discardedIds.length > 0) {
        await this.classification.markDiscarded(householdId, discardedIds, tx);
      }

      return results;
    });

    committed.push(...written);

    // docs/06 §5.2.2's third mechanism. Read-only and advisory: the rows are already committed, and
    // nothing here can un-commit them. A failure to compute a suspect must therefore not fail the
    // capture — the money is fine and a missing chip is not worth losing an entry over.
    const duplicateSuspects = await this.findDuplicateSuspects(householdId, written);

    const reviewQueueCount = await this.prisma.client.transactions.count({
      where: { household_id: householdId, needs_review: true, deleted_at: null },
    });

    const cursor = committed
      .map((row) => row.transaction.id)
      .sort()
      .at(-1);

    return {
      committed,
      skipped: [],
      duplicateSuspects,
      // docs/06 §5.2: true only when the *whole* call was a replay. A mixed batch wrote something, so
      // it is not a replay however many of its rows were.
      replayed: committed.length > 0 && committed.every((row) => row.wasReplayed),
      cursor: cursor ?? '',
      reviewQueueCount,
    };
  }

  /**
   * `undoCapture` — soft-delete the Transactions a commit just wrote (docs/02 §3's undo toast).
   *
   * **One call, and all-or-nothing.** The client holds the ids from the commit response, and undoing a
   * toast that only half-applied would be worse than not offering it: the user would be left with two
   * rows instead of three and no way to tell which. So the ids are validated first and the delete is
   * one `updateMany` inside a transaction.
   *
   * **Soft, never hard** (docs/03 §3.4): `deleted_at` is set, the row and its audit trail survive, and
   * a later Restore is a matter of clearing the column. Financial rows are never destroyed by a
   * mis-tap.
   *
   * `household_id` is in the predicate as well as in the ids, so an id from another Household matches
   * nothing rather than deleting someone else's row, and the count returned is the honest "how many
   * were actually undone" rather than "how many you named".
   */
  async undoCapture(householdId: string, transactionIds: readonly string[]): Promise<number> {
    const ids = [...new Set(transactionIds)];
    if (ids.length === 0) throw new ApiError('VALIDATION_FAILED', 'Nothing to undo.');

    const now = new Date();
    return this.prisma.client.$transaction(async (tx) => {
      const result = await tx.transactions.updateMany({
        where: { id: { in: ids }, household_id: householdId, deleted_at: null },
        data: { deleted_at: now, updated_at: now },
      });
      return result.count;
    });
  }

  /**
   * Find the duplicate suspects among rows a commit just wrote.
   *
   * **One extra query for the whole batch**, not one per row: the comparison set is bounded by the
   * submission window, the accounts involved, the amounts involved and a ±2-day date span, so a single
   * read returns every candidate any row could match.
   *
   * The just-written rows are *inside* that set, which is deliberate — two identical rows in one batch
   * are the clearest duplicate there is, and excluding them would miss exactly the mistake a bulk
   * entry makes. `findDuplicateSubject` never matches a row against itself.
   */
  private async findDuplicateSuspects(
    householdId: string,
    written: readonly CaptureCommittedRow[],
  ): Promise<DuplicateSuspectRow[]> {
    const subjects = written.filter((row) => !row.wasReplayed);
    if (subjects.length === 0) return [];

    const oldest = Math.min(...subjects.map((row) => row.transaction.createdAt.getTime()));
    const days = subjects.map((row) => row.transaction.occurredLocalDate);
    const pad = (day: string, by: number): Date => {
      const shifted = new Date(`${day}T00:00:00.000Z`);
      shifted.setUTCDate(shifted.getUTCDate() + by);
      return shifted;
    };
    const sortedDays = [...days].sort();

    const candidates = await this.prisma.client.transactions.findMany({
      where: {
        household_id: householdId,
        deleted_at: null,
        // `<> VOID`, not `= CONFIRMED` — a deliberate correction to docs/06 §5.2.2, recorded there.
        //
        // The spec said `CONFIRMED`, and taken literally that makes this mechanism unreachable for
        // exactly the household that needs it most: with no keywords, no rules and no AI provider
        // (F-13's cold start, and every fresh signup today) *every* captured row is written PENDING,
        // so there would never be a candidate and a user could type `Lidl 2000` twice in a row with no
        // warning at all. Status is not what makes a row a duplicate — the user's two keystrokes are —
        // and a PENDING row is still money the user recorded (I-7 excludes it from derived figures, not
        // from the ledger's own history).
        //
        // VOID stays excluded: the user has said that row never happened, so resemblance to it is not
        // a reason to warn about anything.
        status: { not: TransactionStatus.VOID },
        account_id: { in: [...new Set(subjects.map((row) => row.transaction.accountId))] },
        kind: { in: [...new Set(subjects.map((row) => row.transaction.kind))] },
        amount_minor: { in: [...new Set(subjects.map((row) => row.transaction.amount.amountMinor))] },
        created_at: { gte: new Date(oldest - DUPLICATE_SUBMISSION_WINDOW_MS) },
        occurred_local_date: {
          gte: pad(sortedDays[0]!, -DUPLICATE_DATE_TOLERANCE_DAYS),
          lte: pad(sortedDays[sortedDays.length - 1]!, DUPLICATE_DATE_TOLERANCE_DAYS),
        },
      },
      include: { transaction_splits: true, transaction_tags: { include: { tags: true } } },
    });

    const pool: DuplicateCandidate[] = candidates.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      kind: row.kind,
      amountMinor: row.amount_minor,
      occurredLocalDate: row.occurred_local_date.toISOString().slice(0, 10),
      description: row.description,
      merchantId: row.merchant_id,
      createdAt: row.created_at,
    }));
    const byId = new Map(candidates.map((row) => [row.id, row]));

    const suspects: DuplicateSuspectRow[] = [];
    for (const row of subjects) {
      const transaction = row.transaction;
      const match = findDuplicateSubject({
        subject: {
          transactionId: transaction.id,
          accountId: transaction.accountId,
          kind: transaction.kind,
          amountMinor: transaction.amount.amountMinor,
          occurredLocalDate: transaction.occurredLocalDate,
          // The stored description, not the user's draft: they may have edited it after the preview,
          // and the row is what future comparisons will see.
          description: transaction.description,
          merchantId: transaction.merchantId,
          createdAt: transaction.createdAt,
        },
        candidates: pool,
      });

      if (match === null) continue;
      const existing = byId.get(match.existingTransactionId);
      if (existing === undefined) continue;

      suspects.push({
        clientRowId: row.clientRowId,
        transactionId: transaction.id,
        existingTransactionId: existing.id,
        existingTransaction: this.toModel(existing),
        similarity: match.similarity,
        matchedOn: match.matchedOn,
      });
    }

    return suspects;
  }

  /**
   * Decide a row's category, the decision row behind it, and the gate's verdict.
   *
   * Three sources, in the order the user's intent outranks the machine's: an explicit override, the
   * proposal the preview produced, then a fresh classification. Each writes or reuses exactly one
   * `classification_decisions` row, so every committed Transaction has an answer to "why that
   * category?" (F-31) — including the ones the user chose by hand.
   */
  private async resolveRow(
    householdId: string,
    args: {
      readonly row: CaptureCommitRow;
      readonly snapshot: DecisionSnapshot | null;
      readonly classified: FragmentResult | null;
      readonly thresholds: { readonly autoApplyMin: number; readonly verifyMin: number };
    },
  ): Promise<Omit<CaptureResolution, 'clientRowId' | 'occurrence'>> {
    const { row, snapshot, classified } = args;

    let categoryId: string | null;
    let confidence: CalibratedConfidence;
    let categorySource: CategorySource | null;
    let fromAi = false;
    let decisionId: string;
    let outcome: DecisionOutcome;
    let description: string;

    if (row.categoryId) {
      categoryId = row.categoryId;
      // 1.000 is not a model claim: the user asserted this category, and the lane it lands in means
      // no review prompt for a decision a human just made.
      confidence = calibratedConfidenceFromStorage(1);
      categorySource = CategorySource.USER;
      description = (row.description ?? snapshot?.rawInput ?? '').trim();
      if (snapshot !== null) {
        decisionId = snapshot.id;
        outcome = 'OVERRIDDEN';
      } else {
        decisionId = await this.classification.recordUserChoice(householdId, {
          rawText: description || row.categoryId,
          categoryId,
        });
        outcome = 'ACCEPTED';
      }
    } else if (snapshot !== null) {
      categoryId = snapshot.categoryId;
      confidence = calibratedConfidenceFromStorage(snapshot.confidence ?? 0);
      categorySource = categorySourceFor(snapshot.decidedBy);
      fromAi = snapshot.decidedBy === 'AI';
      decisionId = snapshot.id;
      outcome = 'ACCEPTED';
      description = (row.description ?? snapshot.rawInput).trim();
    } else {
      if (classified === null) {
        // Unreachable: every row without a proposal was classified above. Failing loudly beats
        // writing an uncategorised row that looks like a deliberate choice.
        throw new ApiError('INTERNAL', 'A commit row reached the write with no classification.');
      }
      categoryId = classified.categoryId;
      confidence = calibratedConfidenceFromStorage(classified.confidence);
      // `FragmentResult.categorySource` is the parser's two-arm vocabulary (`RULE`/`AI`/null), while
      // `transactions.category_source` also has USER/IMPORT/DEFAULT. Mapped explicitly so a new arm
      // on either side is a compile error rather than a silently stored string.
      categorySource =
        classified.categorySource === 'RULE'
          ? CategorySource.RULE
          : classified.categorySource === 'AI'
            ? CategorySource.AI
            : null;
      fromAi = classified.decidedBy === 'AI';
      decisionId = classified.decisionId;
      outcome = 'ACCEPTED';
      description = (row.description ?? classified.description).trim();
    }

    if (description === '') {
      throw new ApiError('VALIDATION_FAILED', 'A description is required.');
    }

    const gate = applyConfidenceGate({
      categoryId,
      confidence,
      fromAi,
      thresholds: args.thresholds,
    });

    // docs/06 §5.2.1's table, with one correction recorded in the docs: the 0.60–0.89 band is the
    // ADVISORY lane, which never sets `needs_review` — I-8 defines that flag as the blocking lane
    // only, so §5.2.1's "needs_review = true" for that band contradicted the invariant.
    let status: TransactionStatus = gate.needsReview
      ? TransactionStatus.PENDING
      : TransactionStatus.CONFIRMED;
    let needsReview = gate.needsReview;

    if (needsReview && categoryId !== null && row.confirmDespiteLowConfidence === true) {
      // I-8's "unless a user explicitly cleared the flag". A null category is NOT clearable: an
      // uncategorised Transaction is an unanswered question, not a low-confidence answer.
      status = TransactionStatus.CONFIRMED;
      needsReview = false;
    }

    return {
      row,
      categoryId,
      confidence,
      categorySource,
      decisionId,
      outcome,
      description,
      rawText: (snapshot?.rawInput ?? classified?.rawText ?? row.description ?? '').trim(),
      status,
      needsReview,
    };
  }

  /** The replay lookup behind I-10 and offline dedupe (docs/06 §5.2.2). */
  private async findReplays(
    householdId: string,
    rows: readonly CaptureCommitRow[],
  ): Promise<{
    readonly transactions: ReadonlyMap<string, TransactionRowShape>;
    readonly for: (row: CaptureCommitRow) => TransactionRowShape | null;
  }> {
    const keys = [...new Set(rows.map((row) => row.idempotencyKey).filter(Boolean))];
    const clientIds = [
      ...new Set(rows.map((row) => row.clientId).filter((value): value is string => Boolean(value))),
    ];

    const byKey = new Map<string, TransactionRowShape>();
    const byClientId = new Map<string, TransactionRowShape>();
    const byId = new Map<string, TransactionRowShape>();

    if (keys.length > 0 || clientIds.length > 0) {
      const existing = await this.prisma.client.transactions.findMany({
        where: {
          household_id: householdId,
          deleted_at: null,
          OR: [
            ...(keys.length > 0 ? [{ idempotency_key: { in: keys } }] : []),
            ...(clientIds.length > 0 ? [{ client_id: { in: clientIds } }] : []),
          ],
        },
        include: { transaction_splits: true, transaction_tags: { include: { tags: true } } },
      });

      for (const row of existing) {
        if (row.idempotency_key) byKey.set(row.idempotency_key, row);
        if (row.client_id) byClientId.set(row.client_id, row);
        byId.set(row.id, row);
      }
    }

    return {
      transactions: byId,
      for: (row) =>
        (row.idempotencyKey ? byKey.get(row.idempotencyKey) : undefined) ??
        (row.clientId ? byClientId.get(row.clientId) : undefined) ??
        null,
    };
  }

  /**
   * One `id IN (…)` existence query for a plain household-scoped table.
   *
   * `$transaction` is not the only thing Prisma's generated client type makes awkward — a generic
   * helper over `findMany` cannot be typed without re-deriving Prisma's argument generics, so the
   * four call sites are named explicitly instead. One switch, four two-line branches.
   */
  private async existingIds(
    model: 'accounts' | 'merchants' | 'counterparties',
    ids: readonly string[],
  ): Promise<Set<string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Set();
    const where = { id: { in: unique }, deleted_at: null };

    if (model === 'accounts') {
      const found = await this.prisma.client.accounts.findMany({ where, select: { id: true } });
      return new Set(found.map((row) => row.id));
    }
    if (model === 'merchants') {
      // Global-readable: the guard widens this read to include the seeded catalogue, which is exactly
      // what makes a merchant the app shipped resolvable on the first capture (docs/08 Layer 2).
      const found = await this.prisma.client.merchants.findMany({ where, select: { id: true } });
      return new Set(found.map((row) => row.id));
    }
    const found = await this.prisma.client.counterparties.findMany({ where, select: { id: true } });
    return new Set(found.map((row) => row.id));
  }

  /** Category id → kind, for invariant I-3. */
  private async categoryKinds(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const found = await this.prisma.client.categories.findMany({
      where: { id: { in: [...ids] }, deleted_at: null },
      select: { id: true, kind: true },
    });
    return new Map(found.map((row) => [row.id, row.kind]));
  }

  private rejection(rows: readonly CaptureRejectedRow[]): CaptureCommitRejected {
    // The request-level code is the rows' own code when they agree, and `VALIDATION_FAILED` when they
    // do not — a mixed batch is a validation problem, and reporting one row's `NOT_FOUND` as the
    // request's code would mislead a client that branches on it.
    const codes = new Set(rows.map((row) => row.code));
    // The per-row detail is already in `rows`; it is repeated in the message because a thrown error
    // is what a log line shows, and "3 rows could not be committed" alone makes a rejection
    // impossible to diagnose from the logs.
    const detail = rows
      .slice(0, 3)
      .map((row) => `${row.clientRowId}${row.field ? `.${row.field}` : ''}: ${row.message}`)
      .join(' | ');
    return new CaptureCommitRejected(
      rows,
      codes.size === 1 ? [...codes][0]! : CaptureRejectionCode.VALIDATION_FAILED,
      `${rows.length} row(s) could not be committed, so none were. ${detail}`,
    );
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

    // Validated before either write, so a bad id can never leave a half-applied update. Present is
    // an instruction; absent is not (see `UpdateTransactionInput.tagIds`).
    const tagIds = input.tagIds === undefined ? undefined : [...new Set(input.tagIds)];
    if (tagIds) await this.tags.assertAssignable(tagIds);

    const household = await this.prisma.client.households.findFirst({ where: { id: householdId } });
    const timeZone = household?.iana_timezone || DEFAULT_TIME_ZONE;

    // `resolveOccurrence` prefers `occurredLocalDate` when both are sent. Two sources of truth for
    // the day would otherwise disagree silently, and the client-asserted calendar day is the one
    // the user actually picked.
    const occurrence =
      input.occurredLocalDate != null || input.occurredAt !== undefined
        ? this.resolveOccurrence(input.occurredAt, input.occurredLocalDate, timeZone)
        : null;

    // The Tag set is a relation write, so it needs `update` rather than `updateMany` — Prisma
    // refuses a nested relation write inside `updateMany`'s data. Both statements run on one
    // interactive transaction so the field edit and the assignment cannot half-apply, and every
    // statement inside it uses the `tx` the callback receives: the outer client would wait for a
    // second connection from the same pool and stall until the transaction timed out, surfacing only
    // as an opaque INTERNAL.
    //
    // The version predicate stays on the `updateMany`, which is the row lock as well as the check;
    // the relation write then targets that same, now-current row without re-asserting the version.
    await this.prisma.client.$transaction(async (tx) => {
      const fields = {
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
      };

      const updated = await tx.transactions.updateMany({
        where: { id, household_id: householdId, version: input.version },
        data: fields,
      });

      // The WHERE carried the version, so zero rows means somebody else won the race.
      if (updated.count === 0) {
        throw new ApiError('CONFLICT', 'This transaction was changed somewhere else. Reload it.');
      }

      // Replaced wholesale rather than added to, because that is what makes the chip editor and the
      // stored row agree — and an empty array is a deliberate "remove them all", not an omission.
      if (tagIds !== undefined) {
        await tx.transactions.update({
          where: { id },
          data: {
            transaction_tags: { deleteMany: {}, create: tagIds.map((tagId) => ({ tag_id: tagId })) },
          },
        });
      }
    });

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

  private toModel(row: TransactionRowShape): TransactionModel {
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
      tags: (row.transaction_tags ?? [])
        .map((join) => ({
          id: join.tags.id,
          name: join.tags.name,
          color: join.tags.color,
          // Read here is a label, not a report: `TagModel.transactionCount` is meaningful on
          // `tags`/`tag`, where the Tag is the subject. Counting each attached Tag per Transaction
          // would be N grouped queries to render a chip that never shows the number.
          transactionCount: 0,
          createdAt: join.tags.created_at,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
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
