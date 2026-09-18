import { Field, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

import { JsonScalar } from '../../graphql/scalars/json.scalar';
import { BalanceScalar } from '../../graphql/scalars/balance.scalar';
import { MoneyScalar } from '../../graphql/scalars/money.scalar';
import { LocalDateScalar, UuidScalar } from '../../graphql/scalars/uuid.scalar';
import { AssistantIntentEnum, type AssistantIntent } from './assistant-intents';
import type { ActionSlotName, AssistantAction } from './assistant-actions';
import { money, type Money } from '@finmate/domain';

import type { ActionDiffEntry, ActionPreviewLine } from './pending-action.store';
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
  ADD_TRANSACTION = 'ADD_TRANSACTION',
  SET_BUDGET = 'SET_BUDGET',
  ADD_GOAL = 'ADD_GOAL',
  ADD_TAG = 'ADD_TAG',
  CREATE_RULE_FROM_CORRECTION = 'CREATE_RULE_FROM_CORRECTION',
}

/**
 * The SDL mirror of the registry, made exhaustive **at compile time**.
 *
 * Nothing else would catch the drift, and B-3a's live pass proved it: the model's `action` field is
 * typed with the *registry's* union, so a member the GraphQL enum lacks compiles perfectly and fails at
 * runtime with `Enum "AssistantAction" cannot represent value: "ADD_TRANSACTION"`. A `Record` keyed by
 * the registry turns that from a 500 into a red squiggle, which is the same argument ADR-035 decision 3
 * makes for the action registry itself.
 */
export const ASSISTANT_ACTION_ENUM_MIRROR: Readonly<
  Record<AssistantAction, AssistantActionEnum>
> = {
  ADD_CATEGORY: AssistantActionEnum.ADD_CATEGORY,
  ADD_TRANSACTION: AssistantActionEnum.ADD_TRANSACTION,
  SET_BUDGET: AssistantActionEnum.SET_BUDGET,
  ADD_GOAL: AssistantActionEnum.ADD_GOAL,
  ADD_TAG: AssistantActionEnum.ADD_TAG,
  CREATE_RULE_FROM_CORRECTION: AssistantActionEnum.CREATE_RULE_FROM_CORRECTION,
};

registerEnumType(AssistantActionEnum, {
  name: 'AssistantAction',
  description: 'A registered assistant action. Closed: the registry has no unregistered member (ADR-035).',
});

/**
 * The slots a proposal's diff can name, mirroring `ActionSlotName`.
 *
 * Registered separately from the action enum because the two answer different questions: the action is
 * *what will happen*, the slot is *which field of the card*. A client identifies a row by the slot and
 * renders it with `field`.
 *
 * ⚠️ **The member names are lower case, and that is load-bearing.** GraphQL serialises a string enum by
 * its member **key**, not by its value, so an `enum { KIND = 'kind' }` reaches a client as `"KIND"` —
 * measured on this very field, where the card's `slot === 'kind'` comparison silently never matched
 * (docs/15). Naming each member after the value it carries keeps one vocabulary from the registry's
 * `ActionSlotName` to the wire, which is the whole reason the field exists.
 */
export enum AssistantActionSlotEnum {
  name = 'name',
  text = 'text',
  kind = 'kind',
  parentId = 'parentId',
  accountId = 'accountId',
  categoryId = 'categoryId',
  amountMinor = 'amountMinor',
  period = 'period',
  targetMinor = 'targetMinor',
  targetDate = 'targetDate',
  // B-5's three: the correction the rule is derived from, and the rule's own two halves.
  correctionId = 'correctionId',
  conditions = 'conditions',
  actions = 'actions',
}

/** {@link ASSISTANT_ACTION_ENUM_MIRROR}'s twin for the slots — same failure, same guard. */
export const ASSISTANT_ACTION_SLOT_ENUM_MIRROR: Readonly<
  Record<ActionSlotName, AssistantActionSlotEnum>
> = {
  name: AssistantActionSlotEnum.name,
  text: AssistantActionSlotEnum.text,
  kind: AssistantActionSlotEnum.kind,
  parentId: AssistantActionSlotEnum.parentId,
  accountId: AssistantActionSlotEnum.accountId,
  categoryId: AssistantActionSlotEnum.categoryId,
  amountMinor: AssistantActionSlotEnum.amountMinor,
  period: AssistantActionSlotEnum.period,
  targetMinor: AssistantActionSlotEnum.targetMinor,
  targetDate: AssistantActionSlotEnum.targetDate,
  correctionId: AssistantActionSlotEnum.correctionId,
  conditions: AssistantActionSlotEnum.conditions,
  actions: AssistantActionSlotEnum.actions,
};

