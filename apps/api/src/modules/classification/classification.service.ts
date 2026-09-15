import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import type { CalibrationTable } from '@finmate/ai';
import { todayIn, uuidv7, type LocalDate } from '@finmate/domain';
import {
  extractFragment,
  extractFragments,
  foldForMatching,
  type TransactionFragment,
} from '@finmate/nlp';
import type { CategoryKeyword, Rule, Rule as EngineRule } from '@finmate/rules-engine';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import type { Prisma } from '../../generated/prisma/client';
import type { classification_decisionsModel } from '../../generated/prisma/models';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AI_CLASSIFIER,
  CLASSIFY_PROMPT,
  UNCONFIGURED_AI_CLASSIFIER,
  calibrateAiResult,
  type AiClassifier,
  type ClassifyRequest,
} from './ai-classifier';
import { resolveLaneThresholds, type LaneThresholds } from './confidence-gate';
import {
  isAiUnavailable,
  runPipeline,
  worstRung,
  type AiStageInput,
  type AiStageResult,
  type AuditCandidate,
  type DecidedBy,
  type PipelineCategory,
  type PipelineEntity,
  type PipelineHousehold,
  type PipelineOutcome,
  type PipelineRung,
} from './classification.pipeline';
import {
  KEYWORD_SELECT,
  loadRules,
  PIPELINE_TEXT_FOLDER,
  RULE_ENGINE_SELECT,
  toPipelineKeyword,
  type RuleRow,
} from './rule-adapter';

/**
 * `classification` — the orchestration layer that turns `packages/nlp`,
 * `packages/rules-engine` and `packages/ai` into the one pipeline docs/04 §2 describes.
 *
 * ## Why it is a module rather than functions in the resolvers
 *
 * Three responsibilities belong together and nowhere else:
 *
 * 1. **Stage ordering.** It loads the Household's rows, then runs `runPipeline`, which never reaches
 *    the model when a deterministic stage decided (ADR-002).
 * 2. **The audit trail (F-31).** Every decision writes a `classification_decisions` row —
 *    `raw_input`, `normalized_input`, `decided_by`, `confidence`, the losing `candidates`, and the
 *    AI's provider/model/prompt/latency/cost when a model answered. That row is what makes "why did
 *    it choose that?" answerable a month later.
 * 3. **Invariant I-8.** The gate is applied before anything is returned, so no caller can route
 *    around the blocking lane and no `null` category is stored as confidently decided.
 *
 * ## Tenancy
 *
 * Every read goes through `this.prisma.client` — the tenancy guard — and `householdId` always arrives
 * from the session (`@CurrentHouseholdId`), never from the request body (ADR-008). Nothing here uses
 * `$queryRaw`; the guard is the scope, so there is nothing to remember.
 *
 * ## Money
 *
 * `fragment.amountMinor` is a `bigint` from `packages/nlp` and stays one. It is written into the JSONB
 * audit blob as a **string** because JSON has no bigint, and a JSON number would be a float in the
 * money path (ADR-003).
 *
 * @module apps/api/src/modules/classification
 */

/** `transactions.category_source` subset the parser can produce. `USER`/`IMPORT` never come from here. */
export type ParsedCategorySource = 'RULE' | 'AI' | null;

/** Options for {@link ClassificationService.parse}. */
export interface ParseInput {
  readonly text: string;
  readonly locale?: string | null;
  /** `false` ⇒ rules and keywords only; no egress is attempted (docs/06 §5.1). */
  readonly allowAi?: boolean;
  /** The instant the capture is attributed to. Defaults to now. */
  readonly occurredAt?: Date | null;
  /** The Household's local day. Derived from the instant + timezone when absent. */
  readonly localDay?: LocalDate | null;
}

/** One classified fragment, ready for the preview and for `captureCommit`. */
export interface FragmentResult {
  /** The proposal id: `classification_decisions.id`, which `captureCommit` echoes back. */
  readonly decisionId: string;
  readonly rawText: string;
  readonly categoryId: string | null;
  readonly categorySource: ParsedCategorySource;
  /** The **calibrated** confidence (ADR-009). */
  readonly confidence: number;
  readonly decidedBy: DecidedBy;
  readonly ruleId: string | null;
  readonly rationale: string;
  readonly needsReview: boolean;
  readonly advisory: boolean;
  readonly alternatives: readonly { readonly categoryId: string; readonly confidence: number }[];
  /** Minor units as a string — never a JSON number (ADR-003). */
  readonly amountMinor: string | null;
  readonly currency: string | null;
  readonly kind: 'EXPENSE' | 'INCOME' | 'UNKNOWN';
  readonly occurredOn: string | null;
  readonly description: string;
  readonly tokens: readonly string[];
  readonly merchantId: string | null;
  readonly counterpartyId: string | null;
  readonly needsDirectionConfirmation: boolean;
  /** The losing candidates, so the UI can explain the choice (docs/04 P-3). */
  readonly candidates: readonly AuditCandidate[];
}

