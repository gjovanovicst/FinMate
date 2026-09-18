import { Injectable } from '@nestjs/common';

import { uuidv7 } from '@finmate/domain';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import { PrismaService } from '../../prisma/prisma.service';
import { ClassificationService } from './classification.service';
import { RulesService, type RuleConflictView, type RuleView, type ShadowCheck } from './rules.service';
import type { CorrectionSubject, RuleSynthesis, RuleSynthesisTrigger } from './rule-synthesis';

/**
 * `corrections` — the append-only learning signal (docs/04 §8, docs/05 §3).
 *
 * A Correction is not an edit log; it is the durable record that **the product was wrong** and the
 * user said so. Three things read it: the "was this proposal any good?" question, the weekly
 * calibration re-fit (§6.4), and rule synthesis. So it is written for every correction, including one
 * the user does not want remembered — the *refusal to remember* is itself evidence about synthesis
 * quality, and losing it would make synthesis look better than it is.
 *
 * Corrections are never deleted, and `corrections.rule_created_id` is `ON DELETE SET NULL`, so
 * deleting a rule does not erase the fact that a correction produced one.
 *
 * ## What this service deliberately does not do
 *
 * It never reads `transactions`. The correction **subject** — the Transaction's text plus the names of
 * the entities it resolved — belongs to the ledger and the taxonomy, so the caller composes it and
 * passes it in. That keeps the module edge one-directional (`ledger → classification`, which
 * `captureCommit` already established) instead of a cycle, and it is honest about the fact that this
 * service owns exactly two tables.
 *
 * @module apps/api/src/modules/classification
 */

export interface CorrectionView {
  readonly id: string;
  readonly transactionId: string | null;
  readonly field: string;
  readonly fromValue: string | null;
  readonly toValue: string | null;
  readonly wasAiSuggested: boolean;
  readonly ruleCreatedId: string | null;
  readonly ruleCreated: RuleView | null;
  readonly createdAt: Date;
}

export interface RecordCorrectionInput {
  readonly transactionId: string;
  readonly field: string;
  readonly fromValue: string | null;
  readonly toValue: string | null;
  readonly wasAiSuggested: boolean;
}

export interface CreateRuleFromCorrectionOutcome {
  readonly rule: RuleView;
  readonly correction: CorrectionView;
  readonly cacheInvalidatedAt: Date;
  readonly ruleConflicts: readonly RuleConflictView[];
}

/** Raised when a proposal would be shadowed and the caller did not author it themselves. */
export class RuleShadowedError extends Error {
  constructor(
    readonly proposal: {
      readonly name: string;
      readonly priority: number;
      readonly conditions: unknown;
      readonly actions: unknown;
      readonly origin: string;
      readonly explanation: string;
      readonly explanationCode: string;
      readonly trigger: RuleSynthesisTrigger;
      readonly confidence: number;
    },
    readonly conflicts: readonly RuleConflictView[],
  ) {
    super('An existing rule already handles this, so that rule would never fire.');
    this.name = 'RuleShadowedError';
  }
}

const CORRECTION_SELECT = {
  id: true,
  transaction_id: true,
  field: true,
  from_value: true,
  to_value: true,
  was_ai_suggested: true,
  rule_created_id: true,
  created_at: true,
} as const;

export interface CorrectionRow {
  readonly id: string;
  readonly transaction_id: string | null;
  readonly field: string;
  readonly from_value: string | null;
  readonly to_value: string | null;
  readonly was_ai_suggested: boolean;
  readonly rule_created_id: string | null;
  readonly created_at: Date;
}

const RULE_VIEW_SELECT = {
  id: true,
  name: true,
  priority: true,
  is_active: true,
  stop_on_match: true,
  conditions: true,
  actions: true,
  origin: true,
  source_correction_id: true,
  hit_count: true,
  last_hit_at: true,
  created_at: true,
  updated_at: true,
} as const;

