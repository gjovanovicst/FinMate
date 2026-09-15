import { Field, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

import { JsonScalar } from '../../graphql/scalars/json.scalar';
import { MoneyScalar } from '../../graphql/scalars/money.scalar';
import { LocalDateScalar, UuidScalar } from '../../graphql/scalars/uuid.scalar';
import { AssistantIntentEnum, type AssistantIntent } from './assistant-intents';
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

  @Field(() => MoneyScalar)
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