export interface ParseResult {
  readonly parseId: string;
  readonly rawText: string;
  readonly fragments: readonly FragmentResult[];
  readonly unresolvedSegments: readonly string[];
  /** True when at least one fragment was decided with a model's help. */
  readonly usedAi: boolean;
  /** True when this run was **not** the full pipeline (docs/04 §9's ladder). */
  readonly degraded: boolean;
  readonly rung: PipelineRung;
  readonly latencyMs: number;
}

/**
 * A row `captureCommit` must classify itself, because the preview it came from never produced a
 * proposal for it (docs/06 §5.2 classifies the whole `rows` array, not only the parsed fragments).
 */
export interface CommitRowClassification {
  /** The text to classify — normally the row's description, which the user may have edited. */
  readonly rawText: string;
  /** Per-row override of the request-level `allowAi` (docs/06 §5.1's consent switch). */
  readonly allowAi?: boolean;
}

/**
 * The read-only view of a `classification_decisions` row that `captureCommit` needs.
 *
 * Deliberately not the Prisma row: the ledger has no business with `prompt_template_id` or the raw
 * JSON blob, and narrowing it here keeps the audit table's shape free to change.
 */
export interface DecisionSnapshot {
  readonly id: string;
  /** `null` is the blocking lane whatever the confidence was (I-8). */
  readonly categoryId: string | null;
  /** The **calibrated** confidence, `null` when the row never carried one. */
  readonly confidence: number | null;
  readonly decidedBy: DecidedBy;
  readonly ruleId: string | null;
  readonly rawInput: string;
  /** The parse this decision came from, so a commit can prove the preview it echoes is its own. */
  readonly parseId: string | null;
  /** Non-null when the row was already committed — a decision is linked to at most one Transaction. */
  readonly transactionId: string | null;
}

/**
 * How the user resolved a proposal.
 *
 * This is docs/04 §6.4's `was_accepted` label: the weekly re-fit consumes `(raw_confidence, accepted)`
 * pairs, and without it a correction and an acceptance are indistinguishable in the audit trail.
 *
 * - `ACCEPTED` — the proposal's category was committed unchanged.
 * - `OVERRIDDEN` — the row was committed with a category the user chose instead.
 * - `DISCARDED` — the fragment was removed from the preview and produced no Transaction at all.
 */
export type DecisionOutcome = 'ACCEPTED' | 'OVERRIDDEN' | 'DISCARDED';

/** One fragment as the pipeline saw it, before mapping to the API shape. */
interface ClassifiedFragment {
  readonly pipeline: PipelineOutcome;
  readonly fragment: TransactionFragment;
}

/** Everything one parse needs, loaded in scoped queries only. */
interface HouseholdContext {
  readonly household: PipelineHousehold;
  readonly thresholds: LaneThresholds;
  readonly categories: readonly PipelineCategory[];
  readonly keywords: readonly CategoryKeyword[];
  readonly rules: readonly EngineRule[];
  readonly merchants: readonly PipelineEntity[];
  readonly counterparts: readonly PipelineEntity[];
}

/**
 * Where §6.4's fitted calibration maps are read from.
 *
 * `packages/ai` deliberately owns no storage — it *computes* a map from samples and *applies* a map it
 * is handed — so the request path needs one small port for "load the maps for this Household". The
 * default returns none, which means every model decision goes through §6.4's conservative
 * `raw × 0.85` shrink: a raw `0.95` lands at `0.8075`, in the verify lane, never auto-applied. That is
 * the safe direction, and it is why an un-fitted model cannot silently auto-apply on day one.
 *
 * **There is no fitted-map storage yet.** The weekly re-fit job and the table it writes belong to the
 * calibration task; inventing one here would be a migration with no producer. This port is the
 * override point, and a test supplies a fitted table through it to prove the request path honours one.
 */
export interface CalibrationStore {
  tableFor(householdId: string): Promise<CalibrationTable | undefined>;
}

export const CALIBRATION_STORE = Symbol('CALIBRATION_STORE');

/** The default: no fitted maps, therefore §6.4's shrink for every model call. */
export const NO_CALIBRATION: CalibrationStore = {
  tableFor: (): Promise<undefined> => Promise.resolve(undefined),
};

/** Overrides the locale the classifier is told about. Injectable so a test can pin it. */
export const CLASSIFY_LOCALE = 'sr-Latn';

@Injectable()
export class ClassificationService {
  private readonly logger = new Logger(ClassificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Optional so a unit or integration test can construct the service without a module. The module
    // always provides both, and these defaults are the honest degraded behaviour, not test stubs.
    @Optional()
    @Inject(AI_CLASSIFIER)
    private readonly classifier: AiClassifier = UNCONFIGURED_AI_CLASSIFIER,
    @Optional()
    @Inject(CALIBRATION_STORE)
    private readonly calibration: CalibrationStore = NO_CALIBRATION,
  ) {}

