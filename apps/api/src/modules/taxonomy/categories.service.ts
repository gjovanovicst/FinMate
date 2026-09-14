import { Injectable } from '@nestjs/common';

import {
  depthOf,
  depthUnder,
  findTreeViolations,
  MAX_TREE_DEPTH,
  pathTo,
  subtreeHeight,
  uuidv7,
  wouldCreateCycle,
  type TreeNode,
} from '@finmate/domain';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import { PrismaService } from '../../prisma/prisma.service';
import { CategoryKind, KeywordPolarity, type CategoryModel } from './category.model';

export interface CreateCategoryInput {
  readonly name: string;
  readonly kind: CategoryKind;
  readonly parentId?: string | null;
  readonly icon?: string | null;
  readonly color?: string | null;
  readonly aiDescription?: string | null;
}

export interface UpdateCategoryInput {
  readonly name?: string;
  readonly parentId?: string | null;
  readonly icon?: string | null;
  readonly color?: string | null;
  readonly aiDescription?: string | null;
  readonly sortOrder?: number;
}

/**
 * The Household category tree.
 *
 * Every structural rule lives here rather than in the resolver, because these are the rules that
 * protect invariants I-11 (acyclic, ≤ 5 deep) and I-12 (a Category in use cannot be deleted without
 * reassigning it). A cycle is not cosmetic: budgets, rollups and breadcrumbs all walk this tree.
 *
 * The tree maths itself is in `@finmate/domain` (pure, unit-tested); this service supplies the rows
 * and persists the outcome.
 */
