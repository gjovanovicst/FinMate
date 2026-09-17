import { Field, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

import { JsonScalar } from '../../graphql/scalars/json.scalar';
import { BalanceScalar } from '../../graphql/scalars/balance.scalar';
import { LocalDateScalar, UuidScalar } from '../../graphql/scalars/uuid.scalar';
import { AssistantIntentEnum, type AssistantIntent } from './assistant-intents';
import type { AssistantAction } from './assistant-actions';
import type { ActionDiffEntry } from './pending-action.store';
import type { AssistantAnswerView, DrillThroughView, NarrationMode } from './assistant.service';
import type { AssistantFactsView, FactRowView, FactTotalView, ProvenanceView } from './fact-assembly.service';

/**
 * The assistant's GraphQL surface — docs/06 §4.4.
 *
 * Every type here is a **view** of a value the service already computed; nothing is derived in the
 * resolver, which is what keeps "the backend computes" true all the way to the wire.
 *
 * @module apps/api/src/modules/assistant
 */

registerEnumType(AssistantIntentEnum, {
  name: 'AssistantIntent',
  description: 'The closed template set the planner selects from (docs/06 §8.1).',
});

export enum NarrationModeEnum {
  LLM = 'LLM',
  TEMPLATE_FALLBACK = 'TEMPLATE_FALLBACK',
}

registerEnumType(NarrationModeEnum, {
  name: 'NarrationMode',
  description:
    'How `answerText` was produced. A fallback is not an error: it is the same answer rendered ' +
    'deterministically because no provider was reachable or the model invented a figure.',
});

@ObjectType({ description: 'One ranked or listed fact. `value` is the machine value (docs/06 §8.2).' })
export class AssistantFactRowModel {
  @Field(() => String)
  label!: string;

  @Field(() => String, { description: 'Minor units for money, a count otherwise. Never a float.' })
  value!: string;

  @Field(() => String, { description: 'The same value, currency- and locale-formatted.' })
  formatted!: string;

  @Field(() => UuidScalar, { nullable: true })
  categoryId?: string | null;

  @Field(() => UuidScalar, { nullable: true })
  merchantId?: string | null;
}

@ObjectType()
export class AssistantFactTotalModel {
  @Field(() => String)
  label!: string;

  /**
   * ⚠️ **`BalanceScalar`, not `MoneyScalar`, and this was a 500.**
   *
   * Every total the assembler produces is derived — `Income − spending`, a period-over-period change,
   * a budget's `remaining`, an account's `balance`, a projection's overrun — so any of them can be
   * negative, and `MoneyScalar` refuses a negative `amountMinor` at serialisation (ADR-003 keeps a
   * *Transaction amount* non-negative; a *derived* figure is a Balance). The dashboard and the
   * Accounts screen already expose their derived figures as Balances for the same reason, so this
   * aligns the assistant with them rather than inventing a third representation.
   *
   * The **wire shape is unchanged** (`{ amountMinor, currency }`, `amountMinor` a signed integer
   * string) and the client's `fm-money` already formats through `formatBalance`, so no query, no
   * component and no type on the web changed.
   */
  @Field(() => BalanceScalar, {
    description:
      'A derived, SIGNED figure — `amountMinor` may be negative (a loss, an overspend, an overdraft). ' +
      'Read-only: a Balance is computed by the backend and can never be supplied as input.',
  })
  money!: { amountMinor: string; currency: string };

  @Field(() => String)
  formatted!: string;
}

@ObjectType({
  description:
    'The ONLY numbers the answer may contain (docs/06 §8.2). `formatted` is the exact set of ' +
    'strings the narrator was given.',
})
export class AssistantFactsModel {
  @Field(() => AssistantIntentEnum)
  template!: AssistantIntent;

  @Field(() => [AssistantFactRowModel])
  rows!: readonly FactRowView[];

  @Field(() => [AssistantFactTotalModel])
  totals!: readonly FactTotalView[];

  @Field(() => JsonScalar)
  formatted!: Readonly<Record<string, string>>;
}

@ObjectType({ description: 'What the figure rests on: docs/06 §8.3. Trust comes from being checkable.' })
export class ProvenanceModel {
  @Field(() => LocalDateScalar)
  periodStart!: string;

  @Field(() => LocalDateScalar)
  periodEnd!: string;

  @Field(() => Int, { description: 'CONFIRMED, non-deleted Transactions aggregated.' })
  transactionCount!: number;

  @Field(() => String, { description: 'The repository method, e.g. `spend.byCategory.v1`.' })
  sourceQuery!: string;

  @Field(() => JsonScalar, { nullable: true })
  filters?: Readonly<Record<string, string>> | null;

  @Field(() => Date)
  computedAt!: Date;

  @Field(() => String)
  ledgerCurrency!: string;
}

@ObjectType({
  description:
    'Where the user can check the answer. `null` when no route can reproduce the scope — a link ' +
    'that cannot is worse than none (docs/06 §4.4).',
})
export class DrillThroughModel {
  @Field(() => String)
  route!: string;

  @Field(() => [UuidScalar])
  transactionIds!: readonly string[];

  @Field(() => JsonScalar, {
    nullable: true,
    description: 'The `transactions` query arguments that reproduce the scope, by name.',
  })
  filter?: Readonly<Record<string, string>> | null;
}

@ObjectType({ description: 'docs/06 §4.4 and §8.5.' })
export class AssistantAnswerModel {
  @Field(() => UuidScalar)
  id!: string;

  @Field(() => String)
  question!: string;

  @Field(() => AssistantIntentEnum)
  intent!: AssistantIntent;

  @Field(() => Boolean, {
    description:
      'False when the template set cannot answer it. Then `answerText` says so, `suggestions` lists ' +
      'the answerable questions, and **no figure is produced** (docs/06 §8.5).',
  })
  answered!: boolean;

  @Field(() => String)
  answerText!: string;

  @Field(() => AssistantFactsModel)
  facts!: AssistantFactsView;

  @Field(() => ProvenanceModel)
  provenance!: ProvenanceView;

  @Field(() => DrillThroughModel, { nullable: true })
  drillThrough?: DrillThroughView | null;

  @Field(() => [String])
  suggestions!: readonly string[];

  @Field(() => NarrationModeEnum)
  narrationMode!: NarrationMode;

  @Field(() => Int, { description: 'The whole answer, including the aggregate.' })
  latencyMs!: number;

  @Field(() => String, { nullable: true, description: 'Provider spend for this answer, in micros.' })
  costMicros?: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'Why this is a refusal or a fallback — `UNACCOUNTED_NUMERALS:…`, `NOT_BUILT:goals`, … The UI ' +
      'does not show it as an error; it is what makes a fallback diagnosable.',
  })
  reason?: string | null;
}

