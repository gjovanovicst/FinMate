import { Injectable } from '@nestjs/common';

import { uuidv7 } from '@finmate/domain';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import { normaliseForMatching } from '../../common/text/normalise';
import { PrismaService } from '../../prisma/prisma.service';
import { TagModel } from './tag.model';

export interface TagInput {
  readonly name?: string;
  readonly color?: string | null;
}

/**
 * Tags (docs/01 F-12).
 *
 * A Tag is a label, not a classification: it does not affect a budget, a balance or the classifier,
 * so this service is small on purpose. Two things about it are worth stating rather than discovering:
 *
 *  - **`transaction_tags` is PARENT_SCOPED and cannot be written or read directly.** It has no
 *    `household_id`, so the tenancy guard refuses every direct operation on it — there is no tenant
 *    predicate it could add (ADR-008). Assignments are therefore written as a nested write through
 *    the parent Transaction, and read with `include: { transaction_tags: true }`. The grouped count
 *    joins through `transactions` in one statement, because Prisma cannot group a relation.
 *  - **Deleting a Tag is not like deleting a Merchant or a Category.** See `remove` below: there is
 *    nothing to reassign a label *to*.
 *
 * Name uniqueness folds, like every other piece of taxonomy: `#Vanredno` and `#vanredno` are one
 * label, and two rows would make the filter list show the same thing twice.
 */