  /**
   * `captureParse` — docs/06 §5.1. Read-only with respect to the ledger; writes one
   * `classification_decisions` row per fragment for audit and cost.
   */
  async parse(householdId: string, input: ParseInput): Promise<ParseResult> {
    const startedAt = Date.now();
    const text = input.text ?? '';
    if (text.trim().length === 0) {
      throw new ApiError('VALIDATION_FAILED', 'Capture text is required.');
    }

    const context = await this.loadContext(householdId);
    const occurredAt = input.occurredAt ?? new Date();
    const localDay = input.localDay ?? todayIn(context.household.timeZone, occurredAt);
    const allowAi = input.allowAi ?? true;
    const calibration = await this.calibration.tableFor(householdId);
    const parseId = uuidv7();

    const segments = extractFragments(text, {
      currency: context.household.currency as Parameters<typeof extractFragments>[1]['currency'],
      today: localDay,
    });

    const fragments: FragmentResult[] = [];
    let rung: PipelineRung = 'FULL_PIPELINE';

    for (let index = 0; index < segments.length; index += 1) {
      const fragment = segments[index]!;
      const classified = await this.classifyFragment({
        householdId,
        fragment,
        context,
        localDay,
        index,
        count: segments.length,
        allowAi,
        calibration,
        locale: input.locale ?? null,
      });

      const decisionId = await this.recordDecision(householdId, {
        parseId,
        fragment,
        pipeline: classified.pipeline,
      });

      rung = worstRung(rung, classified.pipeline.rung);
      fragments.push(this.toFragmentResult(decisionId, fragment, classified.pipeline, context));
    }

    const unresolvedSegments = fragments
      .filter((fragment) => fragment.amountMinor === null && fragment.tokens.length === 0)
      .map((fragment) => fragment.rawText);

    return {
      parseId,
      rawText: text,
      fragments,
      unresolvedSegments,
      usedAi: fragments.some((fragment) => fragment.decidedBy === 'AI'),
      degraded: rung !== 'FULL_PIPELINE',
      rung,
      latencyMs: Date.now() - startedAt,
    };
  }

  /**
   * Classify one already-segmented fragment.
   *
   * Extracted from {@link parse} so the "re-classify a row the preview never saw" path and the parse
   * path share one implementation — a second copy is how the AI ends up called twice.
   */
  async classifyFragment(args: {
    readonly householdId: string;
    readonly fragment: TransactionFragment;
    readonly context: HouseholdContext;
    readonly localDay: LocalDate;
    readonly index: number;
    readonly count: number;
    readonly allowAi: boolean;
    readonly calibration: CalibrationTable | undefined;
    /** The input's locale when the caller supplied one. */
    readonly locale?: string | null;
  }): Promise<ClassifiedFragment> {
    const pipeline = await runPipeline({
      fragment: args.fragment,
      household: args.context.household,
      categories: args.context.categories,
      keywords: args.context.keywords,
      rules: args.context.rules,
      merchants: args.context.merchants,
      counterparties: args.context.counterparts,
      folder: PIPELINE_TEXT_FOLDER,
      localDay: args.localDay,
      thresholds: args.context.thresholds,
      // `undefined` is the honest signal that no model may be called: it covers both
      // `allowAi: false` and "no provider configured" without either looking like a failed call.
      ai: args.allowAi ? this.aiStage(args, args.calibration) : undefined,
      fragmentIndex: args.index,
      fragmentCount: args.count,
    });

    return { pipeline, fragment: args.fragment };
  }

  // -------------------------------------------------------------------------------------------
  // The AI stage
  // -------------------------------------------------------------------------------------------

  /**
   * Bind the injected classifier to a pipeline-shaped callback.
   *
   * The callback is only ever *created* when AI is permitted, and the pipeline only ever *calls* it
   * when rules, keywords and entity defaults were all inconclusive. That is the structural half of
   * ADR-002: there is no path from a rule hit to this function.
   */
  private aiStage(
    args: {
      readonly householdId: string;
      readonly context: HouseholdContext;
      readonly locale?: string | null;
    },
    calibration: CalibrationTable | undefined,
  ): (input: AiStageInput) => Promise<AiStageResult> {
    return async (input: AiStageInput): Promise<AiStageResult> => {
      const request: ClassifyRequest = {
        fragment: input.fragment,
        ...(input.merchantName ? { merchantName: input.merchantName } : {}),
        ...(input.counterpartyName ? { counterpartyName: input.counterpartyName } : {}),
        keywordCandidates: input.keywordCandidates,
        categories: args.context.categories,
        household: args.context.household,
        // The caller's locale when it supplied one, so a Household that reads cyrillic gets the
        // prompt it asked for. Falls back to Serbian latin rather than inventing a language.
        locale: args.locale ?? CLASSIFY_LOCALE,
        ...(calibration ? { calibration } : {}),
      };

      const result = await this.classifier.classify(request);
      if (isAiUnavailable(result)) {
        this.logger.debug(
          `classify unavailable for ${args.householdId}: ${result.reason} (rung ${result.rung})`,
        );
        return result;
      }
      // §6.4 runs here, on the way in, so every AI confidence the gate sees is calibrated —
      // including one produced by a test double.
      return calibrateAiResult(result, calibration);
    };
  }

