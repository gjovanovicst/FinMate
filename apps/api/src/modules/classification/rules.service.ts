import { Injectable, Logger } from '@nestjs/common';

import { uuidv7 } from '@finmate/domain';
import {
  evaluateRules,
  validateRule,
  RuleDocumentError,
  type CategoryKeyword,
  type ConditionTree,
  type EvaluationContext,
  type Rule,
  type RuleActions,
  type RuleOrigin,
} from '@finmate/rules-engine';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ClassificationService } from './classification.service';
import { PIPELINE_TEXT_FOLDER } from './rule-adapter';
import {
  synthesiseRule,
  triggerForConflict,
  witnessFromConditions,
  type CorrectionSubject,
  type RuleSynthesis,
} from './rule-synthesis';

/**
 * `rules` — the module's rule store and the conflict guardrail (docs/04 §8.2, docs/05 §3).
 *
 * docs/05 §3 puts `rules` and `corrections` in the **`classification`** module, so this is not a new
 * module: it is the write half of the pipeline whose read half already lives here.
 *
 * ## The conflict check runs the real engine
 *
 * docs/04 §8.2 requires a new rule not to "silently contradict a higher-priority rule". The
 * implementation is not a static overlap heuristic: synthesis produces a **witness** — an input the
 * proposed rule matches — and this service asks the real `evaluateRules` who wins on it. If the
 * proposal does not win on its own trigger input, it would never fire, and that is a conflict worth
 * surfacing. The check therefore cannot disagree with runtime behaviour, because it *is* runtime
 * behaviour.
 *
 * ## Nothing is cached
 *
 * docs/06 §5.4's `cacheInvalidatedAt` is the moment of the write, and the field's description says so.
 * The pipeline loads rules from Postgres on every parse, so there is no cache to bust and a new rule
 * applies to the very next request. That is a stronger guarantee than an invalidation protocol, and
 * the honest thing to say rather than inventing a cache to invalidate.
 *
 * @module apps/api/src/modules/classification
 */

/** docs/04 §8.2: `hit_count = 0` after this long is surfaced for cleanup. */
export const RULE_STALE_AFTER_DAYS = 90;

