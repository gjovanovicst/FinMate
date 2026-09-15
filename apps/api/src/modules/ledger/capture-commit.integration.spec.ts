import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7, money, type Money } from '@finmate/domain';

import { runWithTenant, type TenantContext } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AI_CLASSIFIER, type AiClassifier, type ClassifyRequest } from '../classification/ai-classifier';
import type { AiStageResult } from '../classification/classification.pipeline';
import { LedgerModule } from './ledger.module';
import { TransactionKind, TransactionStatus } from './transaction.model';
import {
  CaptureCommitRejected,
  TransactionsService,
  type CaptureCommitRequest,
  type CaptureCommitRow,
  type CaptureCommitOutcome,
} from './transactions.service';

/**
 * `captureCommit` against a real database (docs/06 §5.2).
 *
 * ## What only Postgres can answer here
 *
 * The interesting claims are about **rows and atomicity**, not return values:
 *
 * - a single invalid row writes **nothing** — asserted by counting rows before and after, not by
 *   trusting the payload;
 * - the gate's verdict lands in `transactions.status`, `needs_review`, `confidence` and
 *   `category_source`, which is invariant I-8 and the difference between a usable review queue and a
 *   badge users ignore;
 * - `classification_decisions.transaction_id` is finally non-null, which is F-31's whole point and
 *   was impossible before this task;
 * - I-10's unique index, which is the authority the lookup only avoids a round trip for.
 *
 * ## The AI is stubbed to always fail
 *
 * Task 2.2.4's exit criterion is "with the AI provider mocked to always fail, capture still succeeds
 * and rows are marked for review". The stub below is exactly that, and `calls` is asserted so
 * "the model was not reached" is counted rather than assumed.
 */
