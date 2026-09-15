/**
 * The classification pipeline — docs/04-categorization-and-ai-engine.md §2, in its stated order.
 *
 * ```text
 * normalize → resolve → rules → keywords → [merchant/counterparty default] → then AI
 * ```
 *
 * ## Order is the point, not an implementation detail
 *
 * ADR-002 and AGENTS.md rule 2 make AI the **exception path**. Two authoritative sources:
 *
 * - **docs/04 §5.4** — "Otherwise fall through to AI with the scored candidates attached as context",
 *   i.e. a keyword decision means the model is never called.
 * - **docs/04 §12** — "~70 % of entries cost $0.00" is the product's **cost model**, not a nice-to-
 *   have. A pipeline that calls the model "just in case" satisfies every functional test while
 *   destroying the economics and the privacy posture in one line.
 *
 * So {@link runPipeline} **returns before reaching the AI stage** whenever a deterministic stage
 * decided. The AI call is a callback ({@link AiStage}) rather than something this file does, so a
 * stage that is never reached cannot be invoked at all — and the tests assert the call count is
 * exactly zero.
 *
 * ## What is pure here
 *
 * Everything except the `ai` callback. No database, no clock (the instant and the local day arrive in
 * {@link PipelineInput}), no provider, no module state. The caller loads the Household's rows, runs
 * §6.4 calibration and supplies the AI proposal; this file decides what they mean. That split is what
 * lets the ordering and the gate be tested exhaustively without a container.
 *
 * ## Money
 *
 * `fragment.amountMinor` is a `bigint` and stays one. The only conversion in this file is
 * `toString()` when an amount is written into the JSONB `candidates` audit blob — JSON has no bigint,
 * and a JSON *number* would be a float in the money path (ADR-003).
 *
 * @module apps/api/src/modules/classification
 */

import { calibratedConfidenceFromStorage, type CalibratedConfidence } from '@finmate/ai';
import {
  resolveEntity,
  type EntityCandidate,
  type EntityResolutionResult,
  type TransactionFragment,
} from '@finmate/nlp';
import {
  evaluateRules,
  type Candidate,
  type CategoryKeyword,
  type EvaluationContext,
  type KeywordCandidate,
  type Rule,
  type RuleDecision,
  type TextFolder,
} from '@finmate/rules-engine';

import { applyConfidenceGate, type GateDecision, type LaneThresholds } from './confidence-gate';
import type { PromptCategory } from './classify-prompt';
import { confidenceForCosine } from './embedding-resolver';

// ---------------------------------------------------------------------------------------------
// Inputs the service loads from the database
// ---------------------------------------------------------------------------------------------

/** `households`-derived configuration. Thresholds are resolved by the caller. */
export interface PipelineHousehold {
  /** The Household ledger currency, inherited when a fragment names none. */
  readonly currency: string;
  /** The Household IANA timezone, for the local calendar day (docs/03 §3.2). */
  readonly timeZone: string;
}

/** One category from the Household's tree, already checked against the closed list. */
export interface PipelineCategory extends PromptCategory {
  readonly name: string;
  readonly parentId: string | null;
  readonly kind: string;
  readonly aiDescription: string | null;
}

/** A Merchant or Counterparty with its aliases preloaded. */
export interface PipelineEntity {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly defaultCategoryId: string | null;
}

/**
 * The AI stage, as a callback.
 *
 * The pipeline never fires it itself, which is how "zero AI calls when a rule matches" stays a
 * structural property rather than a promise. The callback owns validation (the closed list) and
 * calibration (§6.4), because both need the redaction map and the fitted table — neither of which
 * belongs in a pure stage.
 */
export interface AiStageInput {
  readonly fragment: TransactionFragment;
  readonly household: PipelineHousehold;
  /** The resolved entity names, when stage 3 hit, so the model can be told what was recognised. */
  readonly merchantName?: string;
  readonly counterpartyName?: string;
  /** The scored keyword candidates, attached as context (docs/04 §5.4). */
  readonly keywordCandidates: readonly KeywordCandidate[];
  /** In input order, for the prompt's "fragment i of n". */
  readonly fragmentIndex: number;
  readonly fragmentCount: number;
}

/** A validated model proposal. The closed-list check and §6.4 calibration have already run. */
export interface AiClassifyResult {
  /** Must be one of the ids the caller supplied, or `null`. Never re-checked here. */
  readonly categoryId: string | null;
  /** The model's **raw** self-reported confidence, kept so §6.4's re-fit can recover the pair. */
  readonly rawConfidence: number;
  /**
   * The gated value: §6.4's mapping applied to {@link rawConfidence}.
   *
   * Filled in by the service (`calibrateAiResult`), **not** by the adapter, so a stub classifier
   * cannot hand the gate an uncalibrated number.
   */
  readonly calibratedConfidence?: CalibratedConfidence;
  readonly rationale: string;
  readonly alternatives: readonly { readonly categoryId: string; readonly confidence: number }[];
  /** Identity for the audit row (docs/04 §9: provider, model, prompt, latency, cost). */
  readonly provider: string;
  readonly model: string;
  readonly promptTemplateId: string | null;
  readonly promptVersion: number | null;
  readonly latencyMs: number;
  readonly costMicros: number;
}

