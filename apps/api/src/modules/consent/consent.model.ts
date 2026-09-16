import { Field, InputType, ObjectType, registerEnumType } from '@nestjs/graphql';

import { CONSENT_POLICY_VERSION, type ConsentKind, type ConsentState, type ConsentView } from './consent';

/**
 * The consent surface — docs/06 §4 (`HouseholdSettings.aiConsentGiven`), docs/08 §6.6.
 *
 * ## Why an enum and not `aiConsentGiven: Boolean!`
 *
 * docs/06 §4 sketches a single boolean on `HouseholdSettings`. docs/08 §6.6 is explicit that consent
 * must be "**granular** (four independent purposes, never 'accept all')", and a boolean cannot answer
 * "may the Receipt image go?" separately from "may the free text go?" — which matters because they
 * leave through different endpoints and a Household may reasonably allow one and not the other. The
 * boolean remains the *summary a screen renders*; the record is per purpose.
 *
 * `MARKETING_EMAIL` is deliberately absent: v1 sends no marketing (docs/08 §7), and a control that
 * cannot work is not shipped (docs/02 §2).
 */
export enum ConsentKindEnum {
  AI_DATA_PROCESSING = 'AI_DATA_PROCESSING',
  CLOUD_OCR = 'CLOUD_OCR',
  EVAL_DATASET = 'EVAL_DATASET',
}

/** The state of one purpose. `NOT_ASKED` is a real value, not a synonym for `DECLINED`. */
export enum ConsentStateEnum {
  NOT_ASKED = 'NOT_ASKED',
  GRANTED = 'GRANTED',
  DECLINED = 'DECLINED',
  WITHDRAWN = 'WITHDRAWN',
}

registerEnumType(ConsentKindEnum, {
  name: 'ConsentKind',
  description:
    'A purpose the Household decides on separately (docs/08 §6.6). The stored `kind` vocabulary is ' +
    "docs/03 §4's; each maps onto one or two docs/08 purposes, which `purposes` returns.",
});

registerEnumType(ConsentStateEnum, {
  name: 'ConsentState',
  description:
    'NOT_ASKED is treated as DECLINED by every enforcement point: absence of consent is never ' +
    'permission (docs/08 §6.6). The two are still distinguished in the record, which is the evidence.',
});

@ObjectType()
export class ConsentModel {
  @Field(() => ConsentKindEnum)
  kind!: ConsentKind;

  @Field(() => ConsentStateEnum)
  state!: ConsentState;

  @Field(() => Date, {
    nullable: true,
    description: 'When the newest record was written. Null when the Household has never decided.',
  })
  recordedAt!: Date | null;

  @Field(() => String, {
    nullable: true,
    description: 'The revision of the consent copy that was shown. A bump forces re-consent.',
  })
  policyVersion!: string | null;

  @Field(() => [String], {
    description:
      "The docs/08 §6.6 purpose vocabulary this stored kind stands for — AI_TEXT_EGRESS and " +
      'AI_NARRATION share one record, because docs/03 §4\'s CHECK has no value between them.',
  })
  purposes!: string[];
}

@InputType()
export class RecordConsentInput {
  @Field(() => ConsentKindEnum)
  kind!: ConsentKind;

  @Field(() => ConsentStateEnum, {
    description:
      'GRANTED, DECLINED or WITHDRAWN. NOT_ASKED is the absence of a record and cannot be written.',
  })
  state!: ConsentState;

  @Field(() => String, {
    nullable: true,
    description: `Defaults to this build's copy revision (${CONSENT_POLICY_VERSION}).`,
  })
  policyVersion?: string;

  @Field(() => String, {
    nullable: true,
    description: 'The UI surface that showed the copy, e.g. `settings` or `capture-sheet`.',
  })
  surface?: string;

  @Field(() => String, {
    nullable: true,
    description: 'The locale the copy was shown in. Part of the evidence, not a preference.',
  })
  locale?: string;
}

/**
 * The GraphQL shape of a consent state.
 *
 * A plain function rather than a class method, matching `notification.model.ts`: what the wire
 * carries is a projection of the row, and the projection is worth one named place because the copy
 * the screen renders (`purposes`, `policyVersion`) has to come from the same source as the decision
 * the gate reads.
 */
export function toConsentModel(view: ConsentView): ConsentModel {
  const model = new ConsentModel();
  model.kind = view.kind;
  model.state = view.state;
  model.recordedAt = view.recordedAt;
  model.policyVersion = view.policyVersion;
  model.purposes = [...view.purposes];
  return model;
}