  // -------------------------------------------------------------------------------------------
  // The audit row (F-31)
  // -------------------------------------------------------------------------------------------

  /**
   * Write the `classification_decisions` row for one fragment.
   *
   * ## The calibrated-vs-raw problem, and how it is resolved
   *
   * docs/04 §6.4 requires the weekly re-fit to consume `(raw_confidence, was_accepted)` pairs, but the
   * DDL has **one** confidence column (`numeric(4,3)`, three decimals). The brief's rule is that the
   * column stores the **calibrated** value — the gate consumes it and the UI renders it.
   *
   * So the raw number is stored inside the `candidates` JSONB blob, alongside the parse id and every
   * losing candidate. Both halves are then recoverable from one row without a migration:
   *
   * ```jsonc
   * { "parseId": "…", "rawConfidence": 0.91, "calibratedConfidence": 0.774, "candidates": [ … ] }
   * ```
   *
   * **What that costs.** The raw value is not a first-class column, so a re-fit cannot
   * `GROUP BY raw_confidence` or index it — it must read and parse the JSON over a bounded window.
   * At docs/04 §12's volumes that is a nightly job, not a hot path, so the trade is worth taking. If
   * the re-fit ever needs a real index, the fix is one additive `raw_confidence numeric(4,3)` column:
   * a migration, and deliberately not one taken speculatively here.
   *
   * `confidence` is written as a **decimal string** (`"0.774"`, `toFixed(3)`), which is exactly what
   * `numeric(4,3)` holds. No float is on the wire, and no float ever touches money.
   */
  private async recordDecision(
    householdId: string,
    args: {
      readonly parseId: string;
      readonly fragment: TransactionFragment;
      readonly pipeline: PipelineOutcome;
    },
  ): Promise<string> {
    const { pipeline, fragment } = args;
    const ai = pipeline.ai;

    const candidates = {
      parseId: args.parseId,
      // The raw half of §6.4's pair. `null` when no model ran — an absent value, never a zero.
      rawConfidence: pipeline.rawConfidence,
      calibratedConfidence: Number(pipeline.confidence.toFixed(3)),
      rationale: pipeline.rationale,
      source: pipeline.decidedBy,
      entityId: pipeline.entityId,
      rung: pipeline.rung,
      amount: {
        amountMinor: fragment.amountMinor?.toString() ?? null,
        currency: fragment.currency,
        candidates: fragment.candidates.map((candidate) => ({
          amountMinor: candidate.amountMinor.toString(),
          reason: candidate.reason,
        })),
      },
      alternatives: pipeline.candidates
        .filter((candidate) => candidate.kind === 'DEFAULT' && candidate.categoryId !== undefined)
        .map((candidate) => ({
          categoryId: candidate.categoryId,
          confidence: candidate.confidence ?? null,
        })),
      candidates: [...pipeline.candidates],
      // docs/04 §6.4's `was_accepted`, which is a *later* fact than this row: the user accepts,
      // overrides or discards the proposal in `captureCommit`. `null` is "not resolved yet", which
      // must stay distinguishable from `false` ("shown and rejected") — a re-fit that reads an
      // unresolved proposal as a rejection would train on answers nobody ever gave.
      wasAccepted: null,
    };

    const id = uuidv7();
    await this.prisma.client.classification_decisions.create({
      data: {
        id,
        household_id: householdId,
        raw_input: fragment.rawText,
        // The canonical folded form: the same fold every keyword and alias is stored in, so a
        // `normalized_input` search agrees with what matching actually compared (docs/04 §3.1).
        normalized_input: foldForMatching(fragment.rawText),
        decided_by: pipeline.decidedBy,
        rule_id: pipeline.ruleId,
        // A null category is written as null, never defaulted: I-8 reads `category_id IS NULL` to
        // keep the row in the blocking lane.
        category_id: pipeline.categoryId,
        // numeric(4,3) as a decimal string — the CALIBRATED value, three decimals (docs/04 §7).
        confidence: pipeline.confidence.toFixed(3),
        // The audit blob crosses the DB boundary as JSON. The cast is not a widening of what is
        // stored — every value in it is already a JSON-safe scalar or array, and every amount is a
        // decimal STRING — it is only what lets a strongly-typed object literal satisfy Prisma's
        // `InputJsonObject` index signature (ADR-003 is about money, and no number here is money).
        candidates: candidates as unknown as Prisma.InputJsonObject,
        // docs/04 §9: provider, model and prompt identity on every call, so a regression is
        // attributable. `null` rather than `0`/"" when no call shipped, so "no model" and "a model
        // that reported nothing" stay distinguishable.
        ai_provider: ai?.provider ?? null,
        ai_model: ai?.model ?? null,
        prompt_template_id: ai === null ? null : prompts.templateId(),
        prompt_version: ai === null ? null : CLASSIFY_PROMPT.version,
        latency_ms: ai?.latencyMs ?? null,
        cost_micros: ai === null ? null : BigInt(ai.costMicros),
      },
    });

    return id;
  }

