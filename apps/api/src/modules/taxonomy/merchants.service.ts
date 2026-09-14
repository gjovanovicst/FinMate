import { Injectable } from '@nestjs/common';

import { pathTo, uuidv7 } from '@finmate/domain';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import { normaliseForMatching } from '../../common/text/normalise';
import { normalisePageSize, type CursorPage } from '../../graphql/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { MerchantModel } from './merchant.model';

export interface MerchantInput {
  readonly name?: string;
  readonly defaultCategoryId?: string | null;
  readonly aiHint?: string | null;
}

/**
 * Merchants (docs/01 F-10, F-13).
 *
 * Two things make this module different from Categories, and both come from the table holding
 * platform content alongside the Household's own rows (`household_id` nullable, `is_global`):
 *
 *  - **Seeds are copy-on-write.** A global row is read-only, so editing one would either fail or
 *    silently change the catalogue for every other Household. Instead the edit produces a
 *    Household-owned copy and the Household's own references move to it — which is what the user
 *    meant, and what makes the change visible on their history rather than only on future rows.
 *  - **Merge is the deletion path for a Merchant in use.** A Merchant referenced by Transactions is
 *    never deleted outright; the references are moved to another Merchant first. That is the same
 *    shape as Category deletion (I-12) and it is why there is no "unset the merchant" option: which
 *    other shop the spending belongs to is a question only the user can answer.
 *
 * The tenancy guard supplies the read scope (own rows OR global ones) and keeps every write strictly
 * Household-scoped, so nothing here has to re-derive that (ADR-008).
 */