/** The rule shape this service returns, with the two computed fields docs/06 §5.3 declares. */
export interface RuleView {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly isActive: boolean;
  readonly stopOnMatch: boolean;
  readonly conditions: unknown;
  readonly actions: unknown;
  readonly origin: RuleOrigin;
  readonly sourceCorrectionId: string | null;
  readonly hitCount: bigint;
  readonly lastHitAt: Date | null;
  readonly isStale: boolean;
  readonly conflictsWith: readonly RuleConflictView[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface RuleConflictView {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly priority: number;
  readonly overlappingField: string;
  readonly existingValue: string | null;
  readonly proposedValue: string | null;
}

/** The outcome of the guardrail: would this proposal ever fire? */
export interface ShadowCheck {
  readonly shadowed: boolean;
  readonly conflicts: readonly RuleConflictView[];
}

export interface CreateRuleInput {
  readonly name: string;
  readonly priority?: number;
  readonly isActive?: boolean;
  readonly stopOnMatch?: boolean;
  readonly conditions: unknown;
  readonly actions: unknown;
  readonly origin?: RuleOrigin;
  readonly sourceCorrectionId?: string | null;
}

const RULE_ROW_SELECT = {
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
export class RulesService {
  private readonly logger = new Logger(RulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly classification: ClassificationService,
  ) {}

  /** Every rule of the Household, active or not, newest first. Soft-deleted rows are gone. */
  async list(householdId: string): Promise<RuleView[]> {
    const rows = await this.prisma.client.rules.findMany({
      where: { household_id: householdId, deleted_at: null },
      select: RULE_ROW_SELECT,
      orderBy: [{ priority: 'asc' }, { created_at: 'desc' }],
    });
    if (rows.length === 0) return [];

    // One engine load for the whole page: `conflictsWith` is per rule, but the rule set it is checked
    // against is the same for all of them.
    const { rules, keywords } = await this.classification.ruleInputs(householdId);
    const now = Date.now();

    return rows.map((row) => this.toView(row, rules, keywords, now));
  }

  async get(householdId: string, id: string): Promise<RuleView> {
    const row = await this.prisma.client.rules.findFirst({
      where: { id, household_id: householdId, deleted_at: null },
      select: RULE_ROW_SELECT,
    });
    if (row === null) throw new ApiError('NOT_FOUND', 'Rule not found.');

    const { rules, keywords } = await this.classification.ruleInputs(householdId);
    return this.toView(row, rules, keywords, Date.now());
  }

  /**
   * Save a rule.
   *
   * The document is validated by the **engine's** `validateRule` before it is stored, so a rule this
   * service accepts is one the pipeline can evaluate. The JSON scalar validates nothing (see
   * `json.scalar.ts`), and `rules.conditions` is user-authored JSONB, so this is the one place the
   * shape is checked — a malformed rule would otherwise be skipped at parse time with a log line
   * nobody reads.
   */
  async create(householdId: string, input: CreateRuleInput): Promise<RuleView> {
    const name = input.name.trim();
    if (name.length === 0) throw new ApiError('VALIDATION_FAILED', 'A rule needs a name.');

    const conditions = input.conditions as ConditionTree;
    const actions = input.actions as RuleActions;
    const id = uuidv7();

    this.assertValidDocument({ id, name, priority: input.priority ?? 100, conditions, actions });

    const row = await this.prisma.client.rules.create({
      data: {
        id,
        household_id: householdId,
        name,
        priority: input.priority ?? 100,
        is_active: input.isActive ?? true,
        stop_on_match: input.stopOnMatch ?? true,
        // Cast, not parsed: the engine's validator above is the single definition of a well-formed
        // rule, and a second structural check here would be free to disagree with it.
        conditions: conditions as unknown as Prisma.InputJsonValue,
        actions: actions as unknown as Prisma.InputJsonValue,
        origin: input.origin ?? 'USER',
        source_correction_id: input.sourceCorrectionId ?? null,
      },
      select: RULE_ROW_SELECT,
    });

    const { rules, keywords } = await this.classification.ruleInputs(householdId);
    return this.toView(row, rules, keywords, Date.now());
  }

  /** Patch a rule. Omitted fields are left alone; the merged document is re-validated. */
  async update(
    householdId: string,
    id: string,
    patch: Partial<CreateRuleInput>,
  ): Promise<RuleView> {
    const existing = await this.prisma.client.rules.findFirst({
      where: { id, household_id: householdId, deleted_at: null },
      select: RULE_ROW_SELECT,
    });
    if (existing === null) throw new ApiError('NOT_FOUND', 'Rule not found.');

    const name = patch.name === undefined ? existing.name : patch.name.trim();
    if (name.length === 0) throw new ApiError('VALIDATION_FAILED', 'A rule needs a name.');

    const conditions = (patch.conditions ?? existing.conditions) as ConditionTree;
    const actions = (patch.actions ?? existing.actions) as RuleActions;
    const priority = patch.priority ?? existing.priority;

    this.assertValidDocument({ id, name, priority, conditions, actions });

    const row = await this.prisma.client.rules.update({
      where: { id },
      data: {
        name,
        priority,
        ...(patch.isActive === undefined ? {} : { is_active: patch.isActive }),
        ...(patch.stopOnMatch === undefined ? {} : { stop_on_match: patch.stopOnMatch }),
        ...(patch.conditions === undefined
          ? {}
          : { conditions: conditions as unknown as Prisma.InputJsonValue }),
        ...(patch.actions === undefined
          ? {}
          : { actions: actions as unknown as Prisma.InputJsonValue }),
        updated_at: new Date(),
      },
      select: RULE_ROW_SELECT,
    });

    const { rules, keywords } = await this.classification.ruleInputs(householdId);
    return this.toView(row, rules, keywords, Date.now());
  }

  /** Soft-delete. A rule is a decision the user made, and F-31 has to be able to explain history. */
  async remove(householdId: string, id: string): Promise<void> {
    const result = await this.prisma.client.rules.updateMany({
      where: { id, household_id: householdId, deleted_at: null },
      data: { deleted_at: new Date(), is_active: false, updated_at: new Date() },
    });
    if (result.count === 0) throw new ApiError('NOT_FOUND', 'Rule not found.');
  }

  /**
   * Would this proposal ever fire, or does something already win on its own trigger input?
   *
   * `witness` comes from {@link synthesiseRule}; the engine decides, not this method.
   */
  async checkShadowing(
    householdId: string,
    proposal: { id: string; conditions: ConditionTree; actions: RuleActions; priority: number },
    witness: EvaluationContext,
  ): Promise<ShadowCheck> {
    const { rules, keywords } = await this.classification.ruleInputs(householdId);

    const asRule: Rule = {
      id: proposal.id,
      name: '(proposal)',
      priority: proposal.priority,
      isActive: true,
      stopOnMatch: true,
      conditions: proposal.conditions,
      actions: proposal.actions,
      origin: 'LEARNED',
      // **Now**, not the epoch. docs/04 §5.3.1 breaks a specificity tie on `created_at DESC`, so an
      // epoch timestamp would make every proposal lose a tie to any existing rule — including an
      // identical one at the same priority. The proposal is the newest thing in the set by definition.
      createdAt: new Date().toISOString(),
    };

    const before = evaluateRules(rules, witness, { folder: PIPELINE_TEXT_FOLDER, keywords });
    const after = evaluateRules([...rules, asRule], witness, { folder: PIPELINE_TEXT_FOLDER, keywords });

    // A witness that is **already decided to the same category** is a shadow even though the new rule
    // would win a tie: the proposal adds nothing, and docs/04 §8.2's "shadowing rules is how rule sets
    // rot" is about exactly this. Without this arm, ticking "remember" twice on the same correction
    // context would quietly pile up duplicate rules that all do the same thing.
    const beforeCategory = before.actions.setCategoryId ?? null;
    const redundant =
      before.decidedBy === 'RULE' &&
      beforeCategory !== null &&
      beforeCategory === (proposal.actions.setCategoryId ?? null);

    // The proposal wins on its own trigger and adds something, so it does what it says it will.
    if (!redundant && after.decidedBy === 'RULE' && after.ruleId === proposal.id) {
      return { shadowed: false, conflicts: [] };
    }

    // Something else decides it. Name every rule that matched, so the UI can offer to edit the one
    // that actually wins rather than an arbitrary match (docs/04 §8.2).
    const matched = new Set([
      ...(before.ruleId === null ? [] : [before.ruleId]),
      ...before.matchedRuleIds,
    ]);
    const conflicts = rules
      .filter((rule) => matched.has(rule.id))
      .map((rule) => toConflict(rule, proposal));

    // A keyword decision is also a shadow, and it has no rule row to name: an explicit rule at a
    // lower priority than the implicit 1000 tier *should* outrank it, so this arm means the proposal
    // failed to match at all rather than that a keyword beat it.
    if (conflicts.length === 0 && after.decidedBy !== 'RULE') {
      this.logger.warn(
        `rule proposal for household ${householdId} does not match its own witness ` +
          `(before=${before.decidedBy}/${before.ruleId ?? '-'}, after=${after.decidedBy}/${after.ruleId ?? '-'})`,
      );
    }

    return { shadowed: true, conflicts };
  }

  /**
   * Count a rule's hits.
   *
   * Called from the **commit** path, never from the parse path. `captureParse` fires on a 250 ms
   * keystroke debounce, so counting there would inflate `hit_count` by an order of magnitude and make
   * docs/04 §8.2's "stale after 90 days" signal meaningless. A hit is a Transaction the rule
   * actually decided — i.e. one that was written.
   *
   * One statement per distinct rule id, because `updateMany` increments once per matched row and
   * grouping would lose the per-rule count. A commit resolves at most a handful of distinct rules.
   */
  async recordHits(householdId: string, ruleIds: readonly string[]): Promise<void> {
    const unique = [...new Set(ruleIds)];
    if (unique.length === 0) return;
    const now = new Date();

    for (const ruleId of unique) {
      await this.prisma.client.rules.updateMany({
        where: { id: ruleId, household_id: householdId },
        data: { hit_count: { increment: 1 }, last_hit_at: now },
      });
    }
  }

  /**
   * Synthesise the rule a correction should become, and check it against what already exists.
   *
   * The one entry point the ledger calls, so synthesis + the witness + the guardrail cannot be
   * reached separately and drift.
   */
  async synthesise(
    householdId: string,
    subject: CorrectionSubject,
  ): Promise<{ synthesis: RuleSynthesis; check: ShadowCheck } | null> {
    const synthesis = synthesiseRule(subject);
    if (synthesis === null) return null;

    const check = await this.checkShadowing(
      householdId,
      {
        id: 'proposal',
        conditions: synthesis.proposal.conditions,
        actions: synthesis.proposal.actions,
        priority: synthesis.proposal.priority,
      },
      synthesis.witness,
    );

    return {
      // A shadowed proposal is relabelled, so the UI can say *why* it is offering to edit an existing
      // rule rather than to save a new one (docs/06 §5.3's `CONTRADICTS_EXISTING_RULE`).
      synthesis: check.shadowed
        ? { ...synthesis, proposal: triggerForConflict(synthesis.proposal) }
        : synthesis,
      check,
    };
  }

  /** Map a `rules` row to the API shape, computing `isStale` and `conflictsWith`. */
  toView(
    row: RuleViewRow,
    rules: readonly Rule[],
    keywords: readonly CategoryKeyword[],
    nowMs: number,
  ): RuleView {
    const createdAt = row.created_at;
    const staleAfterMs = RULE_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;

    return {
      id: row.id,
      name: row.name,
      priority: row.priority,
      isActive: row.is_active,
      stopOnMatch: row.stop_on_match,
      conditions: row.conditions,
      actions: row.actions,
      origin: (row.origin as RuleOrigin) ?? 'SYSTEM',
      sourceCorrectionId: row.source_correction_id,
      hitCount: row.hit_count,
      lastHitAt: row.last_hit_at,
      isStale: row.hit_count === 0n && nowMs - createdAt.getTime() > staleAfterMs,
      conflictsWith: this.conflictsWith(row, rules, keywords),
      createdAt,
      updatedAt: row.updated_at,
    };
  }

  /**
   * The rules that would win on this rule's own witnessed input.
   *
   * `[]` covers two different facts — "checked and nothing beats it" and "could not build a witness" —
   * and the field's description in the SDL says so, because a rules screen that silently reports
   * "no conflicts" for a rule it never checked is worse than one that reports nothing.
   */
  private conflictsWith(
    row: RuleViewRow,
    rules: readonly Rule[],
    keywords: readonly CategoryKeyword[],
  ): RuleConflictView[] {
    if (!row.is_active) return [];
    const witness = witnessFromConditions(row.conditions as ConditionTree);
    if (witness === null) return [];

    const others = rules.filter((rule) => rule.id !== row.id);
    const own = rules.find((rule) => rule.id === row.id);
    if (own === undefined) return [];

    const decision = evaluateRules(others, witness, { folder: PIPELINE_TEXT_FOLDER, keywords });
    if (decision.decidedBy === 'NONE') return [];

    // The decider first, then the other matches, so "edit that one" points at the winner.
    const matched = [...new Set([...(decision.ruleId ? [decision.ruleId] : []), ...decision.matchedRuleIds])];
    return matched
      .map((id) => others.find((rule) => rule.id === id))
      .filter((rule): rule is Rule => rule !== undefined)
      .map((rule) =>
        toConflict(rule, {
          conditions: row.conditions as ConditionTree,
          actions: row.actions as RuleActions,
        }),
      );
  }

  /** The engine's validator, surfaced as a typed client error rather than a 500. */
  private assertValidDocument(args: {
    id: string;
    name: string;
    priority: number;
    conditions: ConditionTree;
    actions: RuleActions;
  }): void {
    try {
      validateRule({
        id: args.id,
        name: args.name,
        priority: args.priority,
        isActive: true,
        stopOnMatch: true,
        conditions: args.conditions,
        actions: args.actions,
        origin: 'USER',
        createdAt: new Date(0).toISOString(),
      });
    } catch (error) {
      if (error instanceof RuleDocumentError) {
        throw new ApiError('VALIDATION_FAILED', `That rule cannot be evaluated: ${error.message}`);
      }
      throw error;
    }
  }
}

/**
 * The shape of a `rules` row as this service selects it.
 *
 * Structural rather than a Prisma import, so this file's contract with the database is one visible
 * object rather than a generated type's transitive shape — and so a column added to the table cannot
 * silently become part of the service's surface.
 */
export interface RuleViewRow {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly is_active: boolean;
  readonly stop_on_match: boolean;
  readonly conditions: unknown;
  readonly actions: unknown;
  readonly origin: string;
  readonly source_correction_id: string | null;
  readonly hit_count: bigint;
  readonly last_hit_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/**
 * One conflicting rule, in docs/06 §5.3's `RuleConflict` shape.
 *
 * `existingValue`/`proposedValue` carry the two **Categories**: the most useful reading of those
 * fields is "this rule already sends it to X, you are proposing Y". Equality therefore means the
 * proposal is redundant rather than contradictory, which is a distinction the client can make without
 * an extra field.
 */
function toConflict(
  rule: Rule,
  proposed: { readonly conditions: ConditionTree; readonly actions: RuleActions },
): RuleConflictView {
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    priority: rule.priority,
    overlappingField: overlappingField(rule.conditions, proposed.conditions),
    existingValue: rule.actions.setCategoryId ?? null,
    proposedValue: proposed.actions.setCategoryId ?? null,
  };
}

/** The condition field two rules talk about, so "edit that one" can point at the right clause. */
function overlappingField(a: ConditionTree, b: ConditionTree): string {
  const fieldsOf = (tree: ConditionTree): string[] => {
    const leaves =
      typeof tree === 'object' && tree !== null && 'all' in tree ? tree.all : [tree];
    return leaves
      .map((leaf) => ('field' in leaf ? String(leaf.field) : null))
      .filter((field): field is string => field !== null);
  };

  const mine = fieldsOf(a);
  return fieldsOf(b).find((field) => mine.includes(field)) ?? mine[0] ?? 'unknown';
}
