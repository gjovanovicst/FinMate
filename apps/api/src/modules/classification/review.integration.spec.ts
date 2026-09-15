import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@finmate/domain';

import { runWithTenant, type TenantContext } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { LedgerModule } from '../ledger/ledger.module';
import { TransactionsService } from '../ledger/transactions.service';
import { ReviewService } from './review.service';

/**
 * The review queue — F-08, invariant I-8 — against a real database.
 *
 * ## What only Postgres can answer here
 *
 * The queue's whole claim is about **which rows** are in it and what a resolution *does to them*:
 *
 * - `needs_review` is the blocking lane only, so an auto-applied row must not appear and a
 *   `PENDING` row must;
 * - resolving writes through the correction path, so a `corrections` row appears — that is the
 *   learning loop, and a resolution that silently cleared the flag without it would pass a
 *   behavioural test and lose the signal;
 * - `applyToSimilar` has to clear the right peers and only those.
 *
 * Rows are inserted directly rather than through `captureCommit` where the *state* is what matters
 * (a low-confidence row with a category cannot be produced by a capture alone in this household),
 * and through the ledger where the path is what matters.
 */
describe('the review queue (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let transactions: TransactionsService;
  let review: ReviewService;

  const householdId = uuidv7();
  const otherHouseholdId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();
  const context: TenantContext = { householdId, userId, role: 'OWNER', requestId: 'review-it' };
  const otherContext: TenantContext = {
    householdId: otherHouseholdId,
    userId: otherUserId,
    role: 'OWNER',
    requestId: 'review-it-other',
  };
  const asTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(context, fn);

  let accountId: string;
  let foodId: string;
  let houseId: string;
  let giftId: string;
  let dejanId: string;
  let mikaId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule, LedgerModule],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    transactions = moduleRef.get(TransactionsService);
    review = moduleRef.get(ReviewService);

    const stamp = Date.now();
    await prisma.client.users.create({
      data: { id: userId, email: `review-${stamp}@example.com`, display_name: 'Review Test' },
    });
    await prisma.client.users.create({
      data: { id: otherUserId, email: `review-b-${stamp}@example.com`, display_name: 'Other' },
    });

    await asTenant(async () => {
      await prisma.client.households.create({
        data: { id: householdId, name: 'Review', owner_user_id: userId, ledger_currency: 'RSD' },
      });
      accountId = uuidv7();
      await prisma.client.accounts.create({
        data: { id: accountId, household_id: householdId, name: 'Tekući', kind: 'BANK', currency: 'RSD' },
      });
      foodId = uuidv7();
      houseId = uuidv7();
      giftId = uuidv7();
      await prisma.client.categories.createMany({
        data: [
          { id: foodId, household_id: householdId, name: 'Hrana', kind: 'EXPENSE' },
          { id: houseId, household_id: householdId, name: 'Septička jama', kind: 'EXPENSE' },
          { id: giftId, household_id: householdId, name: 'Pokloni', kind: 'EXPENSE' },
        ],
      });
      dejanId = uuidv7();
      mikaId = uuidv7();
      await prisma.client.counterparties.createMany({
        data: [
          { id: dejanId, household_id: householdId, name: 'Dejan rođa', type: 'PERSON' },
          { id: mikaId, household_id: householdId, name: 'Mika', type: 'PERSON' },
        ],
      });
    });

    await runWithTenant(otherContext, async () => {
      await prisma.client.households.create({
        data: { id: otherHouseholdId, name: 'Other', owner_user_id: otherUserId },
      });
    });
  });

  afterAll(async () => {
    for (const [ctx, id] of [
      [context, householdId],
      [otherContext, otherHouseholdId],
    ] as const) {
      await runWithTenant(ctx, () => prisma.client.households.deleteMany({ where: { id } }));
    }
    await prisma.client.users.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await moduleRef?.close();
  });

  // -------------------------------------------------------------------------------------------
  // Harness
  // -------------------------------------------------------------------------------------------

  /** A Transaction in the state the queue exists for, inserted directly. */
  async function queuedRow(args: {
    readonly description: string;
    readonly categoryId: string | null;
    readonly confidence: number | null;
    readonly counterpartyId?: string | null;
    readonly createdAt?: Date;
  }): Promise<string> {
    const id = uuidv7();
    await asTenant(() =>
      prisma.client.transactions.create({
        data: {
          id,
          household_id: householdId,
          account_id: accountId,
          kind: 'EXPENSE',
          amount_minor: 360000n,
          currency: 'RSD',
          description: args.description,
          category_id: args.categoryId,
          category_source: args.categoryId === null ? null : 'AI',
          counterparty_id: args.counterpartyId ?? null,
          confidence: args.confidence === null ? null : args.confidence.toFixed(3),
          // I-8: the blocking lane. A null category or a calibrated confidence below 0.60.
          needs_review: true,
          status: 'PENDING',
          occurred_at: new Date('2026-09-14T10:00:00.000Z'),
          occurred_local_date: new Date('2026-09-14T00:00:00.000Z'),
          source: 'NATURAL_LANGUAGE',
          ...(args.createdAt ? { created_at: args.createdAt } : {}),
        },
      }),
    );
    return id;
  }

  /** The queue as the resolver composes it: the ledger's page, enriched, then filtered. */
  async function queue(
    filter: Parameters<ReviewService['filter']>[1] = {},
    sort: 'RECORDED_ASC' | 'RECORDED_DESC' = 'RECORDED_ASC',
  ) {
    const page = await asTenant(() =>
      transactions.list(householdId, { needsReview: true }, { first: 50, sort }),
    );
    const enriched = await asTenant(() => review.enrich(householdId, page.items));
    // `filter` is pure and synchronous — it reads the enriched rows, not the database.
    return { items: review.filter(enriched, filter), totalCount: page.totalCount };
  }

  // -------------------------------------------------------------------------------------------
  // What is in the queue
  // -------------------------------------------------------------------------------------------

  describe('membership (invariant I-8)', () => {
    it('holds an uncategorised row and a low-confidence row, and reports why', async () => {
      const uncategorised = await queuedRow({ description: 'Nepoznato 850', categoryId: null, confidence: 0 });
      const low = await queuedRow({ description: 'Dejan rođa 3600', categoryId: giftId, confidence: 0.61 });

      const { items } = await queue();
      const byId = new Map(items.map((item) => [item.id, item]));

      expect(byId.get(uncategorised)?.reason).toBe('UNCATEGORISED');
      // An uncategorised row has nothing to suggest — inventing one is what the queue exists to avoid.
      expect(byId.get(uncategorised)?.suggestedCategoryId).toBeNull();

      expect(byId.get(low)?.reason).toBe('LOW_CONFIDENCE');
      // A low-confidence row's suggestion IS its stored category: that is the proposal to verify.
      expect(byId.get(low)?.suggestedCategoryId).toBe(giftId);
      expect(byId.get(low)?.confidence).toBe(0.61);
    });

    it('excludes an auto-applied row, because the queue is the blocking lane only', async () => {
      const applied = await asTenant(() =>
        transactions.create(householdId, {
          accountId,
          kind: 'EXPENSE',
          amountMinor: 200000n,
          description: 'Lidl 2000',
          categoryId: foodId,
          occurredLocalDate: '2026-09-14',
          source: 'MANUAL',
        }),
      );

      const { items } = await queue();
      expect(items.map((item) => item.id)).not.toContain(applied.id);
    });

    it('counts exactly the queue, so the badge cannot disagree with the screen', async () => {
      const { items } = await queue();
      expect(await asTenant(() => review.count(householdId))).toBe(items.length);
    });

    it('orders oldest-recorded first by default, so nothing starves', async () => {
      // The order is on the **id**, because a UUIDv7 *is* the creation order (docs/03 §3.3). That is
      // what makes the keyset exact: the sort key and the cursor are the same column. A row written
      // earlier therefore has a smaller id, and no `created_at` override can change that — which is
      // the property, not a limitation.
      const first = await queuedRow({ description: 'Prvo 100', categoryId: null, confidence: 0 });
      const second = await queuedRow({ description: 'Drugo 200', categoryId: null, confidence: 0 });

      const { items } = await queue({}, 'RECORDED_ASC');
      const positions = items.map((item) => item.id);
      // Relative order is the property; the queue also holds rows from earlier tests, so asserting
      // "first is at index 0" would be asserting the test file's history rather than the sort.
      expect(positions.indexOf(first)).toBeLessThan(positions.indexOf(second));

      const { items: reversed } = await queue({}, 'RECORDED_DESC');
      const reversedPositions = reversed.map((item) => item.id);
      expect(reversedPositions.indexOf(second)).toBeLessThan(reversedPositions.indexOf(first));
    });

    it('filters by reason and by confidence', async () => {
      const { items: onlyUncategorised } = await queue({ reason: ['UNCATEGORISED'] });
      expect(onlyUncategorised.every((item) => item.reason === 'UNCATEGORISED')).toBe(true);

      const { items: below } = await queue({ confidenceBelow: 0.2 });
      expect(below.every((item) => item.confidence !== null && item.confidence < 0.2)).toBe(true);
    });

    it('never shows another Household’s queue', async () => {
      const items = await runWithTenant(otherContext, async () => {
        const page = await transactions.list(otherHouseholdId, { needsReview: true }, { first: 50 });
        return review.enrich(otherHouseholdId, page.items);
      });
      expect(items).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Resolving
  // -------------------------------------------------------------------------------------------

  describe('resolving a row', () => {
    it('sets the category, clears the flag, and records a Correction — the learning loop', async () => {
      const id = await queuedRow({
        description: 'Dejan rođa 3600',
        categoryId: null,
        confidence: 0,
        counterpartyId: dejanId,
      });

      const outcome = await asTenant(() =>
        transactions.resolveReviewItem(householdId, { id, action: 'SET_CATEGORY', categoryId: houseId }),
      );

      expect(outcome.transaction.categoryId).toBe(houseId);
      expect(outcome.transaction.needsReview).toBe(false);
      expect(outcome.resolvedSimilarCount).toBe(1);

      // The signal: a resolution that only cleared the flag would pass a behavioural test and lose the
      // learning loop's input (docs/04 §8).
      expect(outcome.correction).not.toBeNull();
      expect(outcome.correction?.field).toBe('category');
      expect(outcome.correction?.toValue).toBe(houseId);

      // And it leaves the queue.
      const { items } = await queue();
      expect(items.map((item) => item.id)).not.toContain(id);
    });

    it('synthesises a rule when the user asks to remember', async () => {
      const id = await queuedRow({
        description: 'Mika 3600',
        categoryId: null,
        confidence: 0,
        counterpartyId: mikaId,
      });

      const outcome = await asTenant(() =>
        transactions.resolveReviewItem(householdId, {
          id,
          action: 'SET_CATEGORY',
          categoryId: houseId,
          rememberForFuture: true,
        }),
      );

      expect(outcome.synthesis?.synthesis.proposal.trigger).toBe('COUNTERPARTY_RESOLVED');
      expect(outcome.ruleCreated).not.toBeNull();
      expect(outcome.ruleCreated?.origin).toBe('LEARNED');
    });

    it('refuses to accept a suggestion that does not exist', async () => {
      const id = await queuedRow({ description: 'Nepoznato 900', categoryId: null, confidence: 0 });

      await expect(
        asTenant(() => transactions.resolveReviewItem(householdId, { id, action: 'ACCEPT_SUGGESTION' })),
      ).rejects.toThrow(/no suggested category/i);
    });

    it('keeps a category the user says is right, without a Correction', async () => {
      const id = await queuedRow({ description: 'Lidl 1500', categoryId: foodId, confidence: 0.55 });

      const outcome = await asTenant(() =>
        transactions.resolveReviewItem(householdId, { id, action: 'ACCEPT_SUGGESTION' }),
      );

      expect(outcome.transaction.categoryId).toBe(foodId);
      expect(outcome.transaction.needsReview).toBe(false);
      // Nothing changed, so there is nothing to learn: a Correction here would be a correction to the
      // same value, which the re-fit would read as a rejection.
      expect(outcome.correction).toBeNull();
    });

    it('voids and deletes through the same flag-clearing path', async () => {
      const toVoid = await queuedRow({ description: 'Poništi 100', categoryId: null, confidence: 0 });
      const voided = await asTenant(() =>
        transactions.resolveReviewItem(householdId, { id: toVoid, action: 'VOID' }),
      );
      expect(voided.transaction.status).toBe('VOID');
      expect(voided.transaction.needsReview).toBe(false);

      const toDelete = await queuedRow({ description: 'Obriši 100', categoryId: null, confidence: 0 });
      await asTenant(() =>
        transactions.resolveReviewItem(householdId, { id: toDelete, action: 'DELETE' }),
      );
      const stored = await asTenant(() =>
        prisma.client.transactions.findFirst({ where: { id: toDelete } }),
      );
      // Soft, never hard (docs/03 §3.4).
      expect(stored?.deleted_at).not.toBeNull();
      expect(await asTenant(() => review.count(householdId))).toBe((await queue()).items.length);
    });

    it('resolves the same row twice as a NO-OP rather than a conflict', async () => {
      const id = await queuedRow({ description: 'Dvaput 100', categoryId: null, confidence: 0 });

      const first = await asTenant(() =>
        transactions.resolveReviewItem(householdId, { id, action: 'KEEP_AS_IS' }),
      );
      const second = await asTenant(() =>
        transactions.resolveReviewItem(householdId, { id, action: 'KEEP_AS_IS' }),
      );

      expect(first.resolvedSimilarCount).toBe(1);
      // Two devices clearing the same queue is not an error; the second one's work is already done.
      expect(second.resolvedSimilarCount).toBe(0);
      expect(second.correction).toBeNull();
    });

    it('the badge count follows every resolution', async () => {
      const before = await asTenant(() => review.count(householdId));
      const id = await queuedRow({ description: 'Brojač 100', categoryId: null, confidence: 0 });

      await asTenant(() =>
        transactions.resolveReviewItem(householdId, { id, action: 'KEEP_AS_IS' }),
      );
      // The badge is the resolver's `reviewQueueCount`, which is this same COUNT — so this is the
      // number the nav will show.
      expect(await asTenant(() => review.count(householdId))).toBe(before);
    });
  });

  // -------------------------------------------------------------------------------------------
  // applyToSimilar — F-08's power affordance
  // -------------------------------------------------------------------------------------------

  describe('applyToSimilar', () => {
    it('clears the peers sharing the entity AND the suggestion, and only those', async () => {
      const peerA = await queuedRow({
        description: 'Dejan rođa 1000',
        categoryId: null,
        confidence: 0,
        counterpartyId: dejanId,
      });
      const peerB = await queuedRow({
        description: 'Dejan rođa 2000',
        categoryId: null,
        confidence: 0,
        counterpartyId: dejanId,
      });
      // A second peer, so the test proves the sweep covers more than one row rather than that it
      // happened to catch exactly one.
      const peerC = await queuedRow({
        description: 'Dejan rođa 3000',
        categoryId: null,
        confidence: 0,
        counterpartyId: dejanId,
      });
      // A different person, and a row with no entity at all: neither is "the same thing".
      const stranger = await queuedRow({
        description: 'Mika 3000',
        categoryId: null,
        confidence: 0,
        counterpartyId: mikaId,
      });
      const anonymous = await queuedRow({ description: 'Anonimno 500', categoryId: null, confidence: 0 });

      const outcome = await asTenant(() =>
        transactions.resolveReviewItem(householdId, {
          id: peerA,
          action: 'SET_CATEGORY',
          categoryId: houseId,
          applyToSimilar: true,
        }),
      );

      // The row acted on plus the two peers — the stranger and the anonymous row are untouched.
      expect(outcome.resolvedSimilarCount).toBe(3);

      const resolved = await asTenant(() =>
        prisma.client.transactions.findMany({
          where: { id: { in: [peerA, peerB, peerC, stranger, anonymous] } },
          select: { id: true, category_id: true, needs_review: true },
        }),
      );
      const byId = new Map(resolved.map((row) => [row.id, row]));

      expect(byId.get(peerA)?.category_id).toBe(houseId);
      expect(byId.get(peerB)?.category_id).toBe(houseId);
      expect(byId.get(peerB)?.needs_review).toBe(false);
      expect(byId.get(peerC)?.category_id).toBe(houseId);
      expect(byId.get(peerC)?.needs_review).toBe(false);
      expect(byId.get(stranger)?.needs_review).toBe(true);
      expect(byId.get(stranger)?.category_id).toBeNull();
      expect(byId.get(anonymous)?.needs_review).toBe(true);

      // One decision, one Correction: the peers are an application of it, not N separate answers, and
      // recording N would inflate the re-fit's signal with duplicates of the same fact.
      const corrections = await asTenant(() =>
        prisma.client.corrections.count({ where: { household_id: householdId, transaction_id: peerB } }),
      );
      expect(corrections).toBe(0);
    });

    it('does not sweep in a row of the other direction (invariant I-3)', async () => {
      const expense = await queuedRow({
        description: 'Dejan trošak',
        categoryId: null,
        confidence: 0,
        counterpartyId: dejanId,
      });

      // An INCOME row from the same person. A category of the expense direction would be an I-3
      // violation, so it must be left alone.
      const incomeId = uuidv7();
      await asTenant(() =>
        prisma.client.transactions.create({
          data: {
            id: incomeId,
            household_id: householdId,
            account_id: accountId,
            kind: 'INCOME',
            amount_minor: 100000n,
            currency: 'RSD',
            description: 'Dejan uplata',
            counterparty_id: dejanId,
            needs_review: true,
            status: 'PENDING',
            occurred_at: new Date('2026-09-14T10:00:00.000Z'),
            occurred_local_date: new Date('2026-09-14T00:00:00.000Z'),
            source: 'NATURAL_LANGUAGE',
          },
        }),
      );

      await asTenant(() =>
        transactions.resolveReviewItem(householdId, {
          id: expense,
          action: 'SET_CATEGORY',
          categoryId: houseId,
          applyToSimilar: true,
        }),
      );

      const income = await asTenant(() =>
        prisma.client.transactions.findFirst({ where: { id: incomeId }, select: { needs_review: true, category_id: true } }),
      );
      expect(income?.needs_review).toBe(true);
      expect(income?.category_id).toBeNull();
    });

    it('does not sweep in a row with splits (invariant I-1)', async () => {
      const splitRow = await asTenant(() =>
        transactions.create(householdId, {
          accountId,
          kind: 'EXPENSE',
          amountMinor: 100000n,
          description: 'Dejan podeljeno',
          counterpartyId: dejanId,
          occurredLocalDate: '2026-09-14',
          source: 'MANUAL',
          splits: [
            { categoryId: foodId, amountMinor: 60000n },
            { categoryId: giftId, amountMinor: 40000n },
          ],
        }),
      );
      // A split row's category belongs to its parts, so it cannot be swept by a transaction-level
      // category. Its flag is set here directly because a create does not queue anything.
      await asTenant(() =>
        prisma.client.transactions.updateMany({
          where: { id: splitRow.id },
          data: { needs_review: true },
        }),
      );

      const subject = await queuedRow({
        description: 'Dejan izvor',
        categoryId: null,
        confidence: 0,
        counterpartyId: dejanId,
      });

      const outcome = await asTenant(() =>
        transactions.resolveReviewItem(householdId, {
          id: subject,
          action: 'KEEP_AS_IS',
          applyToSimilar: true,
        }),
      );

      // Only the subject: a split row is not a peer.
      expect(outcome.resolvedSimilarCount).toBe(1);
      const after = await asTenant(() =>
        prisma.client.transactions.findFirst({ where: { id: splitRow.id }, select: { needs_review: true } }),
      );
      expect(after?.needs_review).toBe(true);
    });

    it('does nothing without an entity, because "same kind and no category" is not "the same thing"', async () => {
      const one = await queuedRow({ description: 'Anon jedan', categoryId: null, confidence: 0 });
      await queuedRow({ description: 'Anon dva', categoryId: null, confidence: 0 });

      const outcome = await asTenant(() =>
        transactions.resolveReviewItem(householdId, { id: one, action: 'KEEP_AS_IS', applyToSimilar: true }),
      );
      expect(outcome.resolvedSimilarCount).toBe(1);
    });
  });
});
