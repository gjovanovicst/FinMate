import { ArgsType, Field, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

import { Paginated } from '../../graphql/pagination';
import { JsonScalar } from '../../graphql/scalars/json.scalar';
import { LocalDateScalar } from '../../graphql/scalars/uuid.scalar';
import type { InsightView } from './insights.service';

/**
 * The insight feed's GraphQL surface — docs/06 §4.1 (`insights`), §5.10 (`dismissInsight`), §5.13.
 *
 * ## Deviations from the SDL, recorded in docs/06 §5.13
 *
 * - **`kind` stays `String`, not an enum.** A new generator must not need a schema migration, and the
 *   column is an open `TEXT` (docs/03 §4) for the same reason. `severity` **is** an enum: it has a
 *   CHECK constraint, four closed arms, and clients branch on it.
 * - **`dismissInsight` returns the success model directly**, without the `NotFoundError` arm. A missing
 *   insight is not a case the UI has to distinguish — the id came from its own list — and the repo
 *   already declines to declare union arms with no producer (`docs/06` §5.5's `bulkResolveReviewItems`).
 * - **`filter` is an input object** here, unlike `reviewQueue`'s plain arguments, because the filter is
 *   shared by the feed and (later) the dashboard rail, and four optional fields read better as a named
 *   shape than as four positional arguments.
 */

/** docs/03 §4's `insights.severity` CHECK constraint, as a GraphQL enum. */
export enum InsightSeverityEnum {
  INFO = 'INFO',
  POSITIVE = 'POSITIVE',
  WARNING = 'WARNING',
  CRITICAL = 'CRITICAL',
}

registerEnumType(InsightSeverityEnum, {
  name: 'InsightSeverity',
  description:
    '`POSITIVE` is first-class, not a shade of `INFO`: F-22 requires the product to say when a user ' +
    'spent less, and the feed renders it differently (docs/02 §7.1).',
});

@ObjectType()
export class InsightModel {
  @Field(() => ID)
  id!: string;

  @Field(() => String, {
    description:
      'BUDGET_PACE · CATEGORY_SPIKE · UNUSUAL_SPEND · POSITIVE_TREND. An open string so a new ' +
      'generator does not need a schema change (docs/01 §6 F-22).',
  })
  kind!: string;

  @Field(() => InsightSeverityEnum)
  severity!: InsightSeverityEnum;

  @Field(() => LocalDateScalar)
  periodStart!: string;

  @Field(() => LocalDateScalar)
  periodEnd!: string;

  @Field(() => JsonScalar, {
    description:
      'The computed facts behind the insight. Every amount is a minor-unit **string** (ADR-003); the ' +
      'backend computed all of them (ADR-001).',
  })
  payload!: Record<string, unknown>;

  @Field(() => String, {
    nullable: true,
    description:
      'AI-written narration, validated against `payload` (ADR-017). Null in this build: NARRATE is ' +
      'task 3.2.3, and the feed renders the facts without it.',
  })
  narrative!: string | null;

  @Field(() => Boolean)
  isDismissed!: boolean;

  @Field(() => Date)
  createdAt!: Date;
}

@ObjectType()
export class InsightConnection extends Paginated(InsightModel) {}

@InputType()
export class InsightFilterInput {
  @Field(() => [String], { nullable: true })
  kind?: string[];

  @Field(() => [InsightSeverityEnum], { nullable: true })
  severity?: InsightSeverityEnum[];

  @Field(() => Boolean, {
    nullable: true,
    defaultValue: false,
    description: 'Dismissed insights stay in the table: the feed is a record of what we told the user.',
  })
  includeDismissed?: boolean;

  @Field(() => LocalDateScalar, { nullable: true })
  periodStartOnOrAfter?: string;
}

@ArgsType()
export class InsightPageArgs {
  @Field(() => InsightFilterInput, { nullable: true })
  filter?: InsightFilterInput;

  @Field(() => Int, { nullable: true })
  first?: number;

  @Field(() => String, { nullable: true, description: 'Cursor from a previous page (the insight id).' })
  after?: string;
}

/** What `generateInsights` did, so the caller can distinguish "nothing new" from "nothing found". */
@ObjectType()
export class InsightGenerationModel {
  @Field(() => Int, { description: 'Rows written by this run.' })
  created!: number;

  @Field(() => Int, { description: 'Drafts whose condition was already recorded for this period.' })
  alreadyRecorded!: number;

  @Field(() => Int, { description: 'Drafts the generators produced, before de-duplication.' })
  drafts!: number;
}

export function toInsightModel(view: InsightView): InsightModel {
  return {
    id: view.id,
    kind: view.kind,
    severity: view.severity as InsightSeverityEnum,
    periodStart: view.periodStart,
    periodEnd: view.periodEnd,
    payload: view.payload,
    narrative: view.narrative,
    isDismissed: view.isDismissed,
    createdAt: view.createdAt,
  };
}
