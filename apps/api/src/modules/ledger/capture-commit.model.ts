import { Field, Float, ID, InputType, Int, ObjectType, createUnionType, registerEnumType } from '@nestjs/graphql';

import { MoneyScalar } from '../../graphql/scalars/money.scalar';
import { LocalDateScalar } from '../../graphql/scalars/uuid.scalar';
import { ClassificationDecisionModel } from '../classification/classification.model';
import { TransactionKind, TransactionModel } from './transaction.model';

/**
 * The GraphQL surface of `captureCommit` (docs/06 §5.2).
 *
 * ## Why the result is a union
 *
 * §5.2 declares `union CaptureCommitResult = CaptureCommitSuccess | ... | ConflictError |
 * RateLimitedError`. The two error arms are **not** modelled as union members here, and that is a
 * deliberate deviation recorded in docs/06 §5.2: this codebase already surfaces `CONFLICT` and
 * `RATE_LIMITED` as typed GraphQL errors on `extensions.code` (`ApiError` → `AllExceptionsFilter`),
 * which every client already branches on to refresh a session. A second, unrelated representation of
 * the same code in the same schema would be two sources of truth for one contract. Rejection of the
 * *rows* is different in kind — it is a successful round trip carrying per-row diagnostics — so it
 * stays a union member.
 *
 * ## Why `dashboardDelta` is absent
 *
 * §5.2 declares it on `CaptureCommitSuccess`. It is not built: §5.2.3's delta is a caching
 * optimisation for a client with a normalised store, and this client refetches `dashboard`, which
 * already exists as one round trip on a screen the user is leaving. `reviewQueueCount` and `cursor`
 * — the two values a commit actually changes on the hottest path — *are* returned. Adding the rest
 * later is additive. Recorded in docs/06 §5.2.4 alongside the union and naming deviations.
 */

/** `ErrorCode` values a commit can produce, mirroring the `ApiErrorCode` union. */
export enum CaptureRejectionCode {
  /** A structurally invalid row: an unparseable amount, a category of the wrong `kind` (I-3), … */
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  /** A referenced row this Household cannot see — an account, a category, a proposal. */
  NOT_FOUND = 'NOT_FOUND',
  /** Two rows in one request claim the same `idempotencyKey`, or the same `clientRowId`. */
  CONFLICT = 'CONFLICT',
}

registerEnumType(CaptureRejectionCode, {
  name: 'CaptureRejectionCode',
  description:
    'Why a commit row was refused. docs/06 §5.2 calls the field `ErrorCode`; the enum is named for ' +
    'its scope because §3.1 does not declare a global `ErrorCode`, and request-level failures keep ' +
    'travelling as typed GraphQL errors rather than as a schema enum.',
});

@InputType({
  description:
    'One row of a capture commit (docs/06 §5.2). The split arm is deliberately absent: a capture row ' +
    'is one category, and a divided Transaction is edited as parts (ADR-015, I-1).',
})
export class CaptureCommitRowInput {
  @Field(() => String, {
    description: 'Stable within the request and echoed back, so a client can match rows to results.',
  })
  clientRowId!: string;

  @Field(() => String, {
    description:
      'REQUIRED. Unique per Household (I-10); a replay returns the original row with ' +
      '`wasReplayed = true` rather than creating a second one.',
  })
  idempotencyKey!: string;

  @Field(() => String, {
    nullable: true,
    description:
      'A UUIDv7 for an offline-originated row. Unique per Household and permanent, so an outbox ' +
      'flushed twice collapses to one Transaction (docs/06 §5.2.2).',
  })
  clientId?: string | null;

  @Field(() => ID, {
    nullable: true,
    description: 'Falls back to the request-level `defaultAccountId`.',
  })
  accountId?: string | null;

  @Field(() => TransactionKind, {
    description: 'Direction. `amount` is always positive (ADR-003).',
  })
  kind!: TransactionKind;

  @Field(() => MoneyScalar)
  amount!: { amountMinor: string; currency: string };