/**
 * Map the service's view onto the wire type. No computation, no formatting — a resolver that derives
 * anything is a second place a figure can be born.
 */
export function toAssistantAnswerModel(view: AssistantAnswerView): AssistantAnswerModel {
  return {
    id: view.id,
    question: view.question,
    intent: view.intent,
    answered: view.answered,
    answerText: view.answerText,
    facts: view.facts,
    provenance: view.provenance,
    drillThrough: view.drillThrough,
    suggestions: view.suggestions,
    narrationMode: view.narrationMode as NarrationModeEnum,
    latencyMs: view.latencyMs,
    costMicros: view.costMicros,
    reason: view.reason,
  };
}

// ---------------------------------------------------------------------------------------------
// The write side — propose → confirm → execute (docs/06 §8.16, ADR-035)
// ---------------------------------------------------------------------------------------------

/**
 * The closed set of writes the assistant may propose. Mirrors `ASSISTANT_ACTIONS`, and registered so
 * the schema names the same vocabulary the registry declares — a client cannot ask for an action by
 * string.
 */
export enum AssistantActionEnum {
  ADD_CATEGORY = 'ADD_CATEGORY',
}

registerEnumType(AssistantActionEnum, {
  name: 'AssistantAction',
  description: 'A registered assistant action. Closed: the registry has no unregistered member (ADR-035).',
});