  /**
   * Classify rows that no preview produced a proposal for, in **one** Household-context load.
   *
   * `captureCommit` accepts rows the client built itself — an edited description, a row typed
   * straight into the commit, an offline outbox replay. Those still need a category and still need an
   * audit row, and the honest way to get them is the same pipeline rather than a second classifier
   * call. One context load for the whole batch, because `loadContext` is five queries and a 50-row
   * commit must not be 250 of them.
   *
   * Returns one {@link FragmentResult} per input, in input order, each already carrying the id of the
   * `classification_decisions` row it wrote.
   */
  async classifyForCommit(
    householdId: string,
    rows: readonly CommitRowClassification[],
    options: {
      readonly allowAi?: boolean;
      readonly locale?: string | null;
      readonly occurredAt?: Date | null;
      readonly localDay?: LocalDate | null;
    } = {},
  ): Promise<FragmentResult[]> {
    if (rows.length === 0) return [];

    const context = await this.loadContext(householdId);
    const occurredAt = options.occurredAt ?? new Date();
    const localDay = options.localDay ?? todayIn(context.household.timeZone, occurredAt);
    const allowAi = options.allowAi ?? true;
    const calibration = await this.calibration.tableFor(householdId);
    const parseId = uuidv7();

    const results: FragmentResult[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      // `extractFragment`, not `extractFragments`: a commit row is one known row, and re-segmenting
      // its description could split it into several fragments the caller never asked about.
      const fragment = extractFragment(row.rawText, {
        currency: context.household.currency as Parameters<typeof extractFragment>[1]['currency'],
        today: localDay,
      });

      const classified = await this.classifyFragment({
        householdId,
        fragment,
        context,
        localDay,
        index,
        count: rows.length,
        allowAi: row.allowAi ?? allowAi,
        calibration,
        locale: options.locale ?? null,
      });

      const decisionId = await this.recordDecision(householdId, {
        parseId,
        fragment,
        pipeline: classified.pipeline,
      });
      results.push(this.toFragmentResult(decisionId, fragment, classified.pipeline, context));
    }

    return results;
  }

  /**
   * Read the decisions a commit echoes back, in one scoped query.
   *
   * A caller that passes an id it cannot read simply does not find it here — the tenancy guard makes
   * another Household's decision invisible rather than forbidden, exactly like `findFirst` on any
   * other scoped model. The caller decides whether a missing id is a client bug (it is).
   */
  async decisionsByIds(
    householdId: string,
    ids: readonly string[],
  ): Promise<Map<string, DecisionSnapshot>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();

