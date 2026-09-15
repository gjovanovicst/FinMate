import { Field, Float, ID, InputType, Int, ObjectType, createUnionType, registerEnumType } from '@nestjs/graphql';

import { JsonScalar } from '../../graphql/scalars/json.scalar';
import { MoneyScalar } from '../../graphql/scalars/money.scalar';
import { TransactionKind, TransactionModel } from '../ledger/transaction.model';

/**
 * The learning loop's GraphQL surface — docs/06 §5.3 (`correctTransaction`), §5.4
 * (`createRuleFromCorrection`), and the `Rule`/`Correction` types.
 *
 * ## Deviations from the SDL, all recorded in docs/06 §5.3
 *
 * - **`Rule.version` is absent.** docs/06 declares `version: Int!` for optimistic concurrency, and
 *   the `rules` table has **no `version` column** (docs/03 §4). The same trade the taxonomies already
 *   take: a rule holds no money, so a last-write-wins rename is acceptable, and inventing a column
 *   would be a migration for a race nobody has hit. `merchants` set the precedent (AGENTS.md).
 * - **`explanationCode` is added** to `RuleProposal`. docs/06 says `explanation` is "shown verbatim";
 *   this codebase's rule is that the API returns a stable code and a safe English message while the
 *   *client* owns the wording, so the client localises the code and `explanation` is the fallback.
 * - **`ruleConflicts` is added** to `CorrectTransactionSuccess`. A correction that WAS applied must
 *   not come back as an error arm, or the client would tell the user nothing happened.
 * - **`backfillPreview`/`backfill` and `dashboardDelta` are absent.** The bulk re-classify is its own
 *   increment with its own correctness story (it rewrites `category_id` on N Transactions and has to
 *   respect I-3 and the audit trail); `dashboardDelta` is absent for the reason §5.2.4 records.
 */

/** `rules.origin`. */
export enum RuleOriginEnum {
  USER = 'USER',
  LEARNED = 'LEARNED',
  SYSTEM = 'SYSTEM',
  IMPORT = 'IMPORT',
}

registerEnumType(RuleOriginEnum, {
  name: 'RuleOrigin',
  description:
    '`LEARNED` means the product proposed it from a correction and the user accepted (ADR-010); a ' +
    '`LEARNED` rule is never presented as one the user wrote.',
});

/** docs/06 §5.3's `RuleSynthesisTrigger`. */
export enum RuleSynthesisTriggerEnum {
  COUNTERPARTY_RESOLVED = 'COUNTERPARTY_RESOLVED',
  MERCHANT_RESOLVED = 'MERCHANT_RESOLVED',
  DISTINCTIVE_TOKEN = 'DISTINCTIVE_TOKEN',
  REPEATED_MERCHANT_CORRECTION = 'REPEATED_MERCHANT_CORRECTION',
  CONTRADICTS_EXISTING_RULE = 'CONTRADICTS_EXISTING_RULE',
}

registerEnumType(RuleSynthesisTriggerEnum, {
  name: 'RuleSynthesisTrigger',
  description:
    'What the proposal was derived from, narrowest first. `REPEATED_MERCHANT_CORRECTION` is advice ' +
    'to change that Merchant’s default instead of adding a fourth rule (docs/04 §8.2).',
});

/** `corrections.field`. */
export enum CorrectionFieldEnum {
  category = 'category',
  merchant = 'merchant',
  counterparty = 'counterparty',
  kind = 'kind',
  amount = 'amount',
}

registerEnumType(CorrectionFieldEnum, {
  name: 'CorrectionField',
  description:
    'Which property the user corrected. `kind` is refused: direction is not a flippable property ' +
    '(AGENTS.md), and the CHECK allows the value only because the table is shared with imports.',
});

@ObjectType({
  description:
    'An existing rule that would win on a proposed rule’s own trigger input — so the proposal would ' +
    'never fire. docs/04 §8.2: offer to edit that rule rather than shadow it, because shadowing ' +
    'rules is how rule sets rot.',
})
export class RuleConflictModel {
  @Field(() => ID)
  ruleId!: string;

  @Field(() => String)
  ruleName!: string;

  @Field(() => Int, { description: 'Lower wins (docs/04 §5.3.1).' })
  priority!: number;

  @Field(() => String, {
    description:
      'The condition field the two rules overlap on — `merchant`, `counterparty` or `text`.',
  })
  overlappingField!: string;

  @Field(() => String, {
    nullable: true,
    description:
      'The Category the existing rule sets. Equal to `proposedValue` means that rule already covers ' +
      'this input, so the proposal is redundant rather than contradictory.',
  })
  existingValue!: string | null;

  @Field(() => String, { nullable: true })
  proposedValue!: string | null;
}