@Injectable()
export class MerchantsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    householdId: string,
    filters: { search?: string },
    page: { first?: number; after?: string },
  ): Promise<CursorPage<MerchantModel>> {
    const take = normalisePageSize(page.first);
    const where = {
      deleted_at: null,
      ...(filters.search
        ? { name: { contains: filters.search, mode: 'insensitive' as const } }
        : {}),
      ...(page.after ? { id: { lt: page.after } } : {}),
    };

    const [rows, totalCount] = await Promise.all([
      this.prisma.client.merchants.findMany({
        where,
        // Own rows first: a Household's own copy is the one it edited, so it should not be buried
        // under the ~60 seeded rows. `household_id: desc` puts non-null before null in Postgres.
        orderBy: [{ household_id: 'desc' }, { name: 'asc' }],
        take: take + 1,
        include: { merchant_aliases: true },
      }),
      this.prisma.client.merchants.count({ where: { ...where, ...(page.after ? {} : {}) } }),
    ]);

    const hasNextPage = rows.length > take;
    const page_ = hasNextPage ? rows.slice(0, take) : rows;
    const [counts, paths] = await Promise.all([
      this.transactionCounts(page_.map((row) => row.id)),
      this.categoryPaths(page_.map((row) => row.default_category_id)),
    ]);
    const items = page_.map((row) =>
      this.toModel(row, householdId, counts.get(row.id) ?? 0, paths),
    );

    return { items, totalCount, hasNextPage, endCursor: items.at(-1)?.id ?? null };
  }

  async getById(householdId: string, id: string): Promise<MerchantModel> {
    const row = await this.prisma.client.merchants.findFirst({
      where: { id, deleted_at: null },
      include: { merchant_aliases: true },
    });
    if (!row) throw new ApiError('NOT_FOUND', 'Merchant not found.');
    const [counts, paths] = await Promise.all([
      this.transactionCounts([id]),
      this.categoryPaths([row.default_category_id]),
    ]);
    return this.toModel(row, householdId, counts.get(id) ?? 0, paths);
  }

  /**
   * Create a Household-owned Merchant.
   *
   * A name that folds to one already visible is refused rather than stored: two rows differing only
   * by case or an accent would split one shop's history in two, and the classifier would have to
   * pick between them arbitrarily.
   */
  async create(householdId: string, input: MerchantInput & { name: string }): Promise<MerchantModel> {
    const name = input.name.trim();
    if (name === '') throw new ApiError('VALIDATION_FAILED', 'A merchant name is required.');
    await this.assertNameFree(name, null);
    if (input.defaultCategoryId) await this.requireCategory(input.defaultCategoryId);

    const created = await this.prisma.client.merchants.create({
      data: {
        id: uuidv7(),
        name,
        default_category_id: input.defaultCategoryId ?? null,
        ai_hint: input.aiHint?.trim() || null,
      },
      include: { merchant_aliases: true },
    });
    return this.toModel(created, householdId, 0, await this.categoryPaths([created.default_category_id]));
  }

  /**
   * Update a Merchant, copying a global seed on first write.
   *
   * The copy takes over the Household's references, so a corrected default Category applies to the
   * spending the user can already see. Without that step the edit would look like it did nothing.
   */
  async update(householdId: string, id: string, input: MerchantInput): Promise<MerchantModel> {
    const existing = await this.requireVisible(id);
    if (input.defaultCategoryId) await this.requireCategory(input.defaultCategoryId);
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name === '') throw new ApiError('VALIDATION_FAILED', 'A merchant name is required.');
      await this.assertNameFree(name, id);
    }

    const target =
      existing.household_id === null
        ? await this.copyOnWrite(existing)
        : existing;

    const updated = await this.prisma.client.merchants.update({
      where: { id: target.id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.defaultCategoryId !== undefined
          ? { default_category_id: input.defaultCategoryId }
          : {}),
        ...(input.aiHint !== undefined ? { ai_hint: input.aiHint?.trim() || null } : {}),
        updated_at: new Date(),
      },
      include: { merchant_aliases: true },
    });

    const [counts, paths] = await Promise.all([
      this.transactionCounts([updated.id]),
      this.categoryPaths([updated.default_category_id]),
    ]);
    return this.toModel(updated, householdId, counts.get(updated.id) ?? 0, paths);
  }

  /**
   * Replace the alias list.
   *
   * Replace rather than add/remove: the editor shows the whole set, so sending the whole set is what
   * makes the screen and the row agree. A partial API would need the client to decide which of its
   * edits were real, which is how a removed alias comes back.
   */
  async setAliases(
    householdId: string,
    id: string,
    aliases: readonly string[],
  ): Promise<MerchantModel> {
    const existing = await this.requireVisible(id);
    const target = existing.household_id === null ? await this.copyOnWrite(existing) : existing;

    const folded = [...new Set(aliases.map(normaliseForMatching).filter((alias) => alias !== ''))];

    const updated = await this.prisma.client.merchants.update({
      where: { id: target.id },
      data: {
        // Nested writes, because `merchant_aliases` has no household_id and the tenancy guard
        // refuses to touch it directly — it is reachable only through its parent.
        merchant_aliases: {
          deleteMany: {},
          create: folded.map((alias) => ({ id: uuidv7(), alias })),
        },
        updated_at: new Date(),
      },
      include: { merchant_aliases: true },
    });

    const [counts, paths] = await Promise.all([
      this.transactionCounts([updated.id]),
      this.categoryPaths([updated.default_category_id]),
    ]);
    return this.toModel(updated, householdId, counts.get(updated.id) ?? 0, paths);
  }

  /**
   * Delete a Merchant, refusing while anything still points at it.
   *
   * The refusal names merge as the way forward, because merging *is* the reassignment step: there is
   * no "no merchant" answer to give for spending that happened somewhere.
   */
  async remove(id: string): Promise<void> {
    const existing = await this.requireVisible(id);
    if (existing.household_id === null) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'This is a shipped merchant, so it cannot be deleted. Add your own merchant, or edit this ' +
          'one to make a private copy.',
      );
    }

    const [transactions, receipts, recurring] = await Promise.all([
      this.prisma.client.transactions.count({ where: { merchant_id: id, deleted_at: null } }),
      this.prisma.client.receipts.count({ where: { merchant_id: id, deleted_at: null } }),
      this.prisma.client.recurring_rules.count({ where: { merchant_id: id, deleted_at: null } }),
    ]);

    if (transactions + receipts + recurring > 0) {
      throw new ApiError(
        'CONFLICT',
        `This merchant is still in use (${transactions} transactions, ${receipts} receipts, ` +
          `${recurring} recurring rules). Merge it into another merchant to move them first.`,
      );
    }

    await this.prisma.client.merchants.update({
      where: { id },
      data: { deleted_at: new Date(), updated_at: new Date() },
    });
  }

  /**
   * Fold `sourceId` into `targetId`: move every reference, union the aliases, then delete the source.
   *
   * Refused in two directions. A global source cannot be deleted (it is platform content). A source
   * that is already the target is a no-op the caller almost certainly did not mean.
   */
  async merge(householdId: string, sourceId: string, targetId: string): Promise<MerchantModel> {
    if (sourceId === targetId) {
      throw new ApiError('VALIDATION_FAILED', 'A merchant cannot be merged into itself.');
    }

    const [source, visibleTarget] = await Promise.all([
      this.requireVisible(sourceId),
      this.requireVisible(targetId),
    ]);

    if (source.household_id === null) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'A shipped merchant cannot be merged away. Merge your own merchant into it instead.',
      );
    }

    // Merging into a shipped merchant is a write to it — the alias union has to be stored — and a
    // global row is read-only, so it would fail as an opaque P2025. Copy-on-write applies here for
    // the same reason it applies to an edit: the result is this Household's own "Lidl", carrying the
    // union, while the platform row stays as shipped.
    const target =
      visibleTarget.household_id === null
        ? await this.copyOnWrite(visibleTarget)
        : visibleTarget;
    const targetId2 = target.id;

    // Every statement runs on `tx`. Using the outer client inside an open interactive transaction
    // makes the inner query wait for a second connection from the same pool, which stalls until the
    // transaction times out — and the failure surfaces only as an opaque INTERNAL.
    await this.prisma.client.$transaction(async (tx) => {
      // The guard scopes every one of these to the Household, so a merge can never move another
      // Household's rows even if it guessed an id.
      await tx.transactions.updateMany({
        where: { merchant_id: sourceId },
        data: { merchant_id: targetId2 },
      });
      await tx.receipts.updateMany({
        where: { merchant_id: sourceId },
        data: { merchant_id: targetId2 },
      });
      await tx.recurring_rules.updateMany({
        where: { merchant_id: sourceId },
        data: { merchant_id: targetId2 },
      });

      // Union the aliases, so a spelling that only the source knew still resolves afterwards.
      const aliases = new Set([
        ...target.merchant_aliases.map((alias) => alias.alias),
        ...source.merchant_aliases.map((alias) => alias.alias),
      ]);
      await tx.merchants.update({
        where: { id: targetId2 },
        data: {
          merchant_aliases: {
            deleteMany: {},
            create: [...aliases].map((alias) => ({ id: uuidv7(), alias })),
          },
          updated_at: new Date(),
        },
      });

      await tx.merchants.update({
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
   * A Merchant the Household may reference: its own, or a global one.
   *
   * `findFirst`, not `findUnique` — the guard refuses `findUnique` on a scoped model because its
   * `where` cannot carry the tenant predicate (ADR-008).
   */
  private async requireVisible(id: string) {
    const row = await this.prisma.client.merchants.findFirst({
      where: { id, deleted_at: null },
      include: { merchant_aliases: true },
    });
    if (!row) throw new ApiError('NOT_FOUND', 'Merchant not found.');
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
   * Folding rather than exact matching, because "LIDL", "lidl" and "Lídl" are one shop, and letting
   * all three exist would split its history and leave the classifier choosing arbitrarily.
   */
  private async assertNameFree(name: string, exceptId: string | null): Promise<void> {
    const folded = normaliseForMatching(name);
    const candidates = await this.prisma.client.merchants.findMany({
      where: { deleted_at: null },
      select: { id: true, name: true },
    });
    const clash = candidates.find(
      (candidate) => candidate.id !== exceptId && normaliseForMatching(candidate.name) === folded,
    );
    if (clash) {
      throw new ApiError(
        'CONFLICT',
        `"${clash.name}" already exists. Merge into it instead of creating a duplicate.`,
      );
    }
  }

  /**
   * Create a Household-owned copy of a global Merchant and move the Household's references onto it.
   *
   * The references move because otherwise the copy is unreachable: the user's history would keep
   * pointing at the seed, and their edit would appear to have done nothing.
   */
  private async copyOnWrite(source: { id: string; name: string; default_category_id: string | null; ai_hint: string | null; merchant_aliases: { alias: string }[] }) {
    const copyId = uuidv7();

    await this.prisma.client.$transaction(async (tx) => {
      await tx.merchants.create({
        data: {
          id: copyId,
          name: source.name,
          default_category_id: source.default_category_id,
          ai_hint: source.ai_hint,
          is_global: false,
          merchant_aliases: {
            create: source.merchant_aliases.map((alias) => ({ id: uuidv7(), alias: alias.alias })),
          },
        },
      });

      await tx.transactions.updateMany({
        where: { merchant_id: source.id },
        data: { merchant_id: copyId },
      });
      await tx.receipts.updateMany({
        where: { merchant_id: source.id },
        data: { merchant_id: copyId },
      });
      await tx.recurring_rules.updateMany({
        where: { merchant_id: source.id },
        data: { merchant_id: copyId },
      });
    });

    return this.requireVisible(copyId);
  }

  /**
   * Breadcrumbs for the default Categories a page of Merchants points at.
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

  /** One grouped count for a page of Merchants, rather than a count per row. */
  private async transactionCounts(ids: readonly string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const grouped = await this.prisma.client.transactions.groupBy({
      by: ['merchant_id'],
      where: { merchant_id: { in: [...ids] }, deleted_at: null },
      _count: { _all: true },
    });
    return new Map(
      grouped
        .filter((row): row is typeof row & { merchant_id: string } => row.merchant_id !== null)
        .map((row) => [row.merchant_id, row._count._all]),
    );
  }

  private toModel(
    row: {
      id: string;
      household_id: string | null;
      name: string;
      default_category_id: string | null;
      ai_hint: string | null;
      is_global: boolean;
      created_at: Date;
      updated_at: Date;
      merchant_aliases: { id: string; merchant_id: string; alias: string }[];
    },
    householdId: string,
    transactionCount: number,
    paths: Map<string, string[]>,
  ): MerchantModel {
    return {
      id: row.id,
      name: row.name,
      defaultCategoryId: row.default_category_id,
      defaultCategoryPath: row.default_category_id
        ? (paths.get(row.default_category_id) ?? null)
        : null,
      aiHint: row.ai_hint,
      isGlobal: row.household_id === null,
      isOwnedByHousehold: row.household_id === householdId,
      aliases: row.merchant_aliases
        .map((alias) => ({ id: alias.id, merchantId: alias.merchant_id, alias: alias.alias }))
        .sort((a, b) => a.alias.localeCompare(b.alias)),
      transactionCount,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