  @Field(() => ID, {
    nullable: true,
    description:
      'The user’s choice when they overrode the proposal. Absent means "take the proposal’s, or ' +
      'classify this row now".',
  })
  categoryId?: string | null;

  @Field(() => ID, { nullable: true })
  merchantId?: string | null;

  @Field(() => ID, { nullable: true })
  counterpartyId?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'Defaults to the accepted proposal’s description, then to the raw input.',
  })
  description?: string | null;

  @Field(() => String, { nullable: true })
  note?: string | null;

  @Field(() => Date, { nullable: true, description: 'Falls back to the request-level instant.' })
  occurredAt?: Date | null;

  @Field(() => LocalDateScalar, {
    nullable: true,
    description:
      'The Household local day. Preferred over `occurredAt` (I-2): the server derives a stable ' +
      'instant, so a client never has to know the Household timezone.',
  })
  occurredOn?: string | null;

  @Field(() => [ID], { nullable: true })
  tagIds?: string[] | null;

  @Field(() => ID, {
    nullable: true,
    description: 'The `Proposal.id` this row came from — `classification_decisions.id`.',
  })
  acceptedProposalId?: string | null;

  @Field(() => Boolean, {
    defaultValue: false,
    description:
      'Required to write a row whose calibrated confidence is below 0.60 as CONFIRMED. It is the ' +
      'user’s explicit "yes, I mean it", which is the one thing I-8 allows to clear `needs_review`.',
  })
  confirmDespiteLowConfidence!: boolean;
}

@InputType({ description: 'The write half of the capture path (docs/06 §5.2). Atomic and idempotent.' })
export class CaptureCommitInput {
  @Field(() => ID, {
    nullable: true,
    description:
      'The `captureParse` preview these rows came from. When present, every `acceptedProposalId` ' +
      'must belong to it — a stale preview is refused rather than committed against a decision the ' +
      'user never saw.',
  })
  parseId?: string | null;

  @Field(() => [CaptureCommitRowInput], { description: '1..50 rows.' })
  rows!: CaptureCommitRowInput[];

  @Field(() => ID, { nullable: true, description: 'Used by rows that name no account.' })
  defaultAccountId?: string | null;

  @Field(() => Date, { nullable: true })
  occurredAt?: Date | null;

  @Field(() => LocalDateScalar, { nullable: true })
  occurredLocalDate?: string | null;

  @Field(() => [ID], {
    nullable: true,
    description:
      'Fragments the user removed from the preview. They produce no Transaction; their decisions are ' +
      'marked rejected, which is the negative half of the calibration label (docs/04 §6.4).',
  })
  discardProposalIds?: string[] | null;

  @Field(() => Boolean, {
    nullable: true,
    description: 'Request-level AI consent (docs/06 §5.1). Defaults to true.',
  })
  allowAi?: boolean | null;
}

@ObjectType({
  description:
    'One Transaction this commit wrote, with the audit decision behind its category (F-31).',
})
export class CommittedTransactionModel {
  @Field(() => String)
  clientRowId!: string;

  @Field(() => TransactionModel)
  transaction!: TransactionModel;

  @Field(() => String)
  idempotencyKey!: string;

  @Field(() => Boolean, {
    description:
      'True when the row already existed — this call returned the original instead of writing a ' +
      'second one (I-10). Never a silent duplicate.',
  })
  wasReplayed!: boolean;

  @Field(() => ClassificationDecisionModel, {
    nullable: true,
    description: 'The decision row linked to this Transaction. Null only if the link failed, which is a bug.',
  })
  classification!: ClassificationDecisionModel | null;
}

@ObjectType()
export class SkippedRowModel {
  @Field(() => String)
  clientRowId!: string;

  @Field(() => String)
  reason!: string;
}

@ObjectType()
export class RejectedRowModel {
  @Field(() => String)
  clientRowId!: string;

  @Field(() => CaptureRejectionCode)
  code!: CaptureRejectionCode;

  @Field(() => String)
  message!: string;