@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every Category in the Household, with depth, breadcrumb and keywords resolved. */
  async list(householdId: string, kind?: CategoryKind): Promise<CategoryModel[]> {
    const rows = await this.prisma.client.categories.findMany({
      where: { household_id: householdId, deleted_at: null, ...(kind ? { kind } : {}) },
      orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
    });

    const keywords = await this.prisma.client.category_keywords.findMany({
      where: { household_id: householdId },
      orderBy: [{ polarity: 'asc' }, { keyword: 'asc' }],
    });

    const byId = new Map(rows.map((row) => [row.id, row]));
    const nodes: TreeNode[] = rows.map((row) => ({ id: row.id, parentId: row.parent_id }));

    return rows.map((row) => {
      const crumbs = pathTo(nodes, row.id)
        .map((id) => byId.get(id)?.name)
        .filter((name): name is string => typeof name === 'string');

      return {
        id: row.id,
        name: row.name,
        kind: row.kind as CategoryKind,
        parentId: row.parent_id,
        icon: row.icon,
        color: row.color,
        aiDescription: row.ai_description,
        isSystem: row.is_system,
        sortOrder: row.sort_order,
        depth: depthOf(nodes, row.id),
        path: crumbs,
        keywords: keywords
          .filter((keyword) => keyword.category_id === row.id)
          .map((keyword) => ({
            id: keyword.id,
            keyword: keyword.keyword,
            polarity: keyword.polarity as KeywordPolarity,
            matchMode: keyword.match_mode,
            weight: Number(keyword.weight),
          })),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  async create(householdId: string, input: CreateCategoryInput): Promise<CategoryModel> {
    const name = input.name.trim();
    if (name.length === 0) throw new ApiError('VALIDATION_FAILED', 'Category name is required.');
    if (name.length > 80) throw new ApiError('VALIDATION_FAILED', 'Category name is too long.');

    const nodes = await this.loadNodes(householdId);

    if (input.parentId) {
      await this.requireCategory(householdId, input.parentId, 'Parent category');
      const parentDepth = depthOf(nodes, input.parentId);
      if (parentDepth + 1 > MAX_TREE_DEPTH) {
        throw new ApiError(
          'VALIDATION_FAILED',
          `Categories can be nested at most ${MAX_TREE_DEPTH} levels deep (invariant I-11).`,
        );
      }
    }

    const id = uuidv7();
    try {
      const created = await this.prisma.client.categories.create({
        data: {
          id,
          household_id: householdId,
          parent_id: input.parentId ?? null,
          name,
          kind: input.kind,
          icon: input.icon ?? null,
          color: input.color ?? null,
          ai_description: input.aiDescription ?? null,
        },
      });

      return (await this.list(householdId)).find((category) => category.id === created.id)!;
    } catch (error) {
      throw this.translateWriteError(error, name);
    }
  }

  /**
   * Rename, restyle, or move a Category.
   *
   * A move is the dangerous one, so it is checked twice: the tree must stay acyclic (I-11), and the
   * **whole subtree** must still fit under the depth cap. Checking only the moved node would let a
   * shallow node with deep descendants slip a violation in below the fold.
   */
  async update(
    householdId: string,
    id: string,
    input: UpdateCategoryInput,
  ): Promise<CategoryModel> {
    const existing = await this.requireCategory(householdId, id, 'Category');
    const nodes = await this.loadNodes(householdId);

    const moving = input.parentId !== undefined && input.parentId !== existing.parent_id;
    if (moving) {
      const newParentId = input.parentId ?? null;

      if (wouldCreateCycle(nodes, id, newParentId)) {
        throw new ApiError(
          'VALIDATION_FAILED',
          'A category cannot be moved inside itself or one of its own descendants (invariant I-11).',
        );
      }

      if (newParentId) {
        const parent = await this.requireCategory(householdId, newParentId, 'Parent category');
        // I-3: a category's kind is structural, so an expense subtree cannot hang off an income one.
        if (parent.kind !== existing.kind) {
          throw new ApiError(
            'VALIDATION_FAILED',
            'A category can only be moved under a category of the same kind.',
          );
        }
      }

      const height = subtreeHeight(nodes, id);
      const newDepth = depthUnder(nodes, newParentId);
      if (newDepth + height - 1 > MAX_TREE_DEPTH) {
        throw new ApiError(
          'VALIDATION_FAILED',
          `That move would nest categories ${newDepth + height - 1} levels deep; the limit is ` +
            `${MAX_TREE_DEPTH} (invariant I-11).`,
        );
      }
    }

    try {
      await this.prisma.client.categories.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.parentId !== undefined ? { parent_id: input.parentId } : {}),
          ...(input.icon !== undefined ? { icon: input.icon } : {}),
          ...(input.color !== undefined ? { color: input.color } : {}),
          ...(input.aiDescription !== undefined ? { ai_description: input.aiDescription } : {}),
          ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
        },
      });
    } catch (error) {
      throw this.translateWriteError(error, input.name ?? existing.name);
    }

    return (await this.list(householdId)).find((category) => category.id === id)!;
  }

  /**
   * Soft-delete a Category, refusing while anything still points at it (invariant I-12).
   *
   * Two reasons this is a refusal rather than a cascade. Financially, silently re-bucketing a user's
   * history changes their reports without asking. Structurally, a dangling `category_id` would make
   * every rollup wrong in a way nobody would notice until the numbers were already trusted.
   *
   * `reassignToId` is the resolution path: it moves children, Transactions and Splits across, then
   * deletes.
   */
  async remove(
    householdId: string,
    id: string,
    reassignToId?: string | null,
  ): Promise<{ transactionsReassigned: number; splitsReassigned: number; childrenMoved: number }> {
    const category = await this.requireCategory(householdId, id, 'Category');
    const nodes = await this.loadNodes(householdId);

    const [transactionCount, splitCount, childCount] = await Promise.all([
      this.prisma.client.transactions.count({
        where: { household_id: householdId, category_id: id, deleted_at: null },
      }),
      this.prisma.client.transaction_splits.count({
        where: { household_id: householdId, category_id: id },
      }),
      this.prisma.client.categories.count({
        where: { household_id: householdId, parent_id: id, deleted_at: null },
      }),
    ]);

    const inUse = transactionCount + splitCount + childCount;

    if (inUse > 0 && !reassignToId) {
      throw new ApiError(
        'CONFLICT',
        `This category is still in use (${transactionCount} transactions, ${splitCount} splits, ` +
          `${childCount} subcategories). Choose a category to move them to first (invariant I-12).`,
      );
    }

    let transactionsReassigned = 0;
    let splitsReassigned = 0;
    let childrenMoved = 0;

    if (inUse > 0 && reassignToId) {
      if (reassignToId === id) {
        throw new ApiError('VALIDATION_FAILED', 'A category cannot be reassigned to itself.');
      }
      const target = await this.requireCategory(householdId, reassignToId, 'Target category');
      if (target.kind !== category.kind) {
        // I-3 again: reassigning would produce an expense sitting in an income category.
        throw new ApiError(
          'VALIDATION_FAILED',
          'The target category is a different kind, which would misclassify the transactions.',
        );
      }
      if (wouldCreateCycle(nodes, id, reassignToId)) {
        throw new ApiError(
          'VALIDATION_FAILED',
          'The target category is inside the category being deleted.',
        );
      }

      const result = await this.prisma.client.$transaction(async (tx) => {
        const children = await tx.categories.updateMany({
          where: { household_id: householdId, parent_id: id },
          data: { parent_id: reassignToId },
        });
        const transactions = await tx.transactions.updateMany({
          where: { household_id: householdId, category_id: id },
          data: { category_id: reassignToId, updated_at: new Date() },
        });
        // Splits now carry their own household_id (migration 20260914160000), so this is a scoped
        // write like any other — no escape hatch needed.
        const splits = await tx.transaction_splits.updateMany({
          where: { household_id: householdId, category_id: id },
          data: { category_id: reassignToId },
        });
        await tx.categories.update({
          where: { id },
          data: { deleted_at: new Date() },
        });

        return { children: children.count, transactions: transactions.count, splits: splits.count };
      });

      childrenMoved = result.children;
      transactionsReassigned = result.transactions;
      splitsReassigned = result.splits;
    } else {
      await this.prisma.client.categories.update({ where: { id }, data: { deleted_at: new Date() } });
    }

    await this.prisma.client.category_keywords.deleteMany({
      where: { household_id: householdId, category_id: id },
    });

    return { transactionsReassigned, splitsReassigned, childrenMoved };
  }

  // -------------------------------------------------------------------------------------------
  // Keywords (docs/04 §5.4)
  // -------------------------------------------------------------------------------------------

  async addKeyword(
    householdId: string,
    categoryId: string,
    keyword: string,
    polarity: KeywordPolarity,
    matchMode: 'WORD' | 'PREFIX' | 'SUBSTRING' = 'WORD',
  ): Promise<void> {
    await this.requireCategory(householdId, categoryId, 'Category');

    const normalized = this.normalizeKeyword(keyword);
    if (normalized.length === 0) {
      throw new ApiError('VALIDATION_FAILED', 'A keyword is required.');
    }

    // A keyword that is both include and exclude on the same category can never resolve, so it is
    // refused rather than stored as a contradiction.
    const opposite: KeywordPolarity =
      polarity === KeywordPolarity.INCLUDE ? KeywordPolarity.EXCLUDE : KeywordPolarity.INCLUDE;
    const clash = await this.prisma.client.category_keywords.findFirst({
      where: { household_id: householdId, category_id: categoryId, keyword: normalized, polarity: opposite },
    });
    if (clash) {
      throw new ApiError(
        'CONFLICT',
        `"${normalized}" is already an ${opposite.toLowerCase()}d keyword for this category.`,
      );
    }

    const existing = await this.prisma.client.category_keywords.findFirst({
      where: { household_id: householdId, category_id: categoryId, keyword: normalized, polarity },
    });
    if (existing) return; // idempotent

    await this.prisma.client.category_keywords.create({
      data: {
        id: uuidv7(),
        household_id: householdId,
        category_id: categoryId,
        keyword: normalized,
        polarity,
        match_mode: matchMode,
      },
    });
  }

  async removeKeyword(householdId: string, keywordId: string): Promise<void> {
    const keyword = await this.prisma.client.category_keywords.findFirst({
      where: { id: keywordId, household_id: householdId },
    });
    if (!keyword) throw new ApiError('NOT_FOUND', 'Keyword not found.');
    await this.prisma.client.category_keywords.delete({ where: { id: keywordId } });
  }

  /**
   * Normalise a keyword for matching: lowercase, unaccented, and cyrillic transliterated to latin.
   *
   * Stored normalised so `septička`, `septicka` and `септика` all hit the same row (docs/04 §3.1).
   * Display text is never mutated — only the matching key is.
   */
  private normalizeKeyword(keyword: string): string {
    return keyword
      .trim()
      .toLocaleLowerCase('sr-Latn-RS')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ');
  }

  // -------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------

  private async loadNodes(householdId: string): Promise<TreeNode[]> {
    const rows = await this.prisma.client.categories.findMany({
      where: { household_id: householdId, deleted_at: null },
      select: { id: true, parent_id: true },
    });

    const nodes = rows.map((row) => ({ id: row.id, parentId: row.parent_id }));

    // Defence in depth: the service prevents cycles, but if one ever reached the database every
    // tree walk would loop forever, so it is reported rather than allowed to hang a request.
    const violations = findTreeViolations(nodes);
    if (violations.cycles.length > 0) {
      throw new ApiError(
        'INTERNAL',
        `The category tree contains a cycle (${violations.cycles.length} node(s)); refusing to walk it.`,
      );
    }

    return nodes;
  }

  /** `findFirst`, never `findUnique`: the tenancy guard refuses the latter on scoped models. */
  private async requireCategory(householdId: string, id: string, label: string) {
    const category = await this.prisma.client.categories.findFirst({
      where: { id, household_id: householdId, deleted_at: null },
    });
    if (!category) throw new ApiError('NOT_FOUND', `${label} not found.`);
    return category;
  }

  /**
   * Turn a database constraint failure into a typed API error.
   *
   * The partial unique index on `(household_id, COALESCE(parent_id, …), lower(name))` is the real
   * guard against duplicate siblings — the service does not pre-check, because a check-then-write
   * races. Catching the violation is both correct and faster.
   */
  private translateWriteError(error: unknown, name: string): ApiError {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'P2002') {
        return new ApiError('CONFLICT', `A category named "${name}" already exists here.`);
      }
    }
    return error instanceof ApiError
      ? error
      : new ApiError('INTERNAL', 'Could not save the category.');
  }
}
