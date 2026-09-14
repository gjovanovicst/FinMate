import { Injectable } from '@nestjs/common';

import { pathTo, uuidv7 } from '@finmate/domain';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import { normaliseForMatching } from '../../common/text/normalise';
import { normalisePageSize, type CursorPage } from '../../graphql/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { CounterpartyModel, CounterpartyType } from './counterparty.model';

export interface CounterpartyInput {
  readonly name?: string;
  readonly type?: CounterpartyType;
  readonly defaultCategoryId?: string | null;
  readonly note?: string | null;
}

/**
 * Counterparties (docs/01 F-11).
 *
 * Simpler than Merchants in one structural way and identical in two behavioural ones:
 *
 *  - **No copy-on-write.** `counterparties.household_id` is `NOT NULL`, so there are no global rows
 *    and nothing to protect. Every row is the Household's own, which is why the copy-on-write
 *    machinery in `MerchantsService` is deliberately absent here — it exists there only because
 *    `merchants.household_id` is nullable.
 *  - **Name uniqueness folds.** `Dejan rođa` and `dejan roda` are one person, and F-11 exists
 *    precisely so two spellings of one person do not both exist. A name that folds to a visible one
 *    is refused with `CONFLICT`, pointing at the alias list and at merging.
 *  - **Merge is the deletion path.** A Counterparty referenced by a Transaction is never deleted
 *    outright; the references move first. Same shape as Merchant and Category deletion (I-12).
 *
 * The tenancy guard supplies the Household scope on every read and write; nothing here re-derives it
 * (ADR-008).
 */