/** No model answered. `rung` is docs/04 §9's ladder; `reason` names why (never a bare `false`). */
export interface AiUnavailable {
  readonly unavailable: true;
  readonly rung: 'RULES_KEYWORDS_ONLY' | 'DETERMINISTIC_ONLY' | 'MANUAL_ENTRY';
  readonly reason: string;
}

export type AiStageResult = AiClassifyResult | AiUnavailable;

/**
 * Narrow an AI stage result to its failure arm.
 *
 * A named guard rather than an inline `'unavailable' in result`: the two arms are discriminated by a
 * *value*, and a helper keeps that decision in one place so the pipeline and the service cannot
 * disagree about what "unavailable" looks like.
 */
export function isAiUnavailable(result: AiStageResult): result is AiUnavailable {
  return (result as { readonly unavailable?: unknown }).unavailable === true;
}

/** The AI stage as a function. Injecting it is what makes the call-count assertions possible. */
export type AiStage = (input: AiStageInput) => Promise<AiStageResult>;

/** docs/04 §9's ladder, worst-last, so an index comparison is a severity comparison. */
export const PIPELINE_RUNGS = [
  'FULL_PIPELINE',
  'RULES_KEYWORDS_ONLY',
  'DETERMINISTIC_ONLY',
  'MANUAL_ENTRY',
] as const;

export type PipelineRung = (typeof PIPELINE_RUNGS)[number];

/** The worse (more degraded) of two rungs. */
export function worstRung(left: PipelineRung, right: PipelineRung): PipelineRung {
  return PIPELINE_RUNGS.indexOf(left) >= PIPELINE_RUNGS.indexOf(right) ? left : right;
}

/**
 * One entity rung 5 proposes, with everything the stages downstream need.
 *
 * `defaultCategoryId` is here rather than looked up later because that is what makes a rung-5 hit
 * behave like any other resolved entity: the entity-default stage can categorise from it (docs/04 §4),
 * which is the point of resolving `Dejan rođa` at all.
 */
export interface EmbeddingEntityCandidate {
  readonly id: string;
  readonly kind: 'MERCHANT' | 'COUNTERPARTY';
  readonly name: string;
  readonly defaultCategoryId: string | null;
  /** The cosine that produced the hit, for the audit blob and the confidence band. */
  readonly cosine: number;
  readonly model: string;
}

/** `description` in, at most one candidate out. Implemented by the service; stubbed by tests. */
export type EmbeddingEntityResolver = (
  description: string,
) => Promise<EmbeddingEntityCandidate | null>;