describe('TransactionsService.captureCommit (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let transactions: TransactionsService;

  const householdId = uuidv7();
  const otherHouseholdId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();

  const context: TenantContext = { householdId, userId, role: 'OWNER', requestId: 'capture-it' };
  const otherContext: TenantContext = {
    householdId: otherHouseholdId,
    userId: otherUserId,
    role: 'OWNER',
    requestId: 'capture-it-other',
  };

  const asTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(context, fn);

  let accountId: string;
  let foodId: string;
  let fuelId: string;
  let incomeId: string;
  let otherAccountId: string;
  let otherCategoryId: string;

  /** Every AI call the pipeline attempted. Empty is the assertion, not a side note. */
  const aiCalls: ClassifyRequest[] = [];

  /** The always-failing provider docs/04 §9 promises capture survives. */
  const failingClassifier: AiClassifier = {
    classify: (request: ClassifyRequest): Promise<AiStageResult> => {
      aiCalls.push(request);
      return Promise.resolve({
        unavailable: true,
        rung: 'RULES_KEYWORDS_ONLY',
        reason: 'PROVIDER_UNAVAILABLE:test',
      });
    },
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule, LedgerModule],
    })
      .overrideProvider(AI_CLASSIFIER)
      .useValue(failingClassifier)
      .compile();

    prisma = moduleRef.get(PrismaService);
    transactions = moduleRef.get(TransactionsService);

    const stamp = Date.now();
    await prisma.client.users.create({
      data: { id: userId, email: `capture-${stamp}@example.com`, display_name: 'Capture Test' },
    });
    await prisma.client.users.create({
      data: { id: otherUserId, email: `capture-b-${stamp}@example.com`, display_name: 'Other' },
    });

    await asTenant(async () => {
      await prisma.client.households.create({
        data: {
          id: householdId,
          name: 'Capture Test',
          owner_user_id: userId,
          ledger_currency: 'RSD',
          iana_timezone: 'Europe/Belgrade',
        },
      });
      accountId = uuidv7();
      await prisma.client.accounts.create({
        data: { id: accountId, household_id: householdId, name: 'Everyday', kind: 'BANK', currency: 'RSD' },
      });
      foodId = uuidv7();
      fuelId = uuidv7();
      incomeId = uuidv7();
      await prisma.client.categories.createMany({
        data: [
          { id: foodId, household_id: householdId, name: 'Supermarket', kind: 'EXPENSE' },
          { id: fuelId, household_id: householdId, name: 'Gorivo', kind: 'EXPENSE' },
          { id: incomeId, household_id: householdId, name: 'Plata', kind: 'INCOME' },
        ],
      });
      await prisma.client.category_keywords.createMany({
        data: [
          { id: uuidv7(), category_id: foodId, keyword: 'lidl', polarity: 'INCLUDE', match_mode: 'WORD', weight: 2 },
          { id: uuidv7(), category_id: fuelId, keyword: 'gorivo', polarity: 'INCLUDE', match_mode: 'WORD', weight: 2 },
          { id: uuidv7(), category_id: incomeId, keyword: 'plata', polarity: 'INCLUDE', match_mode: 'WORD', weight: 3 },
        ],
      });
    });

    await runWithTenant(otherContext, async () => {
      await prisma.client.households.create({
        data: { id: otherHouseholdId, name: 'Other Capture', owner_user_id: otherUserId },
      });
      otherAccountId = uuidv7();
      await prisma.client.accounts.create({
        data: {
          id: otherAccountId,
          household_id: otherHouseholdId,
          name: 'Theirs',
          kind: 'BANK',
          currency: 'RSD',
        },
      });
      otherCategoryId = uuidv7();
      await prisma.client.categories.create({
        data: { id: otherCategoryId, household_id: otherHouseholdId, name: 'Tudje', kind: 'EXPENSE' },
      });
    });
  });

  afterAll(async () => {
    for (const [ctx, id] of [
      [context, householdId],
      [otherContext, otherHouseholdId],
    ] as const) {
      await runWithTenant(ctx, async () => {
        // One statement: every Household-scoped table cascades from `households`, and
        // `transaction_tags` has no `household_id` for the guard to scope, so deleting the children
        // by hand would be both longer and partly impossible.
        await prisma.client.households.deleteMany({ where: { id } });
      });
    }
    await prisma.client.users.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await moduleRef?.close();
  });

  // -------------------------------------------------------------------------------------------
  // Harness
  // -------------------------------------------------------------------------------------------

  function commit(request: CaptureCommitRequest): Promise<CaptureCommitOutcome> {
    return asTenant(() => transactions.captureCommit(householdId, request));
  }

  async function rejected(request: CaptureCommitRequest): Promise<CaptureCommitRejected> {
    try {
      await commit(request);
    } catch (error) {
      if (error instanceof CaptureCommitRejected) return error;
      throw error;
    }
    throw new Error('expected the commit to be rejected, but it succeeded');
  }

  let rowCounter = 0;

  function row(overrides: Partial<CaptureCommitRow> = {}): CaptureCommitRow {
    rowCounter += 1;
    return {
      clientRowId: `row-${rowCounter}`,
      idempotencyKey: `key-${uuidv7()}`,
      accountId,
      kind: TransactionKind.EXPENSE,
      amount: money(200000n, 'RSD'),
      description: 'Lidl 2000',
      occurredOn: '2026-09-14',
      ...overrides,
    };
  }

  /** Insert a `classification_decisions` row directly, standing in for a `captureParse` preview. */
  async function proposal(args: {
    readonly categoryId: string | null;
    readonly confidence: number;
    readonly decidedBy?: string;
    readonly parseId?: string | null;
    readonly rawInput?: string;
  }): Promise<string> {
    const id = uuidv7();
    await asTenant(() =>
      prisma.client.classification_decisions.create({
        data: {
          id,
          household_id: householdId,
          raw_input: args.rawInput ?? 'Lidl 2000',
          normalized_input: 'lidl 2000',
          decided_by: args.decidedBy ?? 'RULE',
          rule_id: null,
          category_id: args.categoryId,
          confidence: args.confidence.toFixed(3),
          candidates: {
            parseId: args.parseId ?? null,
            rawConfidence: null,
            calibratedConfidence: args.confidence,
            wasAccepted: null,
          },
          ai_provider: null,
          ai_model: null,
          prompt_template_id: null,
          prompt_version: null,
          latency_ms: null,
          cost_micros: null,
        },
      }),
    );
    return id;
  }

  async function decisionById(id: string) {
    return asTenant(() =>
      prisma.client.classification_decisions.findFirst({ where: { id, household_id: householdId } }),
    );
  }

  async function transactionCount(): Promise<number> {
    return asTenant(() =>
      prisma.client.transactions.count({ where: { household_id: householdId, deleted_at: null } }),
    );
  }

  function wasAcceptedIn(candidates: unknown): unknown {
    return (candidates as Record<string, unknown> | null)?.['wasAccepted'];
  }

  // -------------------------------------------------------------------------------------------
  // The signature feature: three fragments, one action
  // -------------------------------------------------------------------------------------------

  describe('bulk commit (F-06)', () => {
    it('writes three rows in one call, with the exact money and the right direction', async () => {
      const before = await transactionCount();

      const outcome = await commit({
        rows: [
          row({ amount: money(200000n, 'RSD'), description: 'Lidl 2000' }),
          row({ amount: money(350000n, 'RSD'), description: 'gorivo 3500' }),
          row({
            amount: money(15000000n, 'RSD'),
            description: 'plata 150000',
            kind: TransactionKind.INCOME,
          }),
        ],
      });

      expect(outcome.committed).toHaveLength(3);
      expect(outcome.replayed).toBe(false);
      expect(outcome.skipped).toEqual([]);
      expect(await transactionCount()).toBe(before + 3);

      const [lidl, fuel, salary] = outcome.committed;
      // Money survives as exact minor units — 2 000 RSD is 200 000, not 2 000 and not 2000.00.
      expect(lidl!.transaction.amount.amountMinor).toBe(200000n);
      expect(fuel!.transaction.amount.amountMinor).toBe(350000n);
      expect(salary!.transaction.amount.amountMinor).toBe(15000000n);
      expect(salary!.transaction.kind).toBe(TransactionKind.INCOME);

      // Captured input is NATURAL_LANGUAGE, not MANUAL: the wedge has to be separable in analytics.
      expect(lidl!.transaction.source).toBe('NATURAL_LANGUAGE');
      // A keyword decision lands at 0.90+, so it auto-applies and the review queue stays empty.
      expect(lidl!.transaction.status).toBe(TransactionStatus.CONFIRMED);
      expect(lidl!.transaction.needsReview).toBe(false);
      expect(outcome.reviewQueueCount).toBe(0);

      const stored = await asTenant(() =>
        prisma.client.transactions.findMany({
          where: { household_id: householdId, deleted_at: null },
          orderBy: { created_at: 'asc' },
        }),
      );
      const storedLidl = stored.find((candidate) => candidate.description === 'Lidl 2000')!;
      expect(storedLidl.amount_minor).toBe(200000n);
      expect(storedLidl.occurred_local_date.toISOString().slice(0, 10)).toBe('2026-09-14');
    });

    it('classifies a row that carries no proposal, and links the decision it wrote', async () => {
      const outcome = await commit({
        rows: [row({ description: 'gorivo 3500', amount: money(350000n, 'RSD') })],
      });

      const committed = outcome.committed[0]!;
      expect(committed.transaction.categoryId).toBe(fuelId);
      expect(committed.transaction.categorySource).toBe('RULE');
      expect(committed.decisionId).not.toBeNull();

      // F-31: the audit row now points at the Transaction it produced. Before 2.2.4 this was always
      // null, so "why is this in that category?" had no answer for captured rows.
      const decision = await decisionById(committed.decisionId!);
      expect(decision?.transaction_id).toBe(committed.transaction.id);
      expect(decision?.decided_by).toBe('KEYWORD');
      expect(wasAcceptedIn(decision?.candidates)).toBe(true);
    });

    it('does not call the AI for a keyword hit, even with the provider failing', async () => {
      aiCalls.length = 0;
      await commit({ rows: [row({ description: 'Lidl 2000' })] });
      expect(aiCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------------------------
  // docs/06 §5.2.1 — atomicity, and the one deliberate exception
  // -------------------------------------------------------------------------------------------

  describe('atomicity (docs/06 §5.2.1)', () => {
    it('writes NOTHING when one row is structurally invalid', async () => {
      const before = await transactionCount();

      const error = await rejected({
        rows: [
          row({ description: 'Lidl 2000' }),
          // A category that does not exist in this Household.
          row({ description: 'gorivo 3500', categoryId: uuidv7() }),
        ],
      });

      expect(error.rows).toHaveLength(1);
      expect(error.rows[0]!.field).toBe('categoryId');
      expect(error.rows[0]!.code).toBe('NOT_FOUND');
      expect(await transactionCount()).toBe(before);
    });

    it('names EVERY offending row, not just the first', async () => {
      const error = await rejected({
        rows: [
          row({ description: 'ok', amount: money(0n, 'RSD') }),
          row({ description: 'ok', categoryId: uuidv7() }),
          row({ description: 'ok', amount: money(200000n, 'USD') }),
        ],
      });

      expect(error.rows.map((entry) => entry.field)).toEqual(['amount', 'categoryId', 'amount']);
    });

    it('refuses an EXPENSE row in an INCOME category (invariant I-3)', async () => {
      const before = await transactionCount();
      const error = await rejected({ rows: [row({ categoryId: incomeId })] });

      expect(error.rows[0]!.code).toBe('VALIDATION_FAILED');
      expect(error.rows[0]!.message).toContain('invariant I-3');
      expect(await transactionCount()).toBe(before);
    });

    it('refuses a foreign currency (ADR-011, one ledger currency per Household)', async () => {
      const error = await rejected({ rows: [row({ amount: money(2000n, 'EUR') })] });
      expect(error.rows[0]!.message).toContain('ADR-011');
    });

    it('refuses a category belonging to another Household', async () => {
      const error = await rejected({ rows: [row({ categoryId: otherCategoryId })] });
      // Invisible rather than forbidden: the guard makes it a NOT_FOUND, which leaks nothing.
      expect(error.rows[0]!.code).toBe('NOT_FOUND');
    });

    it('refuses an account belonging to another Household', async () => {
      const error = await rejected({ rows: [row({ accountId: otherAccountId })] });
      expect(error.rows[0]!.field).toBe('accountId');
    });

    it('refuses two rows claiming one idempotencyKey, naming both', async () => {
      const shared = `dup-${uuidv7()}`;
      const error = await rejected({
        rows: [
          row({ clientRowId: 'a', idempotencyKey: shared }),
          row({ clientRowId: 'b', idempotencyKey: shared }),
        ],
      });

      expect(error.code).toBe('CONFLICT');
      expect(error.rows).toHaveLength(1);
      expect(error.rows[0]!.clientRowId).toBe('b');
    });

    it('refuses a row with no date at all', async () => {
      const error = await rejected({
        rows: [row({ occurredOn: null, occurredAt: null, description: 'Lidl 2000' })],
      });
      expect(error.rows[0]!.field).toBe('occurredOn');
    });

    it('refuses a row with neither a category, a proposal, nor a description', async () => {
      const error = await rejected({
        rows: [row({ description: '   ', categoryId: null })],
      });
      expect(error.rows[0]!.field).toBe('description');
    });

    it('refuses an unknown tag rather than silently dropping the assignment', async () => {
      const error = await rejected({ rows: [row({ tagIds: [uuidv7()] })] });
      expect(error.rows[0]!.field).toBe('tagIds');
    });

    it('refuses an empty batch and an over-long batch', async () => {
      await expect(commit({ rows: [] })).rejects.toThrow(/at least one row/);
      await expect(
        commit({ rows: Array.from({ length: 51 }, () => row({ description: 'x 100' })) }),
      ).rejects.toThrow(/at most 50 rows/);
    });
  });

  // -------------------------------------------------------------------------------------------
  // The gate — docs/04 §7 and invariant I-8
  // -------------------------------------------------------------------------------------------

  describe('the confidence gate', () => {
    it('auto-applies at >= 0.90', async () => {
      const proposalId = await proposal({ categoryId: foodId, confidence: 0.95 });
      const outcome = await commit({ rows: [row({ acceptedProposalId: proposalId })] });

      const committed = outcome.committed[0]!.transaction;
      expect(committed.status).toBe(TransactionStatus.CONFIRMED);
      expect(committed.needsReview).toBe(false);
      expect(committed.confidence).toBe(0.95);
      expect(committed.categoryId).toBe(foodId);
    });

    it('applies the 0.60–0.89 band as the ADVISORY lane, which never sets needs_review', async () => {
      const proposalId = await proposal({ categoryId: foodId, confidence: 0.75 });
      const outcome = await commit({ rows: [row({ acceptedProposalId: proposalId })] });

      const committed = outcome.committed[0]!.transaction;
      // docs/06 §5.2.1 originally said `needs_review = true` here, contradicting I-8 and docs/04 §7.
      // I-8 wins: the flag IS the blocking lane, and an advisory row that set it would make the nav
      // badge never clear. The corrected table is in docs/06 §5.2.1.
      expect(committed.status).toBe(TransactionStatus.CONFIRMED);
      expect(committed.needsReview).toBe(false);
    });

    it('writes a < 0.60 row PENDING and counts it in the review queue — without blocking the batch', async () => {
      const lowId = await proposal({ categoryId: foodId, confidence: 0.5 });
      const highId = await proposal({ categoryId: fuelId, confidence: 0.95 });

      const outcome = await commit({
        rows: [
          row({ acceptedProposalId: lowId, description: 'Lidl 2000' }),
          row({ acceptedProposalId: highId, description: 'gorivo 3500' }),
        ],
      });

      expect(outcome.committed).toHaveLength(2);
      const low = outcome.committed.find((entry) => entry.transaction.categoryId === foodId)!;
      const high = outcome.committed.find((entry) => entry.transaction.categoryId === fuelId)!;

      expect(low.transaction.status).toBe(TransactionStatus.PENDING);
      expect(low.transaction.needsReview).toBe(true);
      // F-06's acceptance criterion, literally: "the other rows can still be confirmed".
      expect(high.transaction.status).toBe(TransactionStatus.CONFIRMED);
      expect(high.transaction.needsReview).toBe(false);
      expect(outcome.reviewQueueCount).toBeGreaterThanOrEqual(1);
    });

    it('promotes a low-confidence row to CONFIRMED when the user insists', async () => {
      const lowId = await proposal({ categoryId: foodId, confidence: 0.5 });
      const outcome = await commit({
        rows: [row({ acceptedProposalId: lowId, confirmDespiteLowConfidence: true })],
      });

      const committed = outcome.committed[0]!.transaction;
      expect(committed.status).toBe(TransactionStatus.CONFIRMED);
      // I-8's "unless a user explicitly cleared the flag": the explicit yes is the only thing that
      // may clear it, and it must actually clear it or the row sits in the queue forever.
      expect(committed.needsReview).toBe(false);
    });

    it('keeps a null category blocking at ANY confidence, and cannot be confirmed away', async () => {
      const nullId = await proposal({ categoryId: null, confidence: 0.99 });
      const first = await commit({ rows: [row({ acceptedProposalId: nullId, description: 'nepoznato 500' })] });

      const committed = first.committed[0]!.transaction;
      expect(committed.categoryId).toBeNull();
      expect(committed.status).toBe(TransactionStatus.PENDING);
      expect(committed.needsReview).toBe(true);

      const nullId2 = await proposal({ categoryId: null, confidence: 0.99 });
      const second = await commit({
        rows: [
          row({
            acceptedProposalId: nullId2,
            description: 'nepoznato 500',
            confirmDespiteLowConfidence: true,
          }),
        ],
      });
      // An uncategorised Transaction is an unanswered question, not a low-confidence answer: there is
      // nothing for the user to have confirmed.
      expect(second.committed[0]!.transaction.status).toBe(TransactionStatus.PENDING);
      expect(second.committed[0]!.transaction.needsReview).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Previews, overrides and discards
  // -------------------------------------------------------------------------------------------

  describe('proposals', () => {
    it('records an override as the user’s decision and marks the proposal rejected', async () => {
      const proposalId = await proposal({ categoryId: foodId, confidence: 0.95 });
      const outcome = await commit({
        rows: [row({ acceptedProposalId: proposalId, categoryId: fuelId })],
      });

      const committed = outcome.committed[0]!.transaction;
      expect(committed.categoryId).toBe(fuelId);
      expect(committed.categorySource).toBe('USER');
      expect(committed.needsReview).toBe(false);

      // docs/04 §6.4's label: the model's answer was shown and refused. Without this the re-fit
      // cannot tell a correction from an acceptance.
      const decision = await decisionById(proposalId);
      expect(wasAcceptedIn(decision?.candidates)).toBe(false);
      expect(decision?.transaction_id).toBe(committed.id);
    });

    it('writes a USER decision row when the row was typed with no proposal at all', async () => {
      const outcome = await commit({ rows: [row({ categoryId: foodId, description: 'rucno 2000' })] });
      const committed = outcome.committed[0]!;

      expect(committed.decisionId).not.toBeNull();
      const decision = await decisionById(committed.decisionId!);
      expect(decision?.decided_by).toBe('USER');
      expect(Number(decision?.confidence)).toBe(1);
      expect(decision?.transaction_id).toBe(committed.transaction.id);
    });

    it('marks a discarded fragment rejected and writes no Transaction for it', async () => {
      const keep = await proposal({ categoryId: foodId, confidence: 0.95 });
      const drop = await proposal({ categoryId: fuelId, confidence: 0.95, rawInput: 'gorivo 3500' });
      const before = await transactionCount();

      const outcome = await commit({
        rows: [row({ acceptedProposalId: keep })],
        discardProposalIds: [drop],
      });

      expect(outcome.committed).toHaveLength(1);
      expect(await transactionCount()).toBe(before + 1);

      const discarded = await decisionById(drop);
      expect(discarded?.transaction_id).toBeNull();
      expect(wasAcceptedIn(discarded?.candidates)).toBe(false);
    });

    it('refuses a proposal from a different preview', async () => {
      const proposalId = await proposal({
        categoryId: foodId,
        confidence: 0.95,
        parseId: uuidv7(),
      });
      const error = await rejected({
        parseId: uuidv7(),
        rows: [row({ acceptedProposalId: proposalId })],
      });

      expect(error.rows[0]!.field).toBe('acceptedProposalId');
      expect(error.rows[0]!.message).toContain('different preview');
    });

    it('refuses a proposal belonging to another Household', async () => {
      const foreign = uuidv7();
      await runWithTenant(otherContext, () =>
        prisma.client.classification_decisions.create({
          data: {
            id: foreign,
            household_id: otherHouseholdId,
            raw_input: 'tudje',
            normalized_input: 'tudje',
            decided_by: 'RULE',
            category_id: otherCategoryId,
            confidence: '0.950',
            candidates: {},
          },
        }),
      );

      const error = await rejected({ rows: [row({ acceptedProposalId: foreign })] });
      expect(error.rows[0]!.code).toBe('NOT_FOUND');
    });

    it('refuses a proposal that was already committed', async () => {
      const proposalId = await proposal({ categoryId: foodId, confidence: 0.95 });
      await commit({ rows: [row({ acceptedProposalId: proposalId })] });

      const second = await proposal({ categoryId: fuelId, confidence: 0.95 });
      await commit({ rows: [row({ acceptedProposalId: second })] });

      const error = await rejected({ rows: [row({ acceptedProposalId: proposalId })] });
      expect(error.rows[0]!.code).toBe('CONFLICT');
    });
  });

  // -------------------------------------------------------------------------------------------
  // I-10 — retry safety and offline dedupe
  // -------------------------------------------------------------------------------------------

  describe('idempotency and offline dedupe (I-10, docs/06 §5.2.2)', () => {
    it('returns the original row on a replay instead of writing a second one', async () => {
      const key = `replay-${uuidv7()}`;
      const clientRowId = 'replay-row';

      const first = await commit({ rows: [row({ clientRowId, idempotencyKey: key })] });
      const before = await transactionCount();

      const second = await commit({ rows: [row({ clientRowId, idempotencyKey: key })] });

      expect(await transactionCount()).toBe(before);
      expect(second.replayed).toBe(true);
      expect(second.committed).toHaveLength(1);
      expect(second.committed[0]!.wasReplayed).toBe(true);
      expect(second.committed[0]!.transaction.id).toBe(first.committed[0]!.transaction.id);
      expect(second.committed[0]!.transaction.amount.amountMinor).toBe(200000n);
    });

    it('collapses a row replayed with the same clientId under a new key', async () => {
      const clientId = uuidv7();
      const first = await commit({ rows: [row({ clientId })] });
      const before = await transactionCount();

      const second = await commit({ rows: [row({ clientId })] });

      expect(await transactionCount()).toBe(before);
      expect(second.committed[0]!.wasReplayed).toBe(true);
      expect(second.committed[0]!.transaction.id).toBe(first.committed[0]!.transaction.id);
    });

    it('reports replayed false for a batch that wrote anything', async () => {
      const key = `mixed-${uuidv7()}`;
      await commit({ rows: [row({ idempotencyKey: key })] });

      const mixed = await commit({
        rows: [row({ idempotencyKey: key }), row({ description: 'gorivo 3500' })],
      });

      expect(mixed.committed.map((entry) => entry.wasReplayed)).toEqual([true, false]);
      expect(mixed.replayed).toBe(false);
    });

    it('does not let a replay be refused by its own stale proposal link', async () => {
      // The first commit links the proposal to a Transaction; a retry echoing the same proposal must
      // still succeed, which is why the replay short-circuit runs BEFORE validation.
      const proposalId = await proposal({ categoryId: foodId, confidence: 0.95 });
      const key = `stale-${uuidv7()}`;

      await commit({ rows: [row({ acceptedProposalId: proposalId, idempotencyKey: key })] });
      const retry = await commit({ rows: [row({ acceptedProposalId: proposalId, idempotencyKey: key })] });

      expect(retry.committed[0]!.wasReplayed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Resolved entities: who resolves, who echoes, who writes
  // -------------------------------------------------------------------------------------------

  describe('resolved entities', () => {
    it('writes an echoed Counterparty into counterparty_id, never merchant_id', async () => {
      // The pipeline resolves the entity and returns it in the proposal; the **row** is what the
      // ledger writes, so the client echoes it. The column matters: `merchant_id` has a foreign key
      // to `merchants`, so a Counterparty id there is an FK violation rather than a wrong label.
      const counterpartyId = uuidv7();
      await asTenant(() =>
        prisma.client.counterparties.create({
          data: { id: counterpartyId, household_id: householdId, name: 'Roda', type: 'PERSON' },
        }),
      );

      const outcome = await commit({
        rows: [row({ description: 'Roda 3600', counterpartyId })],
      });
      const written = outcome.committed[0]!.transaction;

      expect(written.counterpartyId).toBe(counterpartyId);
      expect(written.merchantId).toBeNull();
    });

    it('writes an echoed Merchant into merchant_id', async () => {
      const merchantId = uuidv7();
      await asTenant(() =>
        prisma.client.merchants.create({
          data: { id: merchantId, household_id: householdId, name: 'Maxi' },
        }),
      );

      const outcome = await commit({ rows: [row({ description: 'Maxi 2000', merchantId })] });
      expect(outcome.committed[0]!.transaction.merchantId).toBe(merchantId);
      expect(outcome.committed[0]!.transaction.counterpartyId).toBeNull();
    });

    it('fills in the entity the fresh classification resolved when the row omits one', async () => {
      // A client that commits without previewing sends no entity, and `captureCommit` classifies the
      // row anyway to get a category — from the SAME decision. Discarding that decision's entity
      // stored a row whose category came from the pipeline while its Merchant did not, which silently
      // made `applyToSimilar` and a counterparty rule unlearnable for every non-previewing client.
      const merchantId = uuidv7();
      await asTenant(() =>
        prisma.client.merchants.create({
          data: { id: merchantId, household_id: householdId, name: 'Tempo' },
        }),
      );

      const outcome = await commit({ rows: [row({ description: 'Tempo 2000' })] });
      expect(outcome.committed[0]!.transaction.merchantId).toBe(merchantId);
    });

    it('keeps a deliberately cleared entity cleared', async () => {
      // An absent field and an explicit `null` are different instructions: absent means "the client did
      // not preview", explicit `null` means "the client decided there is no entity". The pipeline must
      // not overrule the second, which is what the row-is-the-truth rule protects.
      const merchantId = uuidv7();
      await asTenant(() =>
        prisma.client.merchants.create({
          data: { id: merchantId, household_id: householdId, name: 'Tempo' },
        }),
      );

      const outcome = await commit({ rows: [row({ description: 'Tempo 2000', merchantId: null })] });
      expect(outcome.committed[0]!.transaction.merchantId).toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------------
  // docs/06 §5.2.2 — the advisory third mechanism
  // -------------------------------------------------------------------------------------------

  describe('duplicate suspects', () => {
    it('flags a row that repeats the one just written, and still writes it', async () => {
      const description = `Lidl ${uuidv7()}`;
      const first = await commit({ rows: [row({ description })] });

      const second = await commit({ rows: [row({ description })] });

      // The row IS written — the user may legitimately have bought the same thing twice, and 01 §6
      // says "warned", not "prevented".
      expect(second.committed).toHaveLength(1);
      expect(second.duplicateSuspects).toHaveLength(1);

      const suspect = second.duplicateSuspects[0]!;
      expect(suspect.clientRowId).toBe(second.committed[0]!.clientRowId);
      expect(suspect.transactionId).toBe(second.committed[0]!.transaction.id);
      expect(suspect.existingTransactionId).toBe(first.committed[0]!.transaction.id);
      expect(suspect.similarity).toBe(1);
      expect(suspect.matchedOn).toEqual(['amount', 'description', 'date']);
    });

    it('flags two identical rows inside ONE batch, symmetrically', async () => {
      // The clearest duplicate there is, and the one a bulk entry actually produces.
      const description = `Lidl maxi ${uuidv7()}`;
      const outcome = await commit({
        rows: [row({ description }), row({ description })],
      });

      expect(outcome.committed).toHaveLength(2);
      // Per-row semantics, so the pair is reported from both sides: each row names the other. That is
      // the spec's rule applied literally ("a ROW is a suspect when…"), and it is also the honest
      // presentation — picking one as "the original" would assert which of the two the user meant,
      // which the ledger has no way to know.
      expect(outcome.duplicateSuspects).toHaveLength(2);
      const [first, second] = outcome.committed;
      expect(outcome.duplicateSuspects[0]!.transactionId).toBe(first!.transaction.id);
      expect(outcome.duplicateSuspects[0]!.existingTransactionId).toBe(second!.transaction.id);
      expect(outcome.duplicateSuspects[1]!.transactionId).toBe(second!.transaction.id);
      expect(outcome.duplicateSuspects[1]!.existingTransactionId).toBe(first!.transaction.id);
    });

    it('matches on a resolved merchant even when the descriptions differ', async () => {
      const merchantId = uuidv7();
      await asTenant(() =>
        prisma.client.merchants.create({
          data: { id: merchantId, household_id: householdId, name: `Prodavac ${merchantId.slice(0, 8)}` },
        }),
      );

      await commit({ rows: [row({ description: 'korpa 1', merchantId })] });
      const second = await commit({ rows: [row({ description: 'korpa 2', merchantId })] });

      expect(second.duplicateSuspects).toHaveLength(1);
      expect(second.duplicateSuspects[0]!.matchedOn).toContain('merchant');
      // Reported honestly: a merchant match with unlike baskets is the weak case.
      expect(second.duplicateSuspects[0]!.similarity).toBeLessThan(0.85);
    });

    it('never flags on amount alone', async () => {
      await commit({ rows: [row({ description: 'Lidl' })] });
      const second = await commit({ rows: [row({ description: 'Gorivo' })] });
      expect(second.duplicateSuspects).toHaveLength(0);
    });

    it('never flags a row in a different account or the other direction', async () => {
      const secondAccount = uuidv7();
      await asTenant(() =>
        prisma.client.accounts.create({
          data: { id: secondAccount, household_id: householdId, name: 'Keš', kind: 'CASH', currency: 'RSD' },
        }),
      );

      await commit({ rows: [row({ description: 'Lidl mesec' })] });
      const otherAccount = await commit({
        rows: [row({ description: 'Lidl mesec', accountId: secondAccount })],
      });
      const otherKind = await commit({
        rows: [row({ description: 'Lidl mesec', kind: TransactionKind.INCOME })],
      });

      expect(otherAccount.duplicateSuspects).toHaveLength(0);
      expect(otherKind.duplicateSuspects).toHaveLength(0);
    });

    it('flags against a PENDING row too, because it is still a row the user entered', async () => {
      // The correction to docs/06 §5.2.2. With no keywords, rules or AI provider — every fresh
      // signup, and F-13's cold start — every captured row is PENDING. A `CONFIRMED`-only comparison
      // would make this mechanism unreachable for exactly those households, and a user could type
      // `Lidl 2000` twice with no warning at all.
      const description = `Nepoznato ${uuidv7()}`;
      const pendingProposal = await proposal({ categoryId: null, confidence: 0.99, rawInput: description });
      const pending = await commit({ rows: [row({ description, acceptedProposalId: pendingProposal })] });
      expect(pending.committed[0]!.transaction.status).toBe(TransactionStatus.PENDING);

      const second = await commit({ rows: [row({ description })] });
      expect(second.duplicateSuspects).toHaveLength(1);
      expect(second.duplicateSuspects[0]!.existingTransactionId).toBe(
        pending.committed[0]!.transaction.id,
      );
    });

    it('never flags against a VOID row, which the user has said never happened', async () => {
      const description = `Ponistena ${uuidv7()}`;
      const first = await commit({ rows: [row({ description })] });
      await asTenant(() =>
        transactions.update(householdId, first.committed[0]!.transaction.id, {
          version: first.committed[0]!.transaction.version,
          status: TransactionStatus.VOID,
        }),
      );

      const second = await commit({ rows: [row({ description })] });
      expect(second.duplicateSuspects).toHaveLength(0);
    });

    it('returns an empty list — not an absent one — when it checked and found nothing', async () => {
      const outcome = await commit({ rows: [row({ description: `Jedinstveno ${uuidv7()}` })] });
      expect(outcome.duplicateSuspects).toEqual([]);
    });

    it('does not treat a replay as a new duplicate', async () => {
      const description = `Replay ${uuidv7()}`;
      const key = `dup-replay-${uuidv7()}`;
      await commit({ rows: [row({ description, idempotencyKey: key })] });

      const replay = await commit({ rows: [row({ description, idempotencyKey: key })] });

      expect(replay.replayed).toBe(true);
      // Nothing was written, so there is nothing that could be a duplicate of anything.
      expect(replay.duplicateSuspects).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------------------------
  // docs/02 §3 — the undo toast
  // -------------------------------------------------------------------------------------------

  describe('undoCapture', () => {
    it('soft-deletes the named rows and leaves the rest alone', async () => {
      const keep = await commit({ rows: [row({ description: `Ostaje ${uuidv7()}` })] });
      const undo = await commit({
        rows: [row({ description: `Ponisti ${uuidv7()}` }), row({ description: `Ponisti2 ${uuidv7()}` })],
      });

      const undone = await asTenant(() =>
        transactions.undoCapture(householdId, undo.committed.map((entry) => entry.transaction.id)),
      );

      expect(undone).toBe(2);
      const live = await asTenant(() =>
        prisma.client.transactions.findMany({
          where: { household_id: householdId, deleted_at: null },
          select: { id: true },
        }),
      );
      const liveIds = live.map((entry) => entry.id);
      expect(liveIds).toContain(keep.committed[0]!.transaction.id);
      expect(liveIds).not.toContain(undo.committed[0]!.transaction.id);

      // Soft, never hard: the row is still there for a later Restore (docs/03 §3.4).
      const stillStored = await asTenant(() =>
        prisma.client.transactions.findFirst({ where: { id: undo.committed[0]!.transaction.id } }),
      );
      expect(stillStored).not.toBeNull();
      expect(stillStored!.deleted_at).not.toBeNull();
    });

    it('counts only what it actually undid, and cannot touch another Household', async () => {
      const mine = await commit({ rows: [row({ description: `Moje ${uuidv7()}` })] });

      const foreign = uuidv7();
      await runWithTenant(otherContext, () =>
        prisma.client.transactions.create({
          data: {
            id: foreign,
            household_id: otherHouseholdId,
            account_id: otherAccountId,
            kind: 'EXPENSE',
            amount_minor: 100n,
            currency: 'RSD',
            description: 'Tudje',
            occurred_at: new Date(),
            occurred_local_date: new Date('2026-09-14T00:00:00.000Z'),
            source: 'MANUAL',
          },
        }),
      );

      // One real id, one foreign id, one that does not exist: the count is the honest number.
      const undone = await asTenant(() =>
        transactions.undoCapture(householdId, [mine.committed[0]!.transaction.id, foreign, uuidv7()]),
      );
      expect(undone).toBe(1);

      const foreignRow = await runWithTenant(otherContext, () =>
        prisma.client.transactions.findFirst({ where: { id: foreign } }),
      );
      expect(foreignRow!.deleted_at).toBeNull();
    });

    it('is idempotent: undoing twice reports zero the second time', async () => {
      const outcome = await commit({ rows: [row({ description: `Dvaput ${uuidv7()}` })] });
      const ids = [outcome.committed[0]!.transaction.id];

      expect(await asTenant(() => transactions.undoCapture(householdId, ids))).toBe(1);
      expect(await asTenant(() => transactions.undoCapture(householdId, ids))).toBe(0);
    });

    it('refuses an empty id list rather than silently doing nothing', async () => {
      await expect(asTenant(() => transactions.undoCapture(householdId, []))).rejects.toThrow(
        /nothing to undo/i,
      );
    });
  });

  // -------------------------------------------------------------------------------------------
  // Return shape
  // -------------------------------------------------------------------------------------------

  describe('the response', () => {
    it('returns a cursor usable as the list’s `after`, and the blocking-lane count', async () => {
      const lowId = await proposal({ categoryId: foodId, confidence: 0.5 });
      const outcome = await commit({ rows: [row({ acceptedProposalId: lowId })] });

      const cursor = outcome.cursor;
      expect(cursor).toMatch(/^[0-9a-f-]{36}$/i);
      expect(outcome.committed.map((entry) => entry.transaction.id)).toContain(cursor);
      expect(outcome.reviewQueueCount).toBe(
        await asTenant(() =>
          prisma.client.transactions.count({
            where: { household_id: householdId, needs_review: true, deleted_at: null },
          }),
        ),
      );
    });

    it('defaults the account from the request and the day from the request', async () => {
      const outcome = await commit({
        defaultAccountId: accountId,
        occurredLocalDate: '2026-03-01',
        rows: [row({ accountId: null, occurredOn: null, description: 'Lidl 2000' })],
      });

      const committed = outcome.committed[0]!.transaction;
      expect(committed.accountId).toBe(accountId);
      expect(committed.occurredLocalDate).toBe('2026-03-01');
    });

    it('keeps the raw natural-language input on the Transaction', async () => {
      const outcome = await commit({ rows: [row({ description: 'Lidl 2000' })] });
      expect(outcome.committed[0]!.transaction.rawInput).toBe('Lidl 2000');
    });
  });

  // -------------------------------------------------------------------------------------------
  // A money value the tests must not lose
  // -------------------------------------------------------------------------------------------

  it('round-trips a large amount exactly, as bigint, with no float in between', async () => {
    const huge: Money = money(9_007_199_254_740_993n, 'RSD');
    const outcome = await commit({ rows: [row({ amount: huge, description: 'veliko 90071992547409.93' })] });

    expect(outcome.committed[0]!.transaction.amount.amountMinor).toBe(9_007_199_254_740_993n);
    expect(typeof outcome.committed[0]!.transaction.amount.amountMinor).toBe('bigint');
  });
});