@ObjectType({
  description: 'A candidate rule, derived from a correction and **not yet saved** (docs/04 §8.1).',
})
export class RuleProposalModel {
  @Field(() => String)
  name!: string;

  @Field(() => Int, { description: 'Lower wins. Learned rules share the user tier and are ordered by specificity.' })
  priority!: number;

  @Field(() => JsonScalar, { description: 'A condition tree: `{ all: [{ field, op, value }] }`.' })
  conditions!: unknown;

  @Field(() => JsonScalar, { description: '`{ setCategoryId, setMerchantId, addTagIds, setDescription }`.' })
  actions!: unknown;

  @Field(() => RuleOriginEnum)
  origin!: RuleOriginEnum;

  @Field(() => String, {
    description:
      'A safe English sentence, per docs/06 §5.3. The client should prefer `explanationCode` so the ' +
      'proposal reads in the user’s language.',
  })
  explanation!: string;

  @Field(() => String, {
    description:
      'A stable code (`RULE_SYNTH_*`) the client localises. Additive to the SDL; see the module note.',
  })
  explanationCode!: string;

  @Field(() => RuleSynthesisTriggerEnum)
  trigger!: RuleSynthesisTriggerEnum;

  @Field(() => Float, {
    description:
      'How much the trigger is worth trusting, `0..1`. Derived (docs/04 gives no numbers): a ' +
      'resolved entity is a fact about the user’s data, a text token is a guess about their wording. ' +
      'Used for ordering and explanation only — nothing auto-applies.',
  })
  confidence!: number;
}

@ObjectType({ description: 'One row of `rules` (docs/06 §5.3).' })
export class RuleModel {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  name!: string;

  @Field(() => Int, { description: 'Lower wins.' })
  priority!: number;

  @Field(() => Boolean)
  isActive!: boolean;

  @Field(() => Boolean, { description: 'The first matching stop rule is the decision (docs/04 §5.3.2).' })
  stopOnMatch!: boolean;

  @Field(() => JsonScalar)
  conditions!: unknown;

  @Field(() => JsonScalar)
  actions!: unknown;

  @Field(() => RuleOriginEnum)
  origin!: RuleOriginEnum;

  @Field(() => ID, { nullable: true })
  sourceCorrectionId!: string | null;

  @Field(() => String, { description: 'Count of committed Transactions this rule decided, as a string.' })
  hitCount!: string;

  @Field(() => Date, { nullable: true })
  lastHitAt!: Date | null;

  @Field(() => Boolean, {
    description:
      '`hitCount = 0` and older than 90 days (docs/04 §8.2). Surfaced so the user can prune; the ' +
      'rule itself is never auto-deleted.',
  })
  isStale!: boolean;

  @Field(() => [RuleConflictModel], {
    description:
      'Rules that would win on this rule’s own witnessed input, so it may never fire. A **witnessed** ' +
      'check, not a general static analysis: it asks the real engine who wins on an input this rule ' +
      'matches, so it cannot drift from runtime behaviour. A rule whose conditions yield no witness ' +
      'reports none.',
  })
  conflictsWith!: RuleConflictModel[];

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;
}

@ObjectType({
  description:
    'The durable learning signal (docs/04 §8). Corrections are append-only: they are what the weekly ' +
    'calibration re-fit and the "was this proposal any good?" question read.',
})
export class CorrectionModel {
  @Field(() => ID)
  id!: string;

  @Field(() => ID, { nullable: true })
  transactionId!: string | null;

  @Field(() => CorrectionFieldEnum)
  field!: CorrectionFieldEnum;

  @Field(() => String, { nullable: true })
  fromValue!: string | null;

  @Field(() => String, { nullable: true })
  toValue!: string | null;

  @Field(() => Boolean, {
    description: 'True when a model had proposed the value the user changed.',
  })
  wasAiSuggested!: boolean;

  @Field(() => ID, { nullable: true })
  ruleCreatedId!: string | null;

  @Field(() => RuleModel, { nullable: true })
  ruleCreated!: RuleModel | null;

  @Field(() => Date)
  createdAt!: Date;
}

@InputType()
export class CorrectTransactionInput {
  @Field(() => ID)
  transactionId!: string;

  @Field(() => Int, {
    nullable: true,
    description: 'Optimistic concurrency. A mismatch is a CONFLICT rather than a silent overwrite.',
  })
  version?: number | null;

  @Field(() => CorrectionFieldEnum)
  field!: CorrectionFieldEnum;

  @Field(() => ID, { nullable: true })
  categoryId?: string | null;

  @Field(() => ID, { nullable: true })
  merchantId?: string | null;

  @Field(() => ID, { nullable: true })
  counterpartyId?: string | null;

  @Field(() => MoneyScalar, { nullable: true })
  amount?: { amountMinor: string; currency: string } | null;