    const rows = await this.prisma.client.classification_decisions.findMany({
      where: { household_id: householdId, id: { in: unique } },
      select: {
        id: true,
        category_id: true,
        confidence: true,
        decided_by: true,
        rule_id: true,
        raw_input: true,
        transaction_id: true,
        candidates: true,
      },
    });

    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          categoryId: row.category_id,
          // `numeric(4,3)` comes back as a Prisma Decimal, so a `Number` is a widening of the
          // storage type — not a float in the money path (ADR-003 governs `amount_minor`).
          confidence: row.confidence === null ? null : Number(row.confidence),
          decidedBy: row.decided_by as DecidedBy,
          ruleId: row.rule_id,
          rawInput: row.raw_input,
          parseId: readParseId(row.candidates),
          transactionId: row.transaction_id,
        },
      ]),
    );
  }

  /**
   * Record a category the user chose themselves as a decision row.
   *
   * Without this a capture the user categorised by hand would have **no** `classification_decisions`
   * row, so F-31's "why is it in this category?" would answer nothing for exactly the rows the user
   * cared enough to fix. `confidence = 1.000` is not a model claim: the user asserted it, and the lane
   * it lands in (`>= 0.90`) is the honest one — no review prompt for a decision a human just made.
   */
  async recordUserChoice(
    householdId: string,
    args: { readonly rawText: string; readonly categoryId: string },
  ): Promise<string> {
    const id = uuidv7();
    await this.prisma.client.classification_decisions.create({
      data: {
        id,
        household_id: householdId,
        raw_input: args.rawText,
        normalized_input: foldForMatching(args.rawText),
        decided_by: 'USER',
        rule_id: null,
        category_id: args.categoryId,
        confidence: '1.000',
        candidates: {
          parseId: null,
          rawConfidence: null,
          calibratedConfidence: 1,
          rationale: 'USER_CHOICE',
          source: 'USER',
          entityId: null,
          rung: 'FULL_PIPELINE',
          alternatives: [],
          candidates: [],
          wasAccepted: null,
        } as unknown as Prisma.InputJsonObject,
        ai_provider: null,
        ai_model: null,
        prompt_template_id: null,
        prompt_version: null,
        latency_ms: null,
        cost_micros: null,
      },
    });
    return id;
  }

  /**
   * Attach a decision to the Transaction it produced, and record how the user resolved it.
   *
   * `classification_decisions.transaction_id` is nullable because docs/06 §5.1 says `captureParse`
   * writes the row for audit/cost while committing nothing; `captureCommit` is what closes the loop.
   *
   * The merge is a read-then-write rather than a JSONB patch, and that is deliberate: the update goes
   * through the tenancy guard's scoped `updateMany` instead of a raw statement, so a future column
   * rename cannot quietly turn this into an unscoped write. A commit is at most 50 rows, so one extra
   * read each is not a hot path.
   */
  async attachToTransaction(
    householdId: string,
    decisionId: string,
    transactionId: string,
    outcome: DecisionOutcome = 'ACCEPTED',
    db?: Prisma.TransactionClient,
  ): Promise<void> {
    await this.setResolution(
      householdId,
      decisionId,
      { transactionId, wasAccepted: outcome === 'ACCEPTED' },
      db,
    );
  }

  /**
   * Record fragments the user removed from the preview.
   *
   * They produced no Transaction, so `transaction_id` stays `null` — what changes is the
   * `wasAccepted: false` label, which is the only durable evidence that a proposal was shown and
   * rejected rather than never generated.
   */
  async markDiscarded(
    householdId: string,
    decisionIds: readonly string[],
    db?: Prisma.TransactionClient,
  ): Promise<void> {
    for (const decisionId of [...new Set(decisionIds)]) {
      await this.setResolution(householdId, decisionId, { transactionId: null, wasAccepted: false }, db);
    }
  }

  /**
   * `db` is the caller's interactive-transaction client when this runs as part of a commit.
   *
   * That matters: the ledger writes the Transaction and its audit link atomically, so this must run
   * on the **same** connection as the write. Defaulting to the outer client keeps the standalone
   * caller (the audit-link path) working, and passing `tx` is what stops the "outer client inside its
   * own transaction" stall this codebase has already been bitten by.
   */
  private async setResolution(
    householdId: string,
    decisionId: string,
    patch: { readonly transactionId: string | null; readonly wasAccepted: boolean },
    db: Prisma.TransactionClient = this.prisma.client,
  ): Promise<void> {
    const row = await db.classification_decisions.findFirst({
      where: { id: decisionId, household_id: householdId },
      select: { candidates: true },
    });
    if (row === null) {
      // A decision that is not this Household's, or was never written, is a caller bug. Silently
      // succeeding would leave a committed Transaction with no audit trail and no way to notice.
      throw new ApiError('NOT_FOUND', 'Classification decision not found for this household.');
    }

    const existing =
      row.candidates !== null && typeof row.candidates === 'object' && !Array.isArray(row.candidates)
        ? (row.candidates as Record<string, unknown>)
        : {};

    await db.classification_decisions.updateMany({
      where: { id: decisionId, household_id: householdId },
      data: {
        transaction_id: patch.transactionId,
        candidates: { ...existing, wasAccepted: patch.wasAccepted } as Prisma.InputJsonObject,
      },
    });
  }

  /** The audit trail for one Transaction (F-31), newest first. */
  async decisionsForTransaction(householdId: string, transactionId: string) {
    // `transaction_id` is a second predicate on top of the guard's `household_id`, so a
    // cross-Household id returns an empty list rather than another Household's audit trail.
    return this.prisma.client.classification_decisions.findMany({
      where: { household_id: householdId, transaction_id: transactionId },
      orderBy: { created_at: 'desc' },
    });
  }

  /**
   * The audit row for each of several Transactions, keyed by `transaction_id`.
   *
   * One query for a whole commit, not one per row: `captureCommit` returns the decision behind every
   * Transaction it wrote, and a 50-row batch issuing 50 reads to render its own response would make
   * the capture path's cost scale with the batch size for no reason.
   *
   * A Transaction has at most one decision — the write path creates or links exactly one — so a
   * later row overwriting an earlier one cannot lose information.
   */
  async decisionsForTransactions(
    householdId: string,
    transactionIds: readonly string[],
  ): Promise<Map<string, classification_decisionsModel>> {
    const unique = [...new Set(transactionIds)];
    if (unique.length === 0) return new Map();

    const rows = await this.prisma.client.classification_decisions.findMany({
      where: { household_id: householdId, transaction_id: { in: unique } },
    });
    return new Map(rows.map((row) => [row.transaction_id as string, row]));
  }

  // -------------------------------------------------------------------------------------------
  // Loading the Household's rows
  // -------------------------------------------------------------------------------------------

  /**
   * Load everything the pipeline needs, in scoped queries only.
   *
   * `merchant_aliases` / `counterparty_aliases` carry no `household_id`, so they are reached through
   * their parent — the tenancy guard refuses them directly, and the alias set belongs to the entity,
   * which is already scoped.
   *
   * **Merchants are read with the strict household predicate, not the global-read one.** The guard's
   * `HOUSEHOLD_SCOPED_WITH_GLOBAL_READS` rule widens *reads* to `household_id = ctx OR household_id
   * IS NULL`, which is what makes the 38 seeded Merchants resolvable — the seeded catalogue is exactly
   * the case docs/04 §4's rung 2 needs to hit. Nothing here can write through that widening because
   * this method only reads.
   */
  /**
   * The rule engine's inputs for one Household — `rules` and `category_keywords`, nothing else.
   *
   * Split out of {@link loadContext} because `RulesService`'s conflict check needs exactly these two
   * and nothing else, and loading five tables (categories, merchants, counterparties) to answer "who
   * wins on this input" would be four wasted queries per check. The two `select` objects and the
   * keyword mapping are shared with `loadContext`, so the pipeline and the guardrail cannot disagree
   * about what a rule or a keyword *is* — the failure mode that would make the guardrail's answer
   * wrong in a way nobody notices until a rule silently does nothing.
   */
  async ruleInputs(
    householdId: string,
  ): Promise<{ rules: readonly Rule[]; keywords: readonly CategoryKeyword[] }> {
    const [ruleRows, keywordRows] = await Promise.all([
      this.prisma.client.rules.findMany({
        where: { household_id: householdId, is_active: true, deleted_at: null },
        select: RULE_ENGINE_SELECT,
      }),
      this.prisma.client.category_keywords.findMany({
        where: { household_id: householdId },
        select: KEYWORD_SELECT,
      }),
    ]);

    const { rules, rejected } = loadRules(ruleRows as RuleRow[]);
    if (rejected.length > 0) {
      this.logger.warn(
        `skipped ${rejected.length} malformed rule(s) for household ${householdId}: ${rejected.join(', ')}`,
      );
    }

    return { rules, keywords: keywordRows.map(toPipelineKeyword) };
  }

  /**
   * The display names of the entities a Transaction resolved.
   *
   * Needed because a synthesised rule's *name* and explanation read as "Lidl → Hrana", while the rule
   * itself stores the id. Reads the same two tables `loadContext` already reads (Merchants through the
   * guard's global-read widening, Counterparties strictly scoped), so this adds no new access.
   */
  async entityNames(
    householdId: string,
    ids: { readonly merchantId: string | null; readonly counterpartyId: string | null },
  ): Promise<{ merchantName: string | null; counterpartyName: string | null }> {
    const [merchant, counterparty] = await Promise.all([
      ids.merchantId === null
        ? Promise.resolve(null)
        : this.prisma.client.merchants.findFirst({
            where: { id: ids.merchantId, deleted_at: null },
            select: { name: true },
          }),
      ids.counterpartyId === null
        ? Promise.resolve(null)
        : this.prisma.client.counterparties.findFirst({
            where: { id: ids.counterpartyId, deleted_at: null },
            select: { name: true },
          }),
    ]);

    // Left un-scoped for the read by the guard, and the household predicate is the id itself: an id
    // from another Household simply does not resolve, so a name is never borrowed.
    void householdId;

    return {
      merchantName: merchant?.name ?? null,
      counterpartyName: counterparty?.name ?? null,
    };
  }

  private async loadContext(householdId: string): Promise<HouseholdContext> {
    const household = await this.prisma.client.households.findFirst({ where: { id: householdId } });
    if (!household) throw new ApiError('NOT_FOUND', 'Household not found.');

    const [categories, keywordRows, ruleRows, merchantRows, counterpartyRows] = await Promise.all([
      this.prisma.client.categories.findMany({
        where: { household_id: householdId, deleted_at: null },
        select: { id: true, name: true, parent_id: true, kind: true, ai_description: true },
      }),
      this.prisma.client.category_keywords.findMany({
        where: { household_id: householdId },
        select: KEYWORD_SELECT,
      }),
      this.prisma.client.rules.findMany({
        where: { household_id: householdId, is_active: true, deleted_at: null },
        select: RULE_ENGINE_SELECT,
      }),
      this.prisma.client.merchants.findMany({
        where: { household_id: householdId, deleted_at: null },
        select: {
          id: true,
          name: true,
          default_category_id: true,
          merchant_aliases: { select: { alias: true } },
        },
      }),
      this.prisma.client.counterparties.findMany({
        where: { household_id: householdId, deleted_at: null },
        select: {
          id: true,
          name: true,
          default_category_id: true,
          counterparty_aliases: { select: { alias: true } },
        },
      }),
    ]);

    const { rules, rejected } = loadRules(ruleRows as RuleRow[]);
    if (rejected.length > 0) {
      // Loud, not silent: a user whose rule stopped applying has a real problem, and the alternative
      // (letting the engine throw) would take the whole capture down over one bad document.
      this.logger.warn(
        `skipped ${rejected.length} malformed rule(s) for household ${householdId}: ${rejected.join(', ')}`,
      );
    }

    return {
      household: { currency: household.ledger_currency, timeZone: household.iana_timezone },
      thresholds: resolveLaneThresholds(household.settings),
      categories: withBreadcrumbs(categories),
      keywords: keywordRows.map(toPipelineKeyword),
      rules,
      merchants: merchantRows.map(toEntity),
      counterparts: counterpartyRows.map(toEntity),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Mapping to the API shape
  // -------------------------------------------------------------------------------------------

  private toFragmentResult(
    decisionId: string,
    fragment: TransactionFragment,
    pipeline: PipelineOutcome,
    context: HouseholdContext,
  ): FragmentResult {
    return {
      decisionId,
      rawText: fragment.rawText,
      categoryId: pipeline.categoryId,
      // `keyword` is a rule the user wrote, so it maps to RULE — `transactions.category_source`
      // has no KEYWORD arm, and it does not need one: the audit row carries the precise source.
      categorySource:
        pipeline.decidedBy === 'AI'
          ? 'AI'
          : pipeline.decidedBy === 'RULE' || pipeline.decidedBy === 'KEYWORD'
            ? 'RULE'
            : null,
      confidence: Number(pipeline.confidence.toFixed(3)),
      decidedBy: pipeline.decidedBy,
      ruleId: pipeline.ruleId,
      rationale: pipeline.rationale,
      // I-8's blocking flag, straight from the gate — never recomputed here.
      needsReview: pipeline.gate.needsReview,
      advisory: pipeline.gate.advisory,
      alternatives: pipeline.candidates
        .filter((candidate) => candidate.kind === 'DEFAULT' && candidate.categoryId !== undefined)
        .map((candidate) => ({
          categoryId: candidate.categoryId as string,
          confidence: candidate.confidence ?? 0,
        })),
      amountMinor: fragment.amountMinor?.toString() ?? null,
      currency: fragment.currency ?? context.household.currency,
      kind: fragment.kind,
      occurredOn: fragment.occurredOn,
      description: fragment.description,
      tokens: fragment.tokens,
      // The **resolved** entities, not the deciding one: `pipeline.entityId` is a Merchant *or* a
      // Counterparty depending on `decidedBy`, and putting that in `merchantId` wrote a Counterparty
      // id into a column with a foreign key to `merchants`.
      merchantId: pipeline.resolvedMerchantId,
      counterpartyId: pipeline.resolvedCounterpartyId,
      needsDirectionConfirmation: fragment.needsDirectionConfirmation,
      candidates: [...pipeline.candidates],
    };
  }
}

/**
 * The `parseId` a decision recorded, read back out of its `candidates` blob.
 *
 * `captureCommit` uses it to check that the `acceptedProposalId` a client echoes really came from the
 * preview it names. Returns `null` for anything unexpected rather than throwing: the blob is opaque
 * JSON, and a value that is not a string is simply not a parse id.
 */
function readParseId(candidates: unknown): string | null {
  if (candidates === null || typeof candidates !== 'object' || Array.isArray(candidates)) return null;
  const value = (candidates as Record<string, unknown>)['parseId'];
  return typeof value === 'string' ? value : null;
}

/** One Merchant/Counterparty row → the pipeline's entity shape. */
function toEntity(row: {
  readonly id: string;
  readonly name: string;
  readonly default_category_id: string | null;
  readonly merchant_aliases?: readonly { readonly alias: string }[];
  readonly counterparty_aliases?: readonly { readonly alias: string }[];
}): PipelineEntity {
  return {
    id: row.id,
    name: row.name,
    aliases: [
      ...(row.merchant_aliases ?? []).map((alias) => alias.alias),
      ...(row.counterparty_aliases ?? []).map((alias) => alias.alias),
    ],
    defaultCategoryId: row.default_category_id,
  };
}

/**
 * The one thing this build cannot fill in: `prompt_templates.id`.
 *
 * The §6.3 template is rendered in-process (see `classify-prompt.ts`) and no `prompt_templates` seed
 * exists yet, so there is no UUID to reference and the FK would reject a synthetic one. `null` is the
 * honest value, and `prompt_version` **is** recorded, so a regression is still attributable to a
 * template revision. The seed and the `prompt_templates` row land with prompt management; this is the
 * one column that waits on it. Isolated in an object so there is exactly one place to change.
 */
const prompts = {
  templateId: (): string | null => null,
};


/**
 * Attach each Category's display breadcrumb.
 *
 * The prompt renders `path` (`Hrana / Supermarket`), and the classifier's closed list is only useful
 * to the model when a category reads as a path rather than a bare name — `Ostalo` under `Hrana` and
 * `Ostalo` under `Auto` are otherwise the same string. Built with one pass over the rows, not a
 * walk per category, and it cannot loop: `CategoriesService` refuses a cycle on write and
 * `findTreeViolations` would have failed the request first.
 */
function withBreadcrumbs(
  rows: readonly {
    readonly id: string;
    readonly name: string;
    readonly parent_id: string | null;
    readonly kind: string;
    readonly ai_description: string | null;
  }[],
): PipelineCategory[] {
  const byId = new Map(rows.map((row) => [row.id, row]));

  return rows.map((row) => {
    const crumbs: string[] = [];
    let cursor: string | null = row.id;
    const seen = new Set<string>();
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      const node = byId.get(cursor);
      if (node === undefined) break;
      crumbs.unshift(node.name);
      cursor = node.parent_id;
    }
    const path = crumbs.join(' / ');
    return {
      id: row.id,
      name: row.name,
      path,
      parentId: row.parent_id,
      kind: row.kind,
      aiDescription: row.ai_description,
    };
  });
}