@ObjectType({ description: 'One field of a proposal, as the confirmation card renders it.' })
export class ActionDiffEntryModel {
  @Field(() => String)
  field!: string;

  @Field(() => String, { nullable: true, description: 'The value before, or null when there is none.' })
  before?: string | null;

  @Field(() => String, { nullable: true, description: 'The value after, or null (e.g. "top level").' })
  after?: string | null;

  @Field(() => Boolean, {
    description:
      'True when the proposal filled this rather than the question stating it, so the card can offer ' +
      'to change it. Guessing silently is not an option; guessing visibly is (ADR-035 decision 5).',
  })
  defaulted!: boolean;
}

@ObjectType({
  description:
    'The backend-rendered proposal. Never narrated: a write confirmation is a numeral-bearing ' +
    'statement, so ADR-017 applies to it exactly as to an answer (ADR-035 decision 8).',
})
export class AssistantActionPreviewModel {
  @Field(() => String)
  sentence!: string;

  @Field(() => [ActionDiffEntryModel])
  diff!: ActionDiffEntryModel[];
}

@ObjectType({
  description:
    'A proposed write awaiting a human click. `proposed: false` is a refusal, not an error: the ' +
    'question asked for nothing this registry does, or asked without saying what.',
})
export class AssistantActionProposalModel {
  @Field(() => Boolean)
  proposed!: boolean;

  @Field(() => String, { nullable: true, description: 'Why not, when `proposed` is false.' })
  reason?: string | null;

  @Field(() => UuidScalar, {
    nullable: true,
    description: 'Opaque, single-use, and the **only** argument `assistantExecuteAction` accepts.',
  })
  proposalId?: string | null;

  @Field(() => AssistantActionEnum, { nullable: true })
  action?: AssistantAction | null;

  @Field(() => AssistantActionPreviewModel, { nullable: true })
  preview?: AssistantActionPreviewModel | null;

  @Field(() => Date, { nullable: true })
  expiresAt?: Date | null;
}

@ObjectType({ description: 'The written row, and how to undo it.' })
export class AssistantActionResultModel {
  @Field(() => AssistantActionEnum)
  action!: AssistantAction;

  @Field(() => UuidScalar)
  createdId!: string;

  @Field(() => String)
  createdLabel!: string;

  @Field(() => String, {
    description:
      'How the action can be undone (`SOFT_DELETE`, `UNDO_CAPTURE`, `NONE`). An action with `NONE` is ' +
      'not offered at all, so this is never the reason a write is irreversible.',
  })
  undo!: string;

  @Field(() => String, { description: 'The confirmation, quoting the returned row.' })
  sentence!: string;

  @Field(() => Boolean, {
    description: 'True when the caller\'s idempotency key had already produced this result.',
  })
  replayed!: boolean;
}

/** The service's view onto the wire type — no computation here, for the same reason as the answer. */
export function toActionProposalModel(view: {
  readonly proposed: boolean;
  readonly reason?: string | null;
  readonly proposalId?: string;
  readonly action?: AssistantAction;
  readonly preview?: { readonly sentence: string; readonly diff: readonly ActionDiffEntry[] };
  readonly expiresAt?: Date;
}): AssistantActionProposalModel {
  return {
    proposed: view.proposed,
    reason: view.reason ?? null,
    proposalId: view.proposalId ?? null,
    action: view.action ?? null,
    preview:
      view.preview === undefined
        ? null
        : { sentence: view.preview.sentence, diff: [...view.preview.diff] },
    expiresAt: view.expiresAt ?? null,
  };
}

export function toActionResultModel(view: {
  readonly action: AssistantAction;
  readonly createdId: string;
  readonly createdLabel: string;
  readonly undo: string;
  readonly sentence: string;
  readonly replayed: boolean;
}): AssistantActionResultModel {
  return { ...view };
}