  @Field(() => TransactionKind, { nullable: true })
  kind?: TransactionKind | null;

  @Field(() => Boolean, {
    defaultValue: false,
    description:
      'The "Zapamti za ubuduće" checkbox (F-09). The proposal is returned either way; this only ' +
      'says whether the user asked. A rule is NEVER created here — docs/04 §8.2, ADR-010.',
  })
  rememberForFuture!: boolean;
}

@InputType()
export class RuleOverrideInput {
  @Field(() => String, { nullable: true })
  name?: string | null;

  @Field(() => Int, { nullable: true })
  priority?: number | null;

  @Field(() => Boolean, { nullable: true })
  isActive?: boolean | null;

  @Field(() => Boolean, { nullable: true })
  stopOnMatch?: boolean | null;

  @Field(() => JsonScalar, { nullable: true })
  conditions?: unknown;

  @Field(() => JsonScalar, { nullable: true })
  actions?: unknown;
}

@InputType()
export class CreateRuleFromCorrectionInput {
  @Field(() => ID)
  correctionId!: string;

  @Field(() => Boolean, {
    defaultValue: true,
    description:
      '`false` means "this was a one-off". The rule is not created. The refusal is **not** persisted ' +
      '— `corrections` has no column for it — so it is currently only an answered prompt.',
  })
  acceptProposal!: boolean;

  @Field(() => RuleOverrideInput, {
    nullable: true,
    description:
      'The user edited the proposal before saving. Passing overrides also means the user has ' +
      'authored the rule, so a shadowing conflict is recorded on the result rather than refused.',
  })
  overrides?: RuleOverrideInput | null;
}

@ObjectType()
export class CorrectTransactionSuccessModel {
  @Field(() => TransactionModel)
  transaction!: TransactionModel;

  @Field(() => CorrectionModel, {
    description: 'The correction, always written. This is the learning signal.',
  })
  correction!: CorrectionModel;

  @Field(() => RuleProposalModel, {
    nullable: true,
    description:
      'Present when a rule could be derived. `null` means there was nothing to key a rule on — a ' +
      'resolved entity or a distinctive word — which is a legitimate outcome, not a failure.',
  })
  synthesisedRule!: RuleProposalModel | null;

  @Field(() => [RuleConflictModel], {
    description:
      'Rules that would win on the proposal’s own trigger input, so accepting it would add a rule ' +
      'that never fires. Additive to the SDL: carried on the SUCCESS arm because the correction was ' +
      'applied regardless.',
  })
  ruleConflicts!: RuleConflictModel[];
}

@ObjectType()
export class CreateRuleFromCorrectionSuccessModel {
  @Field(() => RuleModel)
  rule!: RuleModel;

  @Field(() => CorrectionModel)
  correction!: CorrectionModel;

  @Field(() => Date, {
    description:
      'When the rule became visible to the pipeline. Nothing is cached — rules are read on every ' +
      'parse — so this is the moment of the write and the next parse sees it.',
  })
  cacheInvalidatedAt!: Date;

  @Field(() => [RuleConflictModel], {
    description: 'Populated only when the user overrode the proposal, i.e. authored the rule themselves.',
  })
  ruleConflicts!: RuleConflictModel[];
}

@ObjectType()
export class RuleConflictErrorModel {
  @Field(() => String)
  code!: string;

  @Field(() => String)
  message!: string;

  @Field(() => RuleProposalModel)
  proposal!: RuleProposalModel;

  @Field(() => [RuleConflictModel])
  conflicting!: RuleConflictModel[];
}

/**
 * `correctTransaction` returns the success type **directly**, not a union.
 *
 * docs/06 §5.3 declares `union CorrectTransactionResult = CorrectTransactionSuccess | RuleConflictError
 * | ConflictError | NotFoundError`. Two of those arms are request-level failures this codebase already
 * carries as typed GraphQL errors on `extensions.code` (`CONFLICT`, `NOT_FOUND`), and the third —
 * `RuleConflictError` — cannot apply, because the correction was **applied and recorded** by the time
 * a proposal conflict is known. Returning an error arm would tell the client nothing happened. So the
 * conflicts ride on the success payload as `ruleConflicts`. Recorded in docs/06 §5.3.
 */
export const CreateRuleFromCorrectionResult = createUnionType({
  name: 'CreateRuleFromCorrectionResult',
  description:
    'The rule was created, or the proposal would be shadowed by an existing rule and the caller did ' +
    'not override it — docs/04 §8.2 surfaces that instead of silently adding a dead rule.',
  types: () => [CreateRuleFromCorrectionSuccessModel, RuleConflictErrorModel] as const,
  resolveType: (value: object) =>
    'conflicting' in value ? RuleConflictErrorModel : CreateRuleFromCorrectionSuccessModel,
});