@Injectable()
export class TagsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every Tag in the Household, name-ordered.
   *
   * Not paginated, unlike Merchants and Counterparties: a Household has tens of Tags, not thousands,
   * and the transaction editor needs the whole set to render a chip picker. `tags` in docs/06 §4 is
   * `[Tag!]!` for exactly that reason.
   */
  async list(householdId: string): Promise<TagModel[]> {
    const rows = await this.prisma.client.tags.findMany({
      where: { deleted_at: null },
      orderBy: [{ name: 'asc' }],
    });
    const counts = await this.transactionCounts(
      householdId,
      rows.map((row) => row.id),
    );
    return rows.map((row) => this.toModel(row, counts.get(row.id) ?? 0));
  }

  async getById(householdId: string, id: string): Promise<TagModel> {
    const row = await this.requireVisible(id);
    const counts = await this.transactionCounts(householdId, [id]);
    return this.toModel(row, counts.get(id) ?? 0);
  }

  /**
   * The Tag, or null when it does not exist.
   *
   * `tag(id:)` is nullable in docs/06 §4, so "does this Tag exist" is a legitimate question with a
   * legitimate negative answer — unlike every other lookup here, where absence is an error.
   */
  async findById(householdId: string, id: string): Promise<TagModel | null> {
    const row = await this.prisma.client.tags.findFirst({
      where: { id, household_id: householdId, deleted_at: null },
    });
    if (!row) return null;
    const counts = await this.transactionCounts(householdId, [id]);
    return this.toModel(row, counts.get(id) ?? 0);
  }

  async create(householdId: string, input: TagInput & { name: string }): Promise<TagModel> {
    const name = input.name.trim();
    if (name === '') throw new ApiError('VALIDATION_FAILED', 'A tag name is required.');
    await this.assertNameFree(name, null);

    const created = await this.prisma.client.tags.create({
      data: {
        id: uuidv7(),
        // `NOT NULL`, so Prisma's unchecked create input wants it explicitly. From the resolved
        // TenantContext, never from client input (ADR-008).
        household_id: householdId,
        name,
        color: input.color?.trim() || null,
      },
    });
    return this.toModel(created, 0);
  }

  async update(householdId: string, id: string, input: TagInput): Promise<TagModel> {
    await this.requireVisible(id);
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name === '') throw new ApiError('VALIDATION_FAILED', 'A tag name is required.');
      await this.assertNameFree(name, id);
    }

    const updated = await this.prisma.client.tags.update({
      where: { id, household_id: householdId },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.color !== undefined ? { color: input.color?.trim() || null } : {}),
      },
    });
    const counts = await this.transactionCounts(householdId, [id]);
    return this.toModel(updated, counts.get(id) ?? 0);
  }

  /**
   * Delete a Tag by removing its assignments.
   *
   * **Deliberately different from a Merchant or a Category, and this is the reason.** Those two
   * refuse while anything still references them and offer reassignment instead, because the
   * reference *is* information the user cannot re-enter from memory — which shop a payment went to,
   * which category a cost belongs to. A Tag is a label and nothing more: there is no
   * meaningful thing to reassign `#vanredno` *to*, and offering a picker between two tags the user
   * has just decided is redundant is friction for no gain. A dangling label is worse than a missing
   * one: the Tag is gone from the picker, but every Transaction that carried it would still hold an
   * assignment that renders as nothing and can never be removed. So the analogue of reassignment
   * here is **removing the assignments**: the Tag is soft-deleted and its `transaction_tags` rows for
   * this Household are deleted with it.
   *
   * The Transaction itself is untouched — no amount, no category, no date. Only the label goes.
   */
  async remove(householdId: string, id: string): Promise<void> {
    await this.requireVisible(id);

    // `transaction_tags` has no `household_id`, so its rows cannot be deleted directly: the tenancy
    // guard refuses every operation on the model, because there is no tenant predicate it could add
    // (ADR-008). They are removed through the parent Transaction instead — the scoped `findMany`
    // picks the Household's rows, and each nested `deleteMany` then reaches only that Transaction's
    // join rows. A `transaction_tags.deleteMany({ where: { tag_id } })` would be refused, and
    // rightly so: it could not carry a tenant predicate.
    //
    // `update`, not `updateMany`: Prisma refuses a nested relation write inside `updateMany`'s data,
    // which is the same reason the ledger's tag assignment goes through a single-row update.
    // One transaction, because the two halves must agree: assignments removed but the Tag still
    // present would be recoverable, but the reverse — Tag gone with assignments left behind — is
    // exactly the dangling label this method exists to avoid, and it would be unreachable through
    // the API because the Tag no longer appears in the picker.
    await this.prisma.client.$transaction(async (tx) => {
      const holders = await tx.transactions.findMany({
        where: { transaction_tags: { some: { tag_id: id } } },
        select: { id: true },
      });
      for (const holder of holders) {
        await tx.transactions.update({
          where: { id: holder.id, household_id: householdId },
          data: { transaction_tags: { deleteMany: { tag_id: id } } },
        });
      }

      await tx.tags.update({
        where: { id, household_id: householdId },
        data: { deleted_at: new Date() },
      });
    });
  }

  // -------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------

  /**
   * A Tag the Household may reference.
   *
   * `findFirst`, not `findUnique` — the guard refuses `findUnique` on a scoped model because its
   * `where` cannot carry the tenant predicate (ADR-008).
   */
  private async requireVisible(id: string) {
    const row = await this.prisma.client.tags.findFirst({ where: { id, deleted_at: null } });
    if (!row) throw new ApiError('NOT_FOUND', 'Tag not found.');
    return row;
  }

  /**
   * Refuse a name that folds to one already visible.
   *
   * Folding rather than exact matching: `#Vanredno`, `#vanredno` and `#vanrédno` are one label, and
   * letting all three exist would double every row in the filter list.
   */
  private async assertNameFree(name: string, exceptId: string | null): Promise<void> {
    const folded = normaliseForMatching(name);
    const candidates = await this.prisma.client.tags.findMany({
      where: { deleted_at: null },
      select: { id: true, name: true },
    });
    const clash = candidates.find(
      (candidate) => candidate.id !== exceptId && normaliseForMatching(candidate.name) === folded,
    );
    if (clash) {
      throw new ApiError('CONFLICT', `"${clash.name}" already exists.`);
    }
  }

  /**
   * How many non-deleted Transactions carry each of these Tags.
   *
   * One grouped statement for the whole set, like `MerchantsService.transactionCounts`, rather than a
   * count per row. Raw because of the parent-scoped model: `transaction_tags` carries no
   * `household_id`, so the guard refuses to query it directly and Prisma cannot `groupBy` a relation
   * field. Joining through `transactions` is what supplies the tenant predicate — the join is the
   * scoping, which is why this is safe despite bypassing the model hook.
   *
   * Parameterised only; `ids` is a uuid[] bind, never string-interpolated.
   */
  private async transactionCounts(
    householdId: string,
    ids: readonly string[],
  ): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();

    const grouped = await this.prisma.client.$queryRaw<{ tag_id: string; n: bigint }[]>`
      SELECT tt.tag_id, count(*)::bigint AS n
      FROM transaction_tags tt
      JOIN transactions t ON t.id = tt.transaction_id
      WHERE tt.tag_id = ANY(${[...ids]}::uuid[])
        AND t.household_id = ${householdId}::uuid
        AND t.deleted_at IS NULL
      GROUP BY tt.tag_id
    `;

    return new Map(grouped.map((row) => [row.tag_id, Number(row.n)]));
  }

  private toModel(
    row: { id: string; name: string; color: string | null; created_at: Date },
    transactionCount: number,
  ): TagModel {
    return {
      id: row.id,
      name: row.name,
      color: row.color,
      transactionCount,
      createdAt: row.created_at,
    };
  }

  /**
   * Every Tag id the Household may attach, or `VALIDATION_FAILED`.
   *
   * Used by the ledger when an assignment arrives, so a foreign or unknown id is a typed failure
   * rather than a silently dropped assignment — the user would otherwise tag a Transaction and watch
   * the chip disappear on reload.
   */
  async assertAssignable(ids: readonly string[]): Promise<void> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return;
    const found = await this.prisma.client.tags.findMany({
      where: { id: { in: unique }, deleted_at: null },
      select: { id: true },
    });
    const known = new Set(found.map((tag) => tag.id));
    const unknown = unique.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new ApiError(
        'VALIDATION_FAILED',
        `Unknown tag id(s): ${unknown.join(', ')}. A tag must belong to this Household and not be deleted.`,
      );
    }
  }
}