export interface PipelineInput {
  /** One fragment, already segmented by `@finmate/nlp`. */
  readonly fragment: TransactionFragment;
  readonly household: PipelineHousehold;
  readonly categories: readonly PipelineCategory[];
  readonly keywords: readonly CategoryKeyword[];
  readonly rules: readonly Rule[];
  readonly merchants: readonly PipelineEntity[];
  readonly counterparties: readonly PipelineEntity[];
  /** Injected because `scope:rules` may not import `@finmate/nlp` (AGENTS.md). */
  readonly folder: TextFolder;
  /** The Household's local calendar day, for `dayOfWeek` / `dayOfMonth` rule conditions. */
  readonly localDay: string;
  /** ADR-009's thresholds, or the Household's override. */
  readonly thresholds?: LaneThresholds;
  /** `undefined` = no model may be called at all (`allowAi: false`, or no provider configured). */
  readonly ai: AiStage | undefined;
  /**
   * docs/04 §4 **rung 5**, as a lazily-called callback — the same shape as {@link ai} and for the same
   * reason: it is I/O, it must happen **only** when rungs 1–4 found nothing, and a caller that cannot
   * reach a model passes `undefined`.
   *
   * It receives the fragment's description and returns at most one candidate. `null` means "no
   * neighbour cleared the threshold", which is not an error — it is rung 6, unresolved.
   */
  readonly embeddings?: EmbeddingEntityResolver | undefined;
  /** In input order, for the prompt's "fragment i of n". Purely informational. */
  readonly fragmentIndex?: number;
  readonly fragmentCount?: number;
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

/**
 * Every source docs/04 names for a category, in the order it is consulted — cheapest first.
 *
 * `USER` is not producible by the parser: it is a user's explicit choice at commit time, so it can
 * only arrive through `captureCommit`. The union is written out in full so the CHECK constraint and
 * this type cannot drift.
 */
export type DecidedBy =
  | 'USER'
  | 'RULE'
  | 'AI'
  | 'MERCHANT_DEFAULT'
  | 'COUNTERPARTY_DEFAULT'
  | 'KEYWORD'
  | 'FALLBACK';

/** One entry of the `classification_decisions.candidates` JSONB blob. */
export interface AuditCandidate {
  readonly kind: 'RULE' | 'KEYWORD' | 'ENTITY' | 'DEFAULT' | 'AMOUNT';
  readonly id?: string;
  readonly name?: string;
  readonly categoryId?: string;
  readonly score?: number;
  readonly matchedTokens?: number;
  readonly reason?: string;
  readonly polarity?: 'INCLUDE' | 'EXCLUDE';
  readonly matchMode?: string;
  readonly blocked?: boolean;
  readonly confidence?: number;
  readonly provider?: string;
  readonly model?: string;
  readonly matchedOn?: string;
  readonly rung?: string;
  readonly amountMinor?: string;
}

/** The AI telemetry that goes into `classification_decisions`, when a model actually answered. */
export interface AiAudit {
  readonly provider: string;
  readonly model: string;
  readonly promptTemplateId: string | null;
  readonly promptVersion: number | null;
  readonly latencyMs: number;
  readonly costMicros: number;
}

/** One fragment's complete outcome: the proposal the API returns and the row it will be audited as. */
export interface PipelineOutcome {
  /** `null` means uncategorised — which is always the blocking lane (I-8). */
  readonly categoryId: string | null;
  readonly confidence: CalibratedConfidence;
  readonly rawConfidence: number | null;
  readonly decidedBy: DecidedBy;
  readonly ruleId: string | null;
  readonly ruleName: string | null;
  /**
   * The Merchant/Counterparty the **decision** came from, when one did. `decidedBy` says which kind
   * it is (`MERCHANT_DEFAULT` / `COUNTERPARTY_DEFAULT`).
   */
  readonly entityId: string | null;
  /**
   * The Merchant that **resolved**, whether or not it decided anything.
   *
   * Distinct from {@link entityId} on purpose: resolution and decision are different questions, and
   * conflating them is how a Counterparty id ended up in `transactions.merchant_id` — a column with a
   * foreign key to a different table. A row's resolved entities are what the ledger records; the
   * deciding entity is what the audit trail explains.
   */
  readonly resolvedMerchantId: string | null;
  /**
   * Rung 5's provenance, or `null` when the ladder ended at rung 4 or earlier.
   *
   * `resolvedMerchantId`/`resolvedCounterpartyId` already say what was resolved; this says **how**, so
   * an audit can answer "why did this row pick that person?" with "the nearest of your own names at
   * 0.87" instead of an unqualified assertion.
   */
  readonly embeddingEntity: {
    readonly id: string;
    readonly kind: 'MERCHANT' | 'COUNTERPARTY';
    readonly name: string;
    readonly cosine: number;
    readonly model: string;
  } | null;
  /** The Counterparty that resolved, whether or not it decided anything. */
  readonly resolvedCounterpartyId: string | null;
  readonly rationale: string;
  readonly candidates: readonly AuditCandidate[];
  readonly gate: GateDecision;
  /** docs/04 §9's rung for this fragment. Merged across fragments by the caller with `worstRung`. */
  readonly rung: PipelineRung;
  readonly ai: AiAudit | null;
}

// ---------------------------------------------------------------------------------------------
// The prose a user reads back
// ---------------------------------------------------------------------------------------------

/**
 * Why this decision, in one line.
 *
 * docs/04 P-3: "Every decision is explainable to the user: *Matched your rule Lidl → Hrana*". These
 * are **not** user-facing copy — the UI renders its own localised strings from `decidedBy` plus the
 * rule name (AGENTS.md: no hardcoded user-facing strings). They exist so a support engineer reading
 * `classification_decisions` can tell a rule hit from a keyword hit at a glance.
 */
export function explainDecision(outcome: {
  readonly decidedBy: DecidedBy;
  readonly ruleName: string | null;
  readonly entityName: string | null;
  readonly categoryName: string | null;
}): string {
  const target = outcome.categoryName ?? 'no category';
  switch (outcome.decidedBy) {
    case 'RULE':
      return `Matched rule "${outcome.ruleName ?? 'unnamed'}" → ${target}`;
    case 'KEYWORD':
      return `Matched keywords → ${target}`;
    case 'MERCHANT_DEFAULT':
      return `Merchant "${outcome.entityName ?? 'unknown'}" default → ${target}`;
    case 'COUNTERPARTY_DEFAULT':
      return `Counterparty "${outcome.entityName ?? 'unknown'}" default → ${target}`;
    case 'AI':
      return `AI suggested ${target}`;
    case 'USER':
      return `You chose ${target}`;
    case 'FALLBACK':
      return 'Nothing matched; recorded uncategorised';
  }
}

// ---------------------------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------------------------

/**
 * Run the pipeline for one fragment (docs/04 §2, §4, §5, §6, §7).
 *
 * Stage order is enforced by control flow, so a deterministic decision *returns* rather than setting
 * a flag a later stage has to respect. That is the whole anti-regression trick: there is no code path
 * from a rule hit to the AI stage.
 */
export async function runPipeline(input: PipelineInput): Promise<PipelineOutcome> {
  const { fragment, household, categories, folder } = input;

  // ── Stage 3: entity resolution (docs/04 §4 steps 1–4). Pure; the caller loaded the candidates.
  const lexicalMerchant = resolutionWinner(
    resolveEntity(fragment.description, toNlpCandidates(input.merchants, 'MERCHANT')),
  );
  const lexicalCounterparty = resolutionWinner(
    resolveEntity(fragment.description, toNlpCandidates(input.counterparties, 'COUNTERPARTY')),
  );

  /**
   * ── Rung 5: embedding k-NN (docs/04 §4), and only where rungs 1–4 found nothing.
   *
   * "Cheapest first, stopping when a confident hit is found" is the doc's own rule, and it is why this
   * is `await`ed here rather than called by the caller beforehand: a fragment a rule or a keyword
   * already handled must not cost a model call. Both directions are checked here — a lexical hit on
   * *either* side ends the ladder, because the doc's rungs are a single ordered ladder over entities,
   * not one ladder per table.
   */
  let embeddingHit: EmbeddingEntityCandidate | null = null;
  if (lexicalMerchant === null && lexicalCounterparty === null && input.embeddings !== undefined) {
    embeddingHit = await input.embeddings(fragment.description);
  }

  /**
   * The rung travels with the entity, because docs/04 §4 gives every rung a confidence and says the
   * caller's gate — never the ladder — decides the lane.
   *
   * This used to be lost here: `resolutionWinner` returned only the entity, so stage 3.5 below wrote
   * every `MERCHANT_DEFAULT`/`COUNTERPARTY_DEFAULT` at confidence **1.00** however the entity had been
   * found. A name matched on rung 4 (`0.55–0.85`) or rung 5 (`0.60–0.85`) therefore auto-applied a
   * category at 0.90+, which is the opposite of what §4 promises ("rung 4 produces a candidate with a
   * confidence, not a decision"; "this rung never auto-applies"). Fixed in 2.3.4 — see docs/04 §8.1.4.
   */
  const merchantResolution = lexicalMerchant ?? embeddingWinner(embeddingHit, 'MERCHANT');
  const counterpartyResolution =
    lexicalCounterparty ?? embeddingWinner(embeddingHit, 'COUNTERPARTY');
  const merchant = merchantResolution?.entity ?? null;
  const counterparty = counterpartyResolution?.entity ?? null;

  /**
   * `finalize` plus the resolved entities.
   *
   * The two ids are the same for every stage, so they are attached here rather than repeated in six
   * `StageDecision` literals — a field that has to be remembered six times is a field that will be
   * forgotten once.
   */
  const finish = (stage: StageDecision): PipelineOutcome => ({
    ...finalize(input, stage),
    resolvedMerchantId: merchant?.id ?? null,
    resolvedCounterpartyId: counterparty?.id ?? null,
    // Kept separately from the resolved pair: the pair says *what* the row records, this says that
    // rung 5 is what found it, which is what an audit has to be able to tell apart (docs/04 §8.1.2's
    // distinction between resolution and decision, one rung further down).
    embeddingEntity:
      embeddingHit === null
        ? null
        : {
            id: embeddingHit.id,
            kind: embeddingHit.kind,
            name: embeddingHit.name,
            cosine: embeddingHit.cosine,
            model: embeddingHit.model,
          },
  });

  // ── Stage 4: rules and keywords (docs/04 §5). Keywords are the implicit priority-1000 tier, so
  // §5.3.4's "explicit user rules always outrank keywords" is the engine's, not ours.
  const context: EvaluationContext = {
    text: fragment.description,
    description: fragment.description,
    merchantId: merchant?.id ?? null,
    counterpartyId: counterparty?.id ?? null,
    amountMinor: fragment.amountMinor,
    kind: fragment.kind === 'UNKNOWN' ? null : fragment.kind,
    ...dayFields(input.localDay),
  };
  const ruleDecision = evaluateRules(input.rules, context, { folder, keywords: input.keywords });

  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const ruleLosers: AuditCandidate[] = [
    ...ruleDecision.candidates.map((candidate) => toAuditCandidate(candidate, categoryById)),
    ...keywordMatchAudit(ruleDecision, categoryById),
    ...amountCandidates(fragment),
  ];

  /**
   * ── The direction gate (docs/04 §7, §8.1.5, invariant I-3).
   *
   * `@finmate/nlp` sets `needsDirectionConfirmation` on a fragment carrying a reversal word
   * (`Lidl vraćeno 2000`, `storno Lidl`, `refund Lidl`) because the *sign* is a question only the user
   * can answer — it deliberately does not guess, and the golden dataset pins no `kind` for those cases.
   *
   * Every Category in the tree carries a `kind` (I-3), so deciding one here would assert a direction
   * the parser just declined to assert: `Lidl vraćeno 2000` came out as `Hrana / Supermarket` at 0.923
   * — auto-applied, and wrong the moment the user means "Lidl refunded me". That is precisely the
   * overconfident-wrong failure docs/04 §11.2 exists to catch, and the AI is not asked either: a model
   * cannot know the user's intent here, and a guess at 0.6 would only move the guess into the
   * verify lane.
   *
   * So the row is left uncategorised and **blocking** (I-8's `null`-category arm), with the direction
   * as the question to ask. The resolved entity is still recorded — it is what the review queue, the
   * correction path and rule synthesis read — and the losing candidates are kept so the audit can show
   * what the pipeline *would* have said.
   */
  if (fragment.needsDirectionConfirmation) {
    return finish({
      decidedBy: 'FALLBACK',
      categoryId: null,
      ruleId: null,
      ruleName: null,
      entityId: null,
      entityName: null,
      confidence: calibratedConfidenceFromStorage(0),
      rawConfidence: null,
      candidates: [
        ...ruleLosers,
        ...entityLosers(merchant, counterparty),
        { kind: 'DEFAULT', reason: 'direction-unconfirmed' },
      ],
      rung: 'FULL_PIPELINE',
      ai: null,
    });
  }

  if (ruleDecision.decidedBy === 'RULE') {
    return finish({
      decidedBy: 'RULE',
      categoryId: ruleDecision.actions.setCategoryId ?? null,
      ruleId: ruleDecision.ruleId,
      ruleName: ruleDecision.decidingRule?.name ?? null,
      entityId: null,
      entityName: null,
      confidence: calibratedConfidenceFromStorage(1),
      rawConfidence: null,
      candidates: ruleLosers,
      rung: 'FULL_PIPELINE',
      ai: null,
    });
  }

  if (ruleDecision.decidedBy === 'KEYWORD') {
    return finish({
      decidedBy: 'KEYWORD',
      categoryId: ruleDecision.actions.setCategoryId ?? null,
      ruleId: null,
      ruleName: null,
      entityId: null,
      entityName: null,
      // §5.4's band, mapped by the engine. `?? 0` cannot happen for a KEYWORD decision and is the
      // ask lane if it ever did — never a confident lie.
      confidence: calibratedConfidenceFromStorage(ruleDecision.confidence ?? 0),
      rawConfidence: null,
      candidates: ruleLosers,
      rung: 'FULL_PIPELINE',
      ai: null,
    });
  }

  // ── Stage 3.5: the resolved entity's own default category (docs/04 §4's final paragraph, §8.1).
  //
  // Deterministic and free, so it runs **before** the model — otherwise a known Merchant's standing
  // preference would cost a model call. §5.1's `setCategoryId` is where an explicit rule states
  // intent; a default is a preference, so it sits below every rule and keyword and above the model.
  // This is also what makes `MERCHANT_DEFAULT` / `COUNTERPARTY_DEFAULT` reachable at all: the CHECK
  // constraint lists them and nothing else in the codebase produces them.
  const defaulted = fromEntityDefault(merchantResolution, counterpartyResolution);
  if (defaulted !== null) {
    return finish({
      decidedBy: defaulted.decidedBy,
      categoryId: defaulted.categoryId,
      ruleId: null,
      ruleName: null,
      entityId: defaulted.entity.id,
      entityName: defaulted.entity.name,
      // The rung that resolved the entity, not a blanket 1.00 — see docs/04 §8.1.4.
      confidence: calibratedConfidenceFromStorage(defaulted.confidence),
      rawConfidence: null,
      candidates: [...ruleLosers, ...defaulted.losers],
      rung: 'FULL_PIPELINE',
      ai: null,
    });
  }

  // ── Stage 5: AI classify. Reached only when rules, keywords **and** entity defaults were
  // inconclusive (ADR-002, docs/04 §5.4, §12).
  const deterministic: AuditCandidate[] = [...ruleLosers, ...entityLosers(merchant, counterparty)];

  if (input.ai === undefined) {
    // `RULES_KEYWORDS_ONLY`: no model was attempted, so the row is uncategorised and blocking (I-8).
    // An honest `decided_by` — never `AI` — is the point (docs/04 §9's degradation ladder).
    return finish({
      decidedBy: 'FALLBACK',
      categoryId: null,
      ruleId: null,
      ruleName: null,
      entityId: null,
      entityName: null,
      confidence: calibratedConfidenceFromStorage(0),
      rawConfidence: null,
      candidates: [...deterministic, { kind: 'DEFAULT', reason: 'ai-not-attempted' }],
      rung: 'RULES_KEYWORDS_ONLY',
      ai: null,
    });
  }

  const aiResult = await input.ai({
    fragment,
    household,
    ...(merchant ? { merchantName: merchant.name } : {}),
    ...(counterparty ? { counterpartyName: counterparty.name } : {}),
    keywordCandidates: ruleDecision.keyword?.candidates ?? [],
    fragmentIndex: input.fragmentIndex ?? 0,
    fragmentCount: input.fragmentCount ?? 1,
  });

  if (isAiUnavailable(aiResult)) {
    return finish({
      decidedBy: 'FALLBACK',
      categoryId: null,
      ruleId: null,
      ruleName: null,
      entityId: null,
      entityName: null,
      confidence: calibratedConfidenceFromStorage(0),
      rawConfidence: null,
      candidates: [
        ...deterministic,
        { kind: 'DEFAULT', reason: aiResult.reason, rung: aiResult.rung },
      ],
      rung: aiResult.rung,
      ai: null,
    });
  }

  return finish({
    decidedBy: 'AI',
    // A validated proposal has already had an out-of-list id nulled (§6.2), so this is either a real
    // category or `null` + the blocking lane (I-8).
    categoryId: aiResult.categoryId,
    ruleId: null,
    ruleName: null,
    entityId: null,
    entityName: null,
    // The service's `calibrateAiResult` guarantees this; the fallback is the ask lane, never a
    // confident value, so a hypothetical adapter that skipped calibration cannot auto-apply.
    confidence: aiResult.calibratedConfidence ?? calibratedConfidenceFromStorage(0),
    rawConfidence: aiResult.rawConfidence,
    candidates: [
      ...deterministic,
      {
        kind: 'DEFAULT',
        provider: aiResult.provider,
        model: aiResult.model,
        reason: aiResult.rationale,
      },
      ...aiResult.alternatives
        .filter((alternative) => alternative.categoryId !== aiResult.categoryId)
        .map<AuditCandidate>((alternative) => ({
          kind: 'DEFAULT',
          categoryId: alternative.categoryId,
          name: categoryById.get(alternative.categoryId)?.name,
          confidence: alternative.confidence,
        })),
    ],
    rung: 'FULL_PIPELINE',
    ai: {
      provider: aiResult.provider,
      model: aiResult.model,
      promptTemplateId: aiResult.promptTemplateId,
      promptVersion: aiResult.promptVersion,
      latencyMs: aiResult.latencyMs,
      costMicros: aiResult.costMicros,
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------------------------

interface StageDecision {
  readonly decidedBy: DecidedBy;
  readonly categoryId: string | null;
  readonly ruleId: string | null;
  readonly ruleName: string | null;
  readonly entityId: string | null;
  readonly entityName: string | null;
  readonly confidence: CalibratedConfidence;
  readonly rawConfidence: number | null;
  readonly candidates: readonly AuditCandidate[];
  /** `FULL_PIPELINE` unless a stage failed and the caller must render a degraded state. */
  readonly rung: PipelineRung;
  readonly ai: AiAudit | null;
}

/** Apply §7's gate, then assemble the outcome. The single exit from every stage. */
function finalize(input: PipelineInput, stage: StageDecision): PipelineOutcome {
  // §7's null-category arm is inside the gate, not here: the gate is the one place the invariant is
  // enforced, so no stage can accidentally route around it.
  const gate = applyConfidenceGate({
    categoryId: stage.categoryId,
    confidence: stage.confidence,
    fromAi: stage.decidedBy === 'AI',
    ...(input.thresholds ? { thresholds: input.thresholds } : {}),
  });

  const categoryName =
    stage.categoryId === null
      ? null
      : (input.categories.find((category) => category.id === stage.categoryId)?.name ?? null);

  return {
    categoryId: stage.categoryId,
    confidence: stage.confidence,
    rawConfidence: stage.rawConfidence,
    decidedBy: stage.decidedBy,
    ruleId: stage.ruleId,
    ruleName: stage.ruleName,
    entityId: stage.entityId,
    // Filled in by `finish`, which is the only place that knows what resolved. Defaulting here keeps
    // `finalize` callable on its own — and a `null` is honest for a caller that resolved nothing.
    resolvedMerchantId: null,
    embeddingEntity: null,
    resolvedCounterpartyId: null,
    rationale: explainDecision({
      decidedBy: stage.decidedBy,
      ruleName: stage.ruleName,
      entityName: stage.entityName,
      categoryName,
    }),
    candidates: stage.candidates,
    gate,
    rung: stage.rung,
    ai: stage.ai,
  };
}

interface EntityDefault {
  readonly decidedBy: 'MERCHANT_DEFAULT' | 'COUNTERPARTY_DEFAULT';
  readonly categoryId: string;
  readonly entity: { id: string; name: string };
  /** The rung's confidence for the entity that decided — §4's band, not a constant. */
  readonly confidence: number;
  readonly losers: readonly AuditCandidate[];
}

/**
 * An entity that resolved, plus the **rung's** confidence (docs/04 §4).
 *
 * The two travel together because the resolution stage's output is a *candidate*: §4 fixes a
 * confidence per rung precisely so the caller's gate can put the result in the right lane. Dropping
 * the confidence here is what silently promoted a trigram or embedding guess to an auto-applied
 * category before 2.3.4 (docs/04 §8.1.4).
 */
interface ResolvedEntity {
  readonly entity: EntityCandidate;
  readonly confidence: number;
}

/**
 * A resolved entity's default category, if it has one.
 *
 * **Merchant wins a tie.** docs/04 §4 leaves "merchant vs counterparty" to this module and gives the
 * test (`retail semantics`) rather than a rule; where both resolve and both carry a default, the
 * Merchant is the retail-semantics side of that test, so it decides and the Counterparty is recorded
 * as a losing candidate. Deterministic, documented, and visible in `candidates`.
 */
function fromEntityDefault(
  merchant: ResolvedEntity | null,
  counterparty: ResolvedEntity | null,
): EntityDefault | null {
  if (merchant !== null && merchant.entity.defaultCategoryId) {
    return {
      decidedBy: 'MERCHANT_DEFAULT',
      categoryId: merchant.entity.defaultCategoryId,
      entity: { id: merchant.entity.id, name: merchant.entity.name },
      // The rung's own confidence, not 1.00: an entity's standing preference is only as trustworthy
      // as the match that found the entity (docs/04 §4, §8.1.4).
      confidence: merchant.confidence,
      losers: [
        ...(counterparty ? [entityCandidateAudit(counterparty.entity, 'COUNTERPARTY_DEFAULT')] : []),
        ...entityLosers(merchant.entity, counterparty?.entity ?? null),
      ],
    };
  }
  if (counterparty !== null && counterparty.entity.defaultCategoryId) {
    return {
      decidedBy: 'COUNTERPARTY_DEFAULT',
      categoryId: counterparty.entity.defaultCategoryId,
      entity: { id: counterparty.entity.id, name: counterparty.entity.name },
      confidence: counterparty.confidence,
      losers: entityLosers(merchant?.entity ?? null, counterparty.entity),
    };
  }
  return null;
}

/** Every resolved entity that did **not** supply a category, for the audit blob. */
function entityLosers(
  merchant: EntityCandidate | null,
  counterparty: EntityCandidate | null,
): readonly AuditCandidate[] {
  return [
    ...(merchant ? [entityCandidateAudit(merchant, 'MERCHANT_DEFAULT')] : []),
    ...(counterparty ? [entityCandidateAudit(counterparty, 'COUNTERPARTY_DEFAULT')] : []),
  ];
}

/** A rung-5 candidate in the shape the resolution stage works with. */
function fromEmbeddingCandidate(candidate: EmbeddingEntityCandidate): EntityCandidate {
  return {
    id: candidate.id,
    kind: candidate.kind,
    name: candidate.name,
    aliases: [],
    defaultCategoryId: candidate.defaultCategoryId,
  };
}

function entityCandidateAudit(
  entity: EntityCandidate,
  reason: 'MERCHANT_DEFAULT' | 'COUNTERPARTY_DEFAULT',
): AuditCandidate {
  return {
    kind: 'ENTITY',
    id: entity.id,
    name: entity.name,
    reason: entity.defaultCategoryId ? reason : `${reason}:no-default-category`,
  };
}

/**
 * The amount readings `@finmate/nlp` reported (docs/04 §3.1's ambiguity policy).
 *
 * `1.200` is both 1200 and 1.2, and the parser deliberately returns both rather than silently picking
 * one. The user is asked, so the alternatives belong in the audit blob where that question can be
 * reconstructed.
 */
function amountCandidates(fragment: TransactionFragment): readonly AuditCandidate[] {
  if (fragment.candidates.length <= 1) return [];
  return fragment.candidates.map((candidate) => ({
    kind: 'AMOUNT',
    amountMinor: candidate.amountMinor.toString(),
    reason: candidate.reason,
  }));
}

// ---------------------------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------------------------

function resolutionWinner(resolution: EntityResolutionResult): ResolvedEntity | null {
  if (!resolution.resolved || resolution.entity === null) return null;
  // `packages/nlp` sets the pair together, so a `resolved` result always has a confidence; the `?? 0`
  // is the ask lane rather than a confident number if that ever stopped being true.
  return { entity: resolution.entity, confidence: resolution.confidence ?? 0 };
}

/**
 * Rung 5's winner in the same shape, with its confidence from §4's embedding band.
 *
 * `confidenceForCosine` is imported rather than re-derived so the band has exactly one definition —
 * and because its **ceiling is 0.85**, which is the structural reason a rung-5 hit can never
 * auto-apply (ADR-009's 0.90 floor is out of reach by construction, ADR-021).
 */
function embeddingWinner(
  embedding: EmbeddingEntityCandidate | null,
  kind: 'MERCHANT' | 'COUNTERPARTY',
): ResolvedEntity | null {
  if (embedding === null || embedding.kind !== kind) return null;
  return {
    entity: fromEmbeddingCandidate(embedding),
    confidence: confidenceForCosine(embedding.cosine),
  };
}

function toNlpCandidates(
  entities: readonly PipelineEntity[],
  kind: 'MERCHANT' | 'COUNTERPARTY',
): EntityCandidate[] {
  return entities.map((entity) => ({
    id: entity.id,
    kind,
    name: entity.name,
    aliases: entity.aliases,
    defaultCategoryId: entity.defaultCategoryId,
  }));
}

/** Rules-engine loser → the audit blob. Kept lossless: a debugger needs the scores, not a summary. */
function toAuditCandidate(
  candidate: Candidate,
  categories: ReadonlyMap<string, PipelineCategory>,
): AuditCandidate {
  if (candidate.kind === 'RULE') {
    return {
      kind: 'RULE',
      id: candidate.ruleId,
      name: candidate.name,
      score: candidate.specificity,
      reason: `priority ${candidate.priority}, specificity ${candidate.specificity}`,
    };
  }
  return {
    kind: 'KEYWORD',
    categoryId: candidate.categoryId,
    ...(categories.get(candidate.categoryId)?.name !== undefined
      ? { name: categories.get(candidate.categoryId)?.name }
      : {}),
    score: candidate.score,
    matchedTokens: candidate.matchedTokens,
    blocked: candidate.blocked,
  };
}

/**
 * The keyword tier spelled out: which keyword hit which category, at what weight.
 *
 * docs/04 P-3 wants a user told *why*, and "the keyword tier scored Hrana 2.4" is not an answer — the
 * user needs `septička` → `Kuća / Septička jama`. So the individual matches are recorded, not just
 * the totals. An `EXCLUDE` hit is recorded too: it hard-blocks a category (§5.4), and the reason a
 * whole category was skipped must not be a mystery after the fact.
 */
function keywordMatchAudit(
  decision: RuleDecision,
  categories: ReadonlyMap<string, PipelineCategory>,
): readonly AuditCandidate[] {
  const keyword = decision.keyword;
  if (keyword === null) return [];

  const entries: AuditCandidate[] = [];
  for (const candidate of keyword.candidates) {
    for (const match of candidate.matches) {
      entries.push({
        kind: 'KEYWORD',
        id: match.keywordId,
        categoryId: candidate.categoryId,
        ...(categories.get(candidate.categoryId)?.name !== undefined
          ? { name: categories.get(candidate.categoryId)?.name }
          : {}),
        score: candidate.score,
        matchedTokens: candidate.matchedTokens,
        blocked: candidate.blocked,
        polarity: match.polarity,
        matchMode: match.matchMode,
        reason: match.keyword,
      });
    }
  }

  for (const categoryId of keyword.blocked) {
    if (entries.some((entry) => entry.categoryId === categoryId)) continue;
    entries.push({
      kind: 'KEYWORD',
      categoryId,
      ...(categories.get(categoryId)?.name !== undefined
        ? { name: categories.get(categoryId)?.name }
        : {}),
      blocked: true,
      reason: 'hard-blocked by an EXCLUDE keyword',
    });
  }

  return entries;
}

/** ISO weekday + day of month from a local calendar day, for `dayOfWeek` / `dayOfMonth`. */
function dayFields(localDay: string): { dayOfWeek: number; dayOfMonth: number } {
  const [year, month, day] = localDay.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { dayOfWeek: weekday === 0 ? 7 : weekday, dayOfMonth: day };
}
