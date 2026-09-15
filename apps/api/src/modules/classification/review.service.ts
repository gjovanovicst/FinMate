import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import type { TransactionModel } from '../ledger/transaction.model';

/**
 * The review queue's **read** half — F-08, docs/04 §7, invariant I-8.
 *
 * ## What the queue *is*
 *
 * I-8 defines `needs_review = true` as "`confidence < 0.60` **or** `category_id IS NULL`", and that
 * flag is the **blocking** lane only. So the queue is not a list of suggestions to eyeball; it is the
 * set of rows that are not usable as they stand, and the nav badge counts exactly this set. The
 * advisory lane (an AI suggestion at 0.60–0.89) is deliberately absent — those rows are applied and
 * valid, and mixing them in is how a badge becomes a number users learn to ignore.
 *
 * ## Why this service only reads and only joins
 *
 * The rows are Transactions, so the **ledger** owns how they are filtered, paged and written. This
 * service owns the other half: the `classification_decisions` row behind each Transaction, which is
 * what says *why* the row is here and what the losing alternatives were. It therefore takes the rows
 * **in** rather than fetching them — reaching for `TransactionsService` would need this module to
 * import the ledger, which imports this one, and the edge would become a cycle.
 *
 * Resolution lives on `TransactionsService.resolveReviewItem`, next to `correctTransaction`, because
 * it is a Transaction write and it is the learning loop: choosing a category in the queue records a
 * Correction and can create a rule exactly like a correction made anywhere else (docs/04 §8,
 * ADR-010). A `PATCH needs_review = false` would throw that signal away.
 *
 * @module apps/api/src/modules/classification
 */

/** docs/06 §4.2's `ReviewReason`, restricted to the two I-8 actually produces. */
export type ReviewReason = 'LOW_CONFIDENCE' | 'UNCATEGORISED';

/** One row awaiting a decision. */
export interface ReviewItemView {
  readonly id: string;
  readonly kind: 'TRANSACTION';
  readonly transaction: TransactionModel;
  readonly reason: ReviewReason;
  /** The **calibrated** confidence, or `null` when nothing was ever recorded (docs/04 §6.4). */
  readonly confidence: number | null;
  /**
   * The category to accept. For a low-confidence row it is the one the pipeline chose — that is what
   * makes it a row to *verify*. For an uncategorised row it is `null`, because there is nothing to
   * suggest and inventing one is what the queue exists to avoid.
   */
  readonly suggestedCategoryId: string | null;
  /** The losing proposals, for the numbered alternatives docs/02 §4.6 renders as `[1]`, `[2]`. */
  readonly candidates: readonly { readonly categoryId: string; readonly confidence: number }[];
  /** Hours since the row was **recorded** — the queue's sort key, so nothing starves. */
  readonly ageHours: number;
}

/** The read-only predicates docs/06 §4.2 declares. Applied to an enriched item, not to SQL. */
export interface ReviewQueueFilter {
  readonly reason?: readonly ReviewReason[];
  readonly confidenceBelow?: number;
  readonly occurredOnOrAfter?: string;
  readonly occurredOnOrBefore?: string;
  readonly categoryIds?: readonly string[];
}

@Injectable()
export class ReviewService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The blocking-lane count — the nav badge (I-8).
   *
   * A scoped COUNT, so the shell can ask on every screen without loading rows. `needs_review` here is
   * the **column**; the ledger's `TransactionFilters` spells it `needsReview`, and the two are not
   * interchangeable.
   */
  async count(householdId: string): Promise<number> {
    return this.prisma.client.transactions.count({
      where: { household_id: householdId, deleted_at: null, needs_review: true },
    });
  }

  /**
   * Join each Transaction to the decision behind it, in **one** query for the page.
   *
   * The latest decision wins: a row can have several (a resubmitted capture, a correction), and the
   * newest is the one that produced the state the user is looking at.
   */
  async enrich(
    householdId: string,
    rows: readonly TransactionModel[],
  ): Promise<readonly ReviewItemView[]> {
    if (rows.length === 0) return [];

    const decisions = await this.prisma.client.classification_decisions.findMany({
      where: { household_id: householdId, transaction_id: { in: rows.map((row) => row.id) } },
      orderBy: { created_at: 'desc' },
      select: { transaction_id: true, candidates: true },
    });

    const latest = new Map<string, (typeof decisions)[number]>();
    for (const decision of decisions) {
      if (decision.transaction_id === null) continue;
      if (!latest.has(decision.transaction_id)) latest.set(decision.transaction_id, decision);
    }

    const now = Date.now();
    return rows.map((transaction) => ({
      id: transaction.id,
      kind: 'TRANSACTION' as const,
      transaction,
      // I-8's two disjuncts, in the order that names the more urgent problem: a row with no category
      // is *unanswered*, while a low-confidence row at least has an answer to check.
      reason: transaction.categoryId === null ? 'UNCATEGORISED' : 'LOW_CONFIDENCE',
      confidence: transaction.confidence,
      // The suggestion is the stored category — for a low-confidence row that is precisely the
      // proposal the user is being asked to verify.
      suggestedCategoryId: transaction.categoryId,
      candidates: alternativesOf(latest.get(transaction.id)?.candidates),
      ageHours: Math.max(0, Math.floor((now - transaction.createdAt.getTime()) / 3_600_000)),
    }));
  }

  /** The read predicates, applied to an enriched item. One definition, shared with the tests. */
  filter(items: readonly ReviewItemView[], filter: ReviewQueueFilter): readonly ReviewItemView[] {
    return items.filter((item) => matches(item, filter));
  }
}

/** One predicate set, so the query and its tests cannot disagree about what a filter means. */
export function matches(item: ReviewItemView, filter: ReviewQueueFilter): boolean {
  if (filter.reason && filter.reason.length > 0 && !filter.reason.includes(item.reason)) return false;
  if (
    filter.confidenceBelow !== undefined &&
    (item.confidence === null || item.confidence >= filter.confidenceBelow)
  ) {
    return false;
  }
  if (
    filter.occurredOnOrAfter !== undefined &&
    item.transaction.occurredLocalDate < filter.occurredOnOrAfter
  ) {
    return false;
  }
  if (
    filter.occurredOnOrBefore !== undefined &&
    item.transaction.occurredLocalDate > filter.occurredOnOrBefore
  ) {
    return false;
  }
  if (filter.categoryIds && filter.categoryIds.length > 0) {
    const categoryId = item.transaction.categoryId;
    if (categoryId === null || !filter.categoryIds.includes(categoryId)) return false;
  }
  return true;
}

/**
 * The losing proposals from a decision's `candidates` blob.
 *
 * The blob is opaque JSON written by the pipeline (see `ClassificationService.recordDecision`), so
 * this reads defensively and returns `[]` for anything unexpected — a malformed audit blob must not
 * take the review queue down, and an empty alternative list is a truthful "nothing else was close".
 */
export function alternativesOf(
  candidates: unknown,
): readonly { categoryId: string; confidence: number }[] {
  if (candidates === null || typeof candidates !== 'object' || Array.isArray(candidates)) return [];
  const alternatives = (candidates as Record<string, unknown>)['alternatives'];
  if (!Array.isArray(alternatives)) return [];

  const out: { categoryId: string; confidence: number }[] = [];
  for (const entry of alternatives) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const categoryId = record['categoryId'];
    if (typeof categoryId !== 'string') continue;
    const confidence = record['confidence'];
    out.push({ categoryId, confidence: typeof confidence === 'number' ? confidence : 0 });
  }
  return out;
}