@Injectable()
export class CorrectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: RulesService,
    private readonly classification: ClassificationService,
  ) {}

  /**
   * Append the signal.
   *
   * Called by the ledger **after** the field change succeeded, so a Correction always describes a
   * change that actually happened. Recording first would leave a Correction claiming a change that a
   * failed write never made — and the re-fit would train on it.
   */
  async record(householdId: string, input: RecordCorrectionInput): Promise<CorrectionRow> {
    return this.prisma.client.corrections.create({
      data: {
        id: uuidv7(),
        household_id: householdId,
        transaction_id: input.transactionId,
        field: input.field,
        from_value: input.fromValue,
        to_value: input.toValue,
        was_ai_suggested: input.wasAiSuggested,
      },
      select: CORRECTION_SELECT,
    });
  }

  /** The row, or `NOT_FOUND`. */
  async require(householdId: string, correctionId: string): Promise<CorrectionRow> {
    const row = await this.prisma.client.corrections.findFirst({
      where: { id: correctionId, household_id: householdId },
      select: CORRECTION_SELECT,
    });
    if (row === null) throw new ApiError('NOT_FOUND', 'Correction not found.');
    return row;
  }

  /**
   * The Household's **most recent** correction — the row `"zapamti ovu ispravku"` means (B-5).
   *
   * A correction has no name to match on, so a question can only refer to one **deictically**, and the
   * only defensible reading of "this correction" without a conversation context (docs/16's A-6) is the
   * newest. Ordered by `created_at` **and then `id`**: two corrections recorded in the same instant are
   * otherwise an arbitrary pick, and `id` is a UUIDv7, so the tie-break is still time order rather than
   * whatever the planner felt like. The caller shows which row it used and refuses a phrase that tries
   * to name a different one (see `assistant-action.service.ts`).
   */
  async latest(householdId: string): Promise<CorrectionRow | null> {
    const rows = await this.prisma.client.corrections.findMany({
      where: { household_id: householdId },
      select: CORRECTION_SELECT,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: 1,
    });
    return rows[0] ?? null;
  }

  /**
   * How many corrections already sent `merchantId` to `categoryId`.
   *
   * docs/04 §8.2's threshold input: the third correction of one Merchant to one Category is a
   * different problem from the first, and the answer is that Merchant's default rather than a fourth
   * rule. Counted *before* the current correction is recorded, so the caller adds one.
   *
   * `to_value` holds a Category **id** for a category correction (that is what the ledger writes), so
   * this compares ids. It is deliberately not a name comparison: a rename would silently reset the
   * count.
   */
  async priorMerchantCorrections(
    householdId: string,
    merchantId: string,
    categoryId: string,
  ): Promise<number> {
    return this.prisma.client.corrections.count({
      where: {
        household_id: householdId,
        field: 'category',
        to_value: categoryId,
        transactions: { merchant_id: merchantId },
      },
    });
  }

  /** A Transaction's corrections, newest first — the audit chain the detail sheet renders (F-31). */
  async listForTransaction(householdId: string, transactionId: string): Promise<CorrectionView[]> {
    const rows = await this.prisma.client.corrections.findMany({
      where: { household_id: householdId, transaction_id: transactionId },
      select: CORRECTION_SELECT,
      orderBy: { created_at: 'desc' },
    });
    if (rows.length === 0) return [];

    const ruleIds = rows.map((row) => row.rule_created_id).filter((id): id is string => id !== null);
    const { rules: engineRules, keywords } = await this.classification.ruleInputs(householdId);
    const ruleRows = await this.prisma.client.rules.findMany({
      where: { household_id: householdId, id: { in: ruleIds } },
      select: RULE_VIEW_SELECT,
    });
    const now = Date.now();
    const views = new Map(
      ruleRows.map((row) => [row.id, this.rules.toView(row, engineRules, keywords, now)]),
    );

    return rows.map((row) => ({
      id: row.id,
      transactionId: row.transaction_id,
      field: row.field,
      fromValue: row.from_value,
      toValue: row.to_value,
      wasAiSuggested: row.was_ai_suggested,
      ruleCreatedId: row.rule_created_id,
      // A rule that was since deleted still resolves to `null` here rather than vanishing from the
      // correction: `ON DELETE SET NULL` keeps the correction, and the id above still names it.
      ruleCreated: row.rule_created_id ? (views.get(row.rule_created_id) ?? null) : null,
      createdAt: row.created_at,
    }));
  }

  /**
   * Turn a correction into a saved rule (docs/06 §5.4).
   *
   * The rule that is saved is the **final** one — the proposal, or the user's override — and it is
   * validated and conflict-checked in that form. Two behaviours worth stating:
   *
   * - **`overrides` present means the user authored it.** They saw the proposal, edited it and asked
   *   for it; refusing to save it because it shadows something would be paternalistic. The conflict is
   *   *recorded* on the result and the rule is created.
   * - **No overrides means it is the product's proposal.** If it would not fire, the right answer is to
   *   say so and offer to edit the rule that wins (docs/04 §8.2) rather than to save a dead rule —
   *   {@link RuleShadowedError}, which the resolver turns into `RuleConflictError`.
   */
  async createRuleFromCorrection(
    householdId: string,
    correction: CorrectionRow,
    subject: CorrectionSubject | null,
    input: {
      readonly acceptProposal: boolean;
      readonly overrides?: {
        readonly name?: string | null;
        readonly priority?: number | null;
        readonly isActive?: boolean | null;
        readonly stopOnMatch?: boolean | null;
        readonly conditions?: unknown;
        readonly actions?: unknown;
      } | null;
    },
  ): Promise<CreateRuleFromCorrectionOutcome> {
    const already = await this.prisma.client.rules.findFirst({
      where: { source_correction_id: correction.id, household_id: householdId, deleted_at: null },
      select: { id: true },
    });
    if (already !== null) {
      // One correction, one rule. A second would make `ruleCreated` ambiguous and quietly double the
      // rule set on a double tap.
      throw new ApiError(
        'CONFLICT',
        'This correction already produced a rule. Edit that rule instead of creating another.',
      );
    }

    const overrides = input.overrides ?? null;
    if (!input.acceptProposal && overrides === null) {
      // "This was a one-off." `corrections` has no column for the refusal, so the durable trace is
      // that `rule_created_id` stays null. Reported as a validation failure rather than a silent
      // success, because the caller asked for a rule to exist and none will.
      throw new ApiError(
        'VALIDATION_FAILED',
        'The proposal was declined and no rule was edited, so there is nothing to save.',
      );
    }

    const synthesis = subject === null ? null : await this.rules.synthesise(householdId, subject);

    // An override is a complete document: the user may be editing a proposal, but they are
    // authoring the rule. Without one there has to be something to accept.
    if (overrides === null && synthesis === null) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'That correction has no rule to derive — it resolved no merchant or counterparty and no ' +
          'distinctive word. Edit the rule yourself if you want one.',
      );
    }

    const finalRule = {
      name: overrides?.name ?? synthesis!.synthesis.proposal.name,
      priority: overrides?.priority ?? synthesis!.synthesis.proposal.priority,
      isActive: overrides?.isActive ?? true,
      stopOnMatch: overrides?.stopOnMatch ?? true,
      conditions: overrides?.conditions ?? synthesis!.synthesis.proposal.conditions,
      actions: overrides?.actions ?? synthesis!.synthesis.proposal.actions,
    };

    const check =
      synthesis === null
        ? { shadowed: false, conflicts: [] as readonly RuleConflictView[] }
        : await this.rules.checkShadowing(
            householdId,
            {
              id: 'proposal',
              conditions: finalRule.conditions as never,
              actions: finalRule.actions as never,
              priority: finalRule.priority,
            },
            synthesis.synthesis.witness,
          );

    if (check.shadowed && overrides === null) {
      throw new RuleShadowedError(
        {
          ...synthesis!.synthesis.proposal,
          name: finalRule.name,
          priority: finalRule.priority,
          conditions: finalRule.conditions,
          actions: finalRule.actions,
        },
        check.conflicts,
      );
    }

    const rule = await this.persist(householdId, correction, {
      name: finalRule.name,
      priority: finalRule.priority,
      isActive: finalRule.isActive,
      stopOnMatch: finalRule.stopOnMatch,
      conditions: finalRule.conditions,
      actions: finalRule.actions,
    });

    return {
      rule,
      correction: {
        id: correction.id,
        transactionId: correction.transaction_id,
        field: correction.field,
        fromValue: correction.from_value,
        toValue: correction.to_value,
        wasAiSuggested: correction.was_ai_suggested,
        ruleCreatedId: rule.id,
        ruleCreated: rule,
        createdAt: correction.created_at,
      },
      // Nothing is cached: the pipeline reads rules on every parse, so the rule is visible to the very
      // next request. Reported rather than omitted because docs/06 §5.4 declares it.
      cacheInvalidatedAt: new Date(),
      ruleConflicts: [...check.conflicts],
    };
  }

  /**
   * Synthesise the rule this correction should become, with the conflict check — or `null`.
   *
   * The single entry point the ledger's `correctTransaction` and `createRuleFromCorrection` both use,
   * so synthesis and the guardrail cannot be reached separately and drift.
   */
  async synthesise(
    householdId: string,
    subject: CorrectionSubject,
  ): Promise<{ synthesis: RuleSynthesis; check: ShadowCheck } | null> {
    if (subject === null) return null;
    return this.rules.synthesise(householdId, subject);
  }

  /**
   * docs/06 §5.3's narrow auto-create: the user ticked "remember" **and** the trigger is a resolved
   * entity **and** nothing shadows it.
   *
   * Ticking the box *is* the confirmation, so this does not violate docs/04 §8.2's "never auto-create"
   * — the user confirmed in the same action. §8.2's other half ("no rule from a single ambiguous
   * correction unless the trigger is a resolved entity") is the entity-only gate below, and it is what
   * keeps a typo'd one-off from becoming permanent policy.
   *
   * Returns `null` when there is nothing to create, so the caller reports the proposal for the UI to
   * offer instead.
   */
  async createConfirmedRule(
    householdId: string,
    correction: CorrectionRow,
    synthesis: { synthesis: RuleSynthesis; check: ShadowCheck },
  ): Promise<RuleView | null> {
    const { proposal } = synthesis.synthesis;
    const { trigger } = proposal;
    const entityTrigger =
      trigger === 'COUNTERPARTY_RESOLVED' ||
      trigger === 'MERCHANT_RESOLVED' ||
      trigger === 'REPEATED_MERCHANT_CORRECTION';
    if (!entityTrigger || synthesis.check.shadowed) return null;

    // A rule already linked to this correction (a double-tapped tick) is left alone rather than
    // duplicated; the caller still reports it, so the client sees the rule it asked for.
    const already = await this.prisma.client.rules.findFirst({
      where: { source_correction_id: correction.id, household_id: householdId, deleted_at: null },
      select: RULE_VIEW_SELECT,
    });
    if (already !== null) {
      const { rules, keywords } = await this.classification.ruleInputs(householdId);
      return this.rules.toView(already, rules, keywords, Date.now());
    }

    return this.persist(householdId, correction, {
      name: proposal.name,
      priority: proposal.priority,
      isActive: true,
      stopOnMatch: true,
      conditions: proposal.conditions,
      actions: proposal.actions,
    });
  }

  /** Create the rule and link it back to the correction that produced it, in that order. */
  private async persist(
    householdId: string,
    correction: CorrectionRow,
    finalRule: {
      readonly name: string;
      readonly priority: number;
      readonly isActive: boolean;
      readonly stopOnMatch: boolean;
      readonly conditions: unknown;
      readonly actions: unknown;
    },
  ): Promise<RuleView> {
    const rule = await this.rules.create(householdId, {
      name: finalRule.name,
      priority: finalRule.priority,
      isActive: finalRule.isActive,
      stopOnMatch: finalRule.stopOnMatch,
      conditions: finalRule.conditions,
      actions: finalRule.actions,
      // ADR-010: the audit trail has to show that the product proposed this and the user accepted it.
      origin: 'LEARNED',
      sourceCorrectionId: correction.id,
    });

    await this.prisma.client.corrections.updateMany({
      where: { id: correction.id, household_id: householdId },
      data: { rule_created_id: rule.id },
    });

    return rule;
  }

  /** One correction, with its rule resolved — for the resolver's composition step. */
  async view(householdId: string, row: CorrectionRow, rule: RuleView | null): Promise<CorrectionView> {
    void householdId;
    return {
      id: row.id,
      transactionId: row.transaction_id,
      field: row.field,
      fromValue: row.from_value,
      toValue: row.to_value,
      wasAiSuggested: row.was_ai_suggested,
      ruleCreatedId: row.rule_created_id,
      ruleCreated: rule,
      createdAt: row.created_at,
    };
  }
}
