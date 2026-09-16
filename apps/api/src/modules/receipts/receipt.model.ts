import { Field, Float, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

import { balance, money, type Balance, type Money, type ReconciliationState } from '@finmate/domain';

import { BalanceScalar } from '../../graphql/scalars/balance.scalar';
import { MoneyScalar } from '../../graphql/scalars/money.scalar';
import { UuidScalar } from '../../graphql/scalars/uuid.scalar';
import type { ReceiptItemView, ReceiptView } from './receipts.service';

/**
 * Receipts over GraphQL — F-14, docs/06 §5.9, task 4.1.3.
 *
 * ## `variance` is a `Balance`, not `Money`
 *
 * docs/06's sketch types it `Money!`, and that cannot be right: the variance is **signed** — the items
 * can overshoot the total — and `Money` is non-negative by ADR-003 (`money()` throws on a negative
 * amount). `Balance` is the scalar this repo already added for exactly this distinction, after a
 * negative verdict took the Accounts screen down. `total` and `itemsTotal` stay `Money`.
 *
 * ## `commitReceipt` is split
 *
 * docs/06 §5.9 puts the attachment, the items and the Transaction creation in one `commitReceipt`.
 * This build exposes `createReceipt` (attachment → receipt), `extractReceipt` (OCR → items),
 * `reconcileReceipt` and the per-item mutations, and leaves the **Transaction creation** to 4.1.4/4.1.5,
 * where the itemised screen and the *Napravi transakciju* button live. Recorded in §5.9.
 *
 * @module apps/api/src/modules/receipts
 */

/** Mirrors `receipts.reconciliation` (docs/03 §4). */
export enum ReconciliationStateEnum {
  PENDING = 'PENDING',
  MATCHED = 'MATCHED',
  MISMATCH = 'MISMATCH',
  MANUAL = 'MANUAL',
}

registerEnumType(ReconciliationStateEnum, {
  name: 'ReconciliationState',
  description:
    'I-6: `MATCHED` only when the items sum to the total within one minor unit. `MANUAL` means the ' +
    'agreement came from a hand-added line, not from the receipt itself.',
});

export enum ReconcileActionEnum {
  ACCEPT_MATCH = 'ACCEPT_MATCH',
  ADJUST_ITEM = 'ADJUST_ITEM',
  ADJUST_TOTAL = 'ADJUST_TOTAL',
  ADD_ROUNDING_LINE = 'ADD_ROUNDING_LINE',
  DETACH_TRANSACTION = 'DETACH_TRANSACTION',
}

registerEnumType(ReconcileActionEnum, {
  name: 'ReconcileAction',
  description:
    'The ways out of a mismatch. `DETACH_TRANSACTION` unlinks a Receipt from its Transaction without ' +
    'deleting the Transaction — a confirmed row of the Household’s money is not removed because a ' +
    'photo was detached.',
});

@ObjectType()
export class ReceiptItemModel {
  @Field(() => UuidScalar)
  id!: string;

  @Field(() => UuidScalar)
  receiptId!: string;

  @Field(() => Int)
  lineNo!: number;

  @Field(() => String)
  rawText!: string;

  @Field(() => String, { nullable: true })
  normalizedName!: string | null;

  @Field(() => Float, { nullable: true })
  quantity!: number | null;

  @Field(() => MoneyScalar, { nullable: true })
  unitPrice!: Money | null;

  @Field(() => MoneyScalar)
  amount!: Money;

  @Field(() => UuidScalar, { nullable: true })
  categoryId!: string | null;

  @Field(() => Float, { nullable: true })
  confidence!: number | null;

  @Field(() => Boolean)
  needsReview!: boolean;
}

@ObjectType()
export class ReceiptModel {
  @Field(() => UuidScalar)
  id!: string;

  @Field(() => UuidScalar, { nullable: true })
  transactionId!: string | null;

  @Field(() => UuidScalar, { nullable: true })
  merchantId!: string | null;

  @Field(() => Date)
  capturedAt!: Date;

  @Field(() => MoneyScalar, { nullable: true })
  total!: Money | null;

  @Field(() => Float, { nullable: true })
  ocrConfidence!: number | null;

  @Field(() => ReconciliationStateEnum)
  reconciliation!: ReconciliationStateEnum;

  @Field(() => MoneyScalar, { description: 'Σ items, computed on read (docs/03 §6).' })
  itemsTotal!: Money;

  @Field(() => BalanceScalar, {
    description: '`total − itemsTotal`, SIGNED. Within one minor unit when `MATCHED` (I-6).',
  })
  variance!: Balance;

  @Field(() => UuidScalar, { nullable: true })
  attachmentId!: string | null;

  @Field(() => [ReceiptItemModel])
  items!: ReceiptItemModel[];

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;
}

@ObjectType()
export class ReceiptExtractionModel {
  @Field(() => Boolean)
  extracted!: boolean;

  @Field(() => Int)
  itemsWritten!: number;

  @Field(() => String, {
    nullable: true,
    description: 'Why nothing was written — `AI_UNAVAILABLE:…` or `AI_ERROR:…`.',
  })
  reason!: string | null;

  @Field(() => Int, {
    description: 'Lines whose amount could not be read. They are not items, and they are not guessed.',
  })
  linesWithoutAmount!: number;

  @Field(() => Boolean)
  currencyMismatch!: boolean;
}

@InputType()
export class CreateReceiptInput {
  @Field(() => UuidScalar)
  attachmentId!: string;

  @Field(() => MoneyScalar, { nullable: true })
  total?: Money | null;

  @Field(() => Date, { nullable: true, description: 'When the receipt was photographed.' })
  capturedAt?: Date | null;

  @Field(() => UuidScalar, { nullable: true })
  merchantId?: string | null;
}

@InputType()
export class ReceiptItemInput {
  @Field(() => String)
  rawText!: string;

  @Field(() => MoneyScalar)
  amount!: Money;

  @Field(() => Float, { nullable: true })
  quantity?: number | null;

  @Field(() => MoneyScalar, { nullable: true })
  unitPrice?: Money | null;

  @Field(() => UuidScalar, { nullable: true })
  categoryId?: string | null;
}

@InputType()
export class UpdateReceiptItemInput {
  @Field(() => UuidScalar)
  receiptItemId!: string;

  @Field(() => String, { nullable: true })
  rawText?: string | null;

  @Field(() => MoneyScalar, { nullable: true })
  amount?: Money | null;

  @Field(() => Float, { nullable: true })
  quantity?: number | null;

  @Field(() => UuidScalar, { nullable: true })
  categoryId?: string | null;

  @Field(() => Boolean, { nullable: true })
  clearCategory?: boolean | null;
}

@InputType()
export class CommitReceiptInput {
  @Field(() => UuidScalar)
  receiptId!: string;

  @Field(() => UuidScalar, { description: 'The Account the receipt was paid from.' })
  accountId!: string;

  @Field(() => String, {
    nullable: true,
    description: 'Overrides the description derived from the Merchant, or from the receipt itself.',
  })
  description?: string | null;
}

@InputType()
export class ReconcileReceiptInput {
  @Field(() => UuidScalar)
  receiptId!: string;

  @Field(() => ReconcileActionEnum)
  action!: ReconcileActionEnum;

  @Field(() => UuidScalar, { nullable: true })
  adjustmentItemId?: string | null;

  @Field(() => MoneyScalar, {
    nullable: true,
    description:
      'The new **absolute** amount for ADJUST_ITEM / ADJUST_TOTAL. Deliberately not a delta: `Money` ' +
      'is non-negative (ADR-003), so a delta could never express a decrease — §5.9 sketched one and ' +
      'that was a defect, recorded in the implementation notes.',
  })
  amount?: Money | null;

  @Field(() => UuidScalar, { nullable: true })
  absorbCategoryId?: string | null;
}

export function toReceiptItemModel(view: ReceiptItemView, currency: string): ReceiptItemModel {
  const model = new ReceiptItemModel();
  model.id = view.id;
  model.receiptId = view.receiptId;
  model.lineNo = view.lineNo;
  model.rawText = view.rawText;
  model.normalizedName = view.normalizedName;
  model.quantity = view.quantity;
  model.unitPrice = view.unitPriceMinor === null ? null : money(view.unitPriceMinor, currency);
  model.amount = money(view.amountMinor, currency);
  model.categoryId = view.categoryId;
  model.confidence = view.confidence;
  model.needsReview = view.needsReview;
  return model;
}

export function toReceiptModel(view: ReceiptView): ReceiptModel {
  // The service reports the **ledger** currency when the receipt has none of its own (ADR-011), so the
  // `Money`/`Balance` fields always have an honest one and there is no hardcoded fallback.
  const currency = view.currency;
  const model = new ReceiptModel();
  model.id = view.id;
  model.transactionId = view.transactionId;
  model.merchantId = view.merchantId;
  model.capturedAt = view.capturedAt;
  model.total = view.totalMinor === null ? null : money(view.totalMinor, currency);
  model.ocrConfidence = view.ocrConfidence;
  model.reconciliation = view.reconciliation as ReconciliationStateEnum;
  model.itemsTotal = money(view.itemsTotalMinor, currency);
  model.variance = balance(view.varianceMinor, currency);
  model.attachmentId = view.attachmentId;
  model.items = view.items.map((item) => toReceiptItemModel(item, currency));
  model.createdAt = view.createdAt;
  model.updatedAt = view.updatedAt;
  return model;
}

/** Re-exported so a resolver can name the state without reaching into the domain package. */
export type { ReconciliationState };