registerEnumType(AssistantActionSlotEnum, {
  name: 'AssistantActionSlot',
  description: 'Which slot of a proposal a diff row is. Stable across languages; `field` is the label.',
});

@ObjectType({ description: 'One field of a proposal, as the confirmation card renders it.' })
export class ActionDiffEntryModel {
  @Field(() => AssistantActionSlotEnum, {
    description:
      'Which slot this row is, stably. The card needs it to attach a control to the right row — ' +
      '`field` is localized for the reader and therefore cannot be an identifier.',
  })
  slot!: ActionSlotName;

  @Field(() => String, { description: 'The field label, in the Household\'s language.' })
  field!: string;

  @Field(() => String, { nullable: true, description: 'The value before, or null when there is none.' })
  before?: string | null;

  @Field(() => String, { nullable: true, description: 'The value after, or null (e.g. "top level").' })
  after?: string | null;

  @Field(() => String, {
    nullable: true,
    description:
      'The same value in the machine\'s own vocabulary where the slot has one (`EXPENSE`/`INCOME` ' +
      'for `kind`), because a localized label cannot tell a card which option is currently proposed. ' +
      'Null for a free-text slot.',
  })
  afterValue?: string | null;

  @Field(() => MoneyScalar, {
    nullable: true,
    description:
      'The value as **Money**, when the value is an amount (a budget\'s limit, a goal\'s target). A ' +
      'row with this set is rendered by the client\'s money component; a row without it is rendered ' +
      'as its label (ADR-003).',
  })
  afterMoney?: Money | null;

  @Field(() => Boolean, {
    description:
      'True when the proposal filled this rather than the question stating it, so the card can offer ' +
      'to change it. Guessing silently is not an option; guessing visibly is (ADR-035 decision 5).',
  })
  defaulted!: boolean;
}

@ObjectType({
  description:
    'One row a proposal will write, for an action that creates a row rather than a named entity. The ' +
    'amount is `Money`, not a formatted string, because the client renders every figure through ' +
    '`fm-money` (ADR-003) — a pre-formatted "180,00 RSD" is a number no money component ever sees.',
})
export class ActionPreviewLineModel {
  @Field(() => String, { description: 'The text the row will carry, as the parser read it.' })
  label!: string;

  @Field(() => MoneyScalar, { description: 'Integer minor units plus currency. Always non-negative.' })
  amount!: Money;

  @Field(() => String, {
    nullable: true,
    description: 'The resolved Category name, or null when nothing chose one (the row needs review).',
  })
  category!: string | null;

  @Field(() => LocalDateScalar, {
    description: "The calendar day the row will be filed under — the text's own date, or the Household's today.",
  })
  occurredOn!: string;

  @Field(() => Boolean, {
    description: 'True when the row will be written `PENDING` and enter the review queue (I-8).',
  })
  needsReview!: boolean;
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

  @Field(() => [ActionPreviewLineModel], {
    description:
      'The rows this action will write. Empty for an action that creates one named entity, where the ' +
      'diff is the whole story.',
  })
  lines!: ActionPreviewLineModel[];
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
  readonly preview?: {
    readonly sentence: string;
    readonly diff: readonly ActionDiffEntry[];
    readonly lines?: readonly ActionPreviewLine[];
  };
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
        : {
            sentence: view.preview.sentence,
            // `?? []` rather than a spread: a proposal stored by the build that had no lines is still
            // a proposal this build must be able to render, and a non-nullable field with `undefined`
            // in it is a 500 (docs/15).
            // `afterMoney` is converted back to `Money` here for the same reason a line's amount is:
            // the store is JSON, and a `bigint` cannot be one.
            diff: view.preview.diff.map((entry) => ({
              slot: entry.slot,
              field: entry.field,
              before: entry.before,
              after: entry.after,
              afterValue: entry.afterValue ?? null,
              afterMoney:
                entry.afterMoney == null
                  ? null
                  : money(BigInt(entry.afterMoney.amountMinor), entry.afterMoney.currency),
              defaulted: entry.defaulted,
            })),
            lines: (view.preview.lines ?? []).map((line) => ({
              label: line.label,
              // The store is JSON, so the amount travels as a string (a `bigint` would make
              // `JSON.stringify` throw); `money()` is what turns it back into the value the scalar
              // serialises, and it refuses a negative on the way (ADR-003).
              amount: money(BigInt(line.amountMinor), line.currency),
              category: line.category,
              occurredOn: line.occurredOn,
              needsReview: line.needsReview,
            })),
          },
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