  @Field(() => String, { nullable: true, description: 'The input field at fault, when one is nameable.' })
  field!: string | null;
}

@ObjectType({
  description:
    'A just-written row that looks like a repeat of an existing Transaction (docs/06 §5.2.2). The ' +
    'advisory third mechanism: the row IS written, because the user may legitimately have bought the ' +
    'same thing twice. Blocking a real second purchase is a worse failure than showing an unwanted ' +
    'chip, so this never refuses anything — it only tells the client to offer an undo.',
})
export class DuplicateSuspectModel {
  @Field(() => String, { description: 'The row of THIS commit that looks like a repeat.' })
  clientRowId!: string;

  @Field(() => ID, { description: 'The Transaction just written — what an undo would remove.' })
  transactionId!: string;

  @Field(() => ID)
  existingTransactionId!: string;

  @Field(() => TransactionModel, { description: 'The earlier Transaction it resembles.' })
  existingTransaction!: TransactionModel;

  @Field(() => Float, {
    description:
      'Folded-description trigram similarity, `0..1`. Reported honestly even for a merchant match, ' +
      'where the two baskets may be nothing alike — that is the case worth a glance.',
  })
  similarity!: number;

  @Field(() => [String], {
    description:
      'Which rules matched: `amount`, `date`, and `merchant` and/or `description` ' +
      '(docs/06 §5.2.2). `amount` and `date` are always present — they are hard requirements.',
  })
  matchedOn!: string[];
}

@ObjectType({
  description:
    'Every row was written (or replayed). One low-confidence row never blocks the batch — it is ' +
    'stored PENDING and enters the review queue (docs/06 §5.2.1, F-06).',
})
export class CaptureCommitSuccessModel {
  @Field(() => [CommittedTransactionModel])
  committed!: CommittedTransactionModel[];

  @Field(() => [SkippedRowModel], {
    description:
      'Rows neither written nor replayed nor rejected. No producer yet: every row is one of the ' +
      'three, and the field is declared so a later task can introduce one without a schema change.',
  })
  skipped!: SkippedRowModel[];

  @Field(() => [DuplicateSuspectModel], {
    description:
      'Rows that look like a repeat of an existing Transaction (docs/06 §5.2.2). Empty means ' +
      '"checked and found none": the check always runs on a commit that wrote something.',
  })
  duplicateSuspects!: DuplicateSuspectModel[];

  @Field(() => Boolean, {
    description: 'True when the whole request was an idempotent replay — nothing new was written.',
  })
  replayed!: boolean;

  @Field(() => ID, {
    description:
      'The newest committed Transaction id, usable directly as the Transaction list’s `after` ' +
      'cursor on the next page fetch.',
  })
  cursor!: string;

  @Field(() => Int, {
    description: 'The BLOCKING review lane count after this commit (invariant I-8) — the nav badge.',
  })
  reviewQueueCount!: number;
}

@ObjectType({
  description:
    'Nothing was written. The whole `rows` array is validated before any of it is persisted, so a ' +
    'structurally invalid row rejects the request rather than half-applying it (docs/06 §5.2.1).',
})
export class CaptureCommitRejectedModel {
  @Field(() => [RejectedRowModel], { description: 'Every offending row, not just the first.' })
  rejected!: RejectedRowModel[];

  @Field(() => CaptureRejectionCode)
  code!: CaptureRejectionCode;

  @Field(() => String)
  message!: string;
}

/**
 * The two-way result. `resolveType` keys on `rejected` being present, which only the rejected arm
 * has — so the arms cannot be confused by a client and the resolver cannot return an ambiguous shape.
 */
export const CaptureCommitResult = createUnionType({
  name: 'CaptureCommitResult',
  description: 'Either every row was committed, or the request was refused as a whole.',
  types: () => [CaptureCommitSuccessModel, CaptureCommitRejectedModel] as const,
  resolveType: (value: object) =>
    'rejected' in value ? CaptureCommitRejectedModel : CaptureCommitSuccessModel,
});