@Injectable()
export class CounterpartiesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    householdId: string,
    filters: { search?: string },
    page: { first?: number; after?: string },
  ): Promise<CursorPage<CounterpartyModel>> {
    const take = normalisePageSize(page.first);
    const where = {
      household_id: householdId,
      deleted_at: null,
      ...(filters.search
        ? { name: { contains: filters.search, mode: 'insensitive' as const } }
        : {}),
      ...(page.after ? { id: { lt: page.after } } : {}),
    };

    const [rows, totalCount] = await Promise.all([
      this.prisma.client.counterparties.findMany({
        where,
        orderBy: [{ name: 'asc' }],
        take: take + 1,
        include: { counterparty_aliases: true },
      }),
      this.prisma.client.counterparties.count({ where: { ...where, ...(page.after ? {} : {}) } }),
    ]);

    const hasNextPage = rows.length > take;
    const page_ = hasNextPage ? rows.slice(0, take) : rows;
    const [counts, paths] = await Promise.all([
      this.transactionCounts(page_.map((row) => row.id)),
      this.categoryPaths(page_.map((row) => row.default_category_id)),
    ]);
    const items = page_.map((row) => this.toModel(row, counts.get(row.id) ?? 0, paths));

    return { items, totalCount, hasNextPage, endCursor: items.at(-1)?.id ?? null };
  }

  async getById(householdId: string, id: string): Promise<CounterpartyModel> {
    const row = await this.prisma.client.counterparties.findFirst({
      where: { id, household_id: householdId, deleted_at: null },
      include: { counterparty_aliases: true },
    });
    if (!row) throw new ApiError('NOT_FOUND', 'Counterparty not found.');
    const [counts, paths] = await Promise.all([
      this.transactionCounts([id]),
      this.categoryPaths([row.default_category_id]),
    ]);
    return this.toModel(row, counts.get(id) ?? 0, paths);
  }

  /**
   * Create a Counterparty.
   *
   * A name that folds to one already visible is refused rather than stored: two rows differing only
   * by case or an accent would split one person's history in two, and the classifier would have to
   * pick between them arbitrarily.
   */
  async create(
    householdId: string,
    input: CounterpartyInput & { name: string },
  ): Promise<CounterpartyModel> {
    const name = input.name.trim();
    if (name === '') throw new ApiError('VALIDATION_FAILED', 'A counterparty name is required.');
    await this.assertNameFree(name, null);
    if (input.defaultCategoryId) await this.requireCategory(input.defaultCategoryId);

    const created = await this.prisma.client.counterparties.create({
      data: {
        id: uuidv7(),
        // The tenant predicate is the guard's job, but the column is `NOT NULL` and Prisma's
        // unchecked create input wants it explicitly — so it is passed from the resolved context,
        // never from client input (ADR-008).
        household_id: householdId,
        name,
        type: input.type ?? CounterpartyType.PERSON,
        default_category_id: input.defaultCategoryId ?? null,
        note: input.note?.trim() || null,
      },
      include: { counterparty_aliases: true },
    });
    return this.toModel(
      created,
      0,
      await this.categoryPaths([created.default_category_id]),
    );
  }

  async update(householdId: string, id: string, input: CounterpartyInput): Promise<CounterpartyModel> {
    await this.requireVisible(id);
    if (input.defaultCategoryId) await this.requireCategory(input.defaultCategoryId);
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name === '') throw new ApiError('VALIDATION_FAILED', 'A counterparty name is required.');
      await this.assertNameFree(name, id);
    }

    const updated = await this.prisma.client.counterparties.update({
      where: { id, household_id: householdId },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.defaultCategoryId !== undefined
          ? { default_category_id: input.defaultCategoryId }
          : {}),
        ...(input.note !== undefined ? { note: input.note?.trim() || null } : {}),
        updated_at: new Date(),
      },
      include: { counterparty_aliases: true },
    });

    const [counts, paths] = await Promise.all([
      this.transactionCounts([updated.id]),
      this.categoryPaths([updated.default_category_id]),
    ]);
    return this.toModel(updated, counts.get(updated.id) ?? 0, paths);
  }

  /**
   * Replace the alias list.
   *
   * Replace rather than add/remove: the editor shows the whole set, so sending the whole set is what
   * makes the screen and the row agree. A partial API would need the client to decide which of its
   * edits were real, which is how a removed alias comes back. This is also where the two spellings
   * of one person are reconciled — `Dejan rođa` becomes an alias of the row that survived the
   * duplicate-name refusal.
   */
  async setAliases(
    householdId: string,
    id: string,
    aliases: readonly string[],
  ): Promise<CounterpartyModel> {
    await this.requireVisible(id);

    const folded = [...new Set(aliases.map(normaliseForMatching).filter((alias) => alias !== ''))];

    const updated = await this.prisma.client.counterparties.update({
      where: { id, household_id: householdId },
      data: {
        // Nested writes, because `counterparty_aliases` has no household_id and the tenancy guard
        // refuses to touch it directly — it is reachable only through its parent (ADR-008).
        counterparty_aliases: {
          deleteMany: {},
          create: folded.map((alias) => ({ id: uuidv7(), alias })),
        },
        updated_at: new Date(),
      },
      include: { counterparty_aliases: true },
    });

    const [counts, paths] = await Promise.all([
      this.transactionCounts([updated.id]),
      this.categoryPaths([updated.default_category_id]),
    ]);
    return this.toModel(updated, counts.get(updated.id) ?? 0, paths);
  }

  /**
   * Delete a Counterparty, refusing while anything still points at it.
   *
   * The refusal names merge as the way forward, because merging *is* the reassignment step: there is
   * no "no counterparty" answer to give for money that changed hands. Counts cover Transactions
   * only — `receipts` has no `counterparty_id` column (docs/03 §4), so there is nothing else that
   * can reference a Counterparty.
   */
  async remove(householdId: string, id: string): Promise<void> {
    await this.requireVisible(id);

    const transactions = await this.prisma.client.transactions.count({
      where: { counterparty_id: id, deleted_at: null },
    });

    if (transactions > 0) {
      throw new ApiError(
        'CONFLICT',
        `This counterparty is still in use (${transactions} transactions). Merge it into another ` +
          `counterparty to move them first.`,
      );
    }

    await this.prisma.client.counterparties.update({
      where: { id, household_id: householdId },
      data: { deleted_at: new Date(), updated_at: new Date() },
    });
  }

  /**
   * Fold `sourceId` into `targetId`: move every reference, union the aliases, then delete the
   * source.
   *
   * There is no shipped-row direction to refuse — a Counterparty is always Household-owned — so the
   * only guard is the self-merge, which is a no-op the caller almost certainly did not mean.
   */
  async merge(householdId: string, sourceId: string, targetId: string): Promise<CounterpartyModel> {
    if (sourceId === targetId) {
      throw new ApiError('VALIDATION_FAILED', 'A counterparty cannot be merged into itself.');
    }

    const [source, target] = await Promise.all([
      this.requireVisible(sourceId),
      this.requireVisible(targetId),
    ]);
    const targetId2 = target.id;

    // Every statement runs on `tx`. Using the outer client inside an open interactive transaction
    // makes the inner query wait for a second connection from the same pool, which stalls until the
    // transaction times out — and the failure surfaces only as an opaque INTERNAL.
    await this.prisma.client.$transaction(async (tx) => {
      // The guard scopes this to the Household, so a merge can never move another Household's rows
      // even if it guessed an id.
      await tx.transactions.updateMany({
        where: { counterparty_id: sourceId },
        data: { counterparty_id: targetId2 },
      });

      // Union the aliases, so a spelling that only the source knew still resolves afterwards.
      const aliases = new Set([
        ...target.counterparty_aliases.map((alias) => alias.alias),
        ...source.counterparty_aliases.map((alias) => alias.alias),
      ]);
      await tx.counterparties.update({
        where: { id: targetId2 },
        data: {
          counterparty_aliases: {
            deleteMany: {},
            create: [...aliases].map((alias) => ({ id: uuidv7(), alias })),
          },
          updated_at: new Date(),
        },
      });

      await tx.counterparties.update({
        where: { id: sourceId },
        data: { deleted_at: new Date(), updated_at: new Date() },
      });
    });

    return this.getById(householdId, targetId2);
  }

  // -------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------

  /**
   * A Counterparty the Household may reference.
   *
   * `findFirst`, not `findUnique` — the guard refuses `findUnique` on a scoped model because its
   * `where` cannot carry the tenant predicate (ADR-008).
   */
  private async requireVisible(id: string) {
    const row = await this.prisma.client.counterparties.findFirst({
      where: { id, deleted_at: null },
      select: {
        id: true,
        household_id: true,
        name: true,
        type: true,
        default_category_id: true,
        note: true,
        created_at: true,
        updated_at: true,
        counterparty_aliases: { select: { id: true, counterparty_id: true, alias: true } },
      },
    });
    if (!row) throw new ApiError('NOT_FOUND', 'Counterparty not found.');
    return row;
  }

  private async requireCategory(id: string): Promise<void> {
    const category = await this.prisma.client.categories.findFirst({
      where: { id, deleted_at: null },
      select: { id: true },
    });
    if (!category) throw new ApiError('VALIDATION_FAILED', 'That default category does not exist.');
  }

  /**
   * Refuse a name that folds to one already visible.
   *
   * Folding rather than exact matching, because "Dejan rođa", "dejan roda" and "DEJAN ROĐA" are one
   * person, and letting all three exist would split their history and leave the classifier choosing
   * arbitrarily.
   */
  private async assertNameFree(name: string, exceptId: string | null): Promise<void> {
    const folded = normaliseForMatching(name);
    const candidates = await this.prisma.client.counterparties.findMany({
      where: { deleted_at: null },
      select: { id: true, name: true },
    });
    const clash = candidates.find(
      (candidate) => candidate.id !== exceptId && normaliseForMatching(candidate.name) === folded,
    );
    if (clash) {
      throw new ApiError(
        'CONFLICT',
        `"${clash.name}" already exists. Add this spelling as an alias, or merge the two together.`,
      );
    }
  }

  /**
   * Breadcrumbs for the default Categories a page of Counterparties points at.
   *
   * Loaded once per request rather than per row, and only when something actually has a default: a
   * Category's path is a walk up its ancestors, which Prisma cannot include recursively.
   */
  private async categoryPaths(ids: readonly (string | null)[]): Promise<Map<string, string[]>> {
    const needed = [...new Set(ids.filter((id): id is string => id !== null))];
    if (needed.length === 0) return new Map();

    const categories = await this.prisma.client.categories.findMany({
      where: { deleted_at: null },
      select: { id: true, name: true, parent_id: true },
    });
    const byId = new Map(categories.map((category) => [category.id, category]));
    const nodes = categories.map((category) => ({ id: category.id, parentId: category.parent_id }));

    return new Map(
      needed.map((id) => [
        id,
        pathTo(nodes, id)
          .map((ancestorId) => byId.get(ancestorId)?.name ?? '')
          .filter((name) => name !== ''),
      ]),
    );
  }

  /** One grouped count for a page of Counterparties, rather than a count per row. */
  private async transactionCounts(ids: readonly string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const grouped = await this.prisma.client.transactions.groupBy({
      by: ['counterparty_id'],
      where: { counterparty_id: { in: [...ids] }, deleted_at: null },
      _count: { _all: true },
    });
    return new Map(
      grouped
        .filter((row): row is typeof row & { counterparty_id: string } => row.counterparty_id !== null)
        .map((row) => [row.counterparty_id, row._count._all]),
    );
  }

  private toModel(
    row: {
      id: string;
      name: string;
      type: string;
      default_category_id: string | null;
      note: string | null;
      created_at: Date;
      updated_at: Date;
      counterparty_aliases: { id: string; counterparty_id: string; alias: string }[];
    },
    transactionCount: number,
    paths: Map<string, string[]>,
  ): CounterpartyModel {
    return {
      id: row.id,
      name: row.name,
      type: row.type as CounterpartyType,
      defaultCategoryId: row.default_category_id,
      defaultCategoryPath: row.default_category_id
        ? (paths.get(row.default_category_id) ?? null)
        : null,
      note: row.note,
      aliases: row.counterparty_aliases
        .map((alias) => ({
          id: alias.id,
          counterpartyId: alias.counterparty_id,
          alias: alias.alias,
        }))
        .sort((a, b) => a.alias.localeCompare(b.alias)),
      transactionCount,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
