import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';

import { CurrentHouseholdId } from '../../common/auth/current-tenant.decorator';
import {
  CommitReceiptInput,
  CreateReceiptInput,
  ReceiptExtractionModel,
  ReceiptItemInput,
  ReceiptModel,
  ReconcileActionEnum,
  ReconcileReceiptInput,
  UpdateReceiptItemInput,
  toReceiptModel,
} from './receipt.model';
import { ReceiptsService } from './receipts.service';

/**
 * Receipts — F-14, docs/06 §5.9, task 4.1.3.
 *
 * Every operation takes `@CurrentHouseholdId()`, which fails closed without a `TenantContext`
 * (ADR-008): there is no `householdId` argument anywhere, so a client cannot name another Household's
 * receipt.
 *
 * The mutations return `ReceiptModel` **directly** rather than through docs/06's `ReceiptPayload` union
 * — the same deliberate deviation the repo has made four times now (docs/06 §5.5, §5.7, §5.13, §5.15):
 * the arms a payload union would declare are already the typed `ApiError` codes every other module
 * returns, and declaring union arms with no distinct producer is a contract that cannot be kept.
 *
 * @module apps/api/src/modules/receipts
 */
@Resolver(() => ReceiptModel)
export class ReceiptsResolver {
  constructor(private readonly receiptsService: ReceiptsService) {}

  @Query(() => [ReceiptModel], {
    description: 'The Household’s receipts, newest first, keyset-paged on the UUIDv7 id.',
  })
  async receipts(
    @CurrentHouseholdId() householdId: string,
    @Args('first', { type: () => Int, nullable: true }) first?: number | null,
    @Args('after', { type: () => String, nullable: true }) after?: string | null,
  ): Promise<ReceiptModel[]> {
    const page = await this.receiptsService.list(householdId, first ?? undefined, after ?? undefined);
    return page.items.map(toReceiptModel);
  }

  @Query(() => ReceiptModel, {
    nullable: true,
    description: 'One receipt with its items, or null when the id is not this Household’s.',
  })
  async receipt(
    @CurrentHouseholdId() householdId: string,
    @Args('id', { type: () => String }) id: string,
  ): Promise<ReceiptModel | null> {
    const view = await this.receiptsService.getById(householdId, id);
    return view === null ? null : toReceiptModel(view);
  }

  @Mutation(() => ReceiptModel, {
    description:
      'Open a Receipt over an uploaded Attachment (docs/09 4.1.2’s upload, this task’s subject). The ' +
      'total is optional: without one the receipt is PENDING rather than mismatched (I-6).',
  })
  async createReceipt(
    @CurrentHouseholdId() householdId: string,
    @Args('input', { type: () => CreateReceiptInput }) input: CreateReceiptInput,
  ): Promise<ReceiptModel> {
    const view = await this.receiptsService.create(householdId, {
      attachmentId: input.attachmentId,
      totalMinor: input.total === undefined || input.total === null ? null : BigInt(input.total.amountMinor),
      capturedAt: input.capturedAt ?? null,
      merchantId: input.merchantId ?? null,
    });
    return toReceiptModel(view);
  }

  @Mutation(() => ReceiptExtractionModel, {
    description:
      'Read the receipt image and write its lines as items, each categorised by the Household’s own ' +
      'rules. Writes nothing when no OCR provider is configured — the screen then offers manual ' +
      'itemisation instead of a spinner (docs/02 §4.11).',
  })
  async extractReceipt(
    @CurrentHouseholdId() householdId: string,
    @Args('receiptId', { type: () => String }) receiptId: string,
  ): Promise<ReceiptExtractionModel> {
    const result = await this.receiptsService.extract(householdId, receiptId);
    const model = new ReceiptExtractionModel();
    model.extracted = result.extracted;
    model.itemsWritten = result.itemsWritten;
    model.reason = result.reason;
    model.linesWithoutAmount = result.linesWithoutAmount;
    model.currencyMismatch = result.currencyMismatch;
    return model;
  }

  @Mutation(() => ReceiptModel, {
    description: 'Add a line by hand — manual itemisation, and the path when OCR is unavailable.',
  })
  async addReceiptItem(
    @CurrentHouseholdId() householdId: string,
    @Args('receiptId', { type: () => String }) receiptId: string,
    @Args('input', { type: () => ReceiptItemInput }) input: ReceiptItemInput,
  ): Promise<ReceiptModel> {
    const view = await this.receiptsService.addItem(householdId, receiptId, {
      rawText: input.rawText,
      amountMinor: BigInt(input.amount.amountMinor),
      quantity: input.quantity ?? null,
      unitPriceMinor:
        input.unitPrice === undefined || input.unitPrice === null
          ? null
          : BigInt(input.unitPrice.amountMinor),
      categoryId: input.categoryId ?? null,
    });
    return toReceiptModel(view);
  }

  @Mutation(() => ReceiptModel, {
    description:
      'Override one item’s text, amount or category. A category set by hand is recorded at confidence ' +
      '1 and clears `needsReview`: the user has answered the question the pipeline could not.',
  })
  async updateReceiptItem(
    @CurrentHouseholdId() householdId: string,
    @Args('input', { type: () => UpdateReceiptItemInput }) input: UpdateReceiptItemInput,
  ): Promise<ReceiptModel> {
    const view = await this.receiptsService.updateItem(householdId, {
      receiptItemId: input.receiptItemId,
      rawText: input.rawText ?? null,
      amountMinor:
        input.amount === undefined || input.amount === null ? null : BigInt(input.amount.amountMinor),
      quantity: input.quantity,
      categoryId: input.categoryId ?? null,
      clearCategory: input.clearCategory ?? null,
    });
    return toReceiptModel(view);
  }

  @Mutation(() => ReceiptModel, { description: 'Remove one line and recompute I-6.' })
  async removeReceiptItem(
    @CurrentHouseholdId() householdId: string,
    @Args('receiptItemId', { type: () => String }) receiptItemId: string,
  ): Promise<ReceiptModel> {
    return toReceiptModel(await this.receiptsService.removeItem(householdId, receiptItemId));
  }

  @Mutation(() => ReceiptModel, {
    description:
      'Turn a reconciled receipt into one CONFIRMED Transaction, with a Split per Category. Refused ' +
      'while the receipt does not reconcile (I-6) and while any line has no Category. Idempotent.',
  })
  async commitReceipt(
    @CurrentHouseholdId() householdId: string,
    @Args('input', { type: () => CommitReceiptInput }) input: CommitReceiptInput,
  ): Promise<ReceiptModel> {
    const view = await this.receiptsService.commit(householdId, input.receiptId, {
      accountId: input.accountId,
      description: input.description ?? null,
    });
    return toReceiptModel(view);
  }

  @Mutation(() => ReceiptModel, {
    description:
      'One of the answers to a mismatch. Returns the receipt with its recomputed reconciliation.',
  })
  async reconcileReceipt(
    @CurrentHouseholdId() householdId: string,
    @Args('input', { type: () => ReconcileReceiptInput }) input: ReconcileReceiptInput,
  ): Promise<ReceiptModel> {
    const view = await this.receiptsService.reconcile(householdId, {
      receiptId: input.receiptId,
      // The GraphQL enum's values are the service's string union; TS keeps the two nominally
      // distinct, and the cast is the boundary between the two layers rather than a loosening.
      action: input.action as ReconcileActionEnum,
      adjustmentItemId: input.adjustmentItemId ?? null,
      setMinor:
        input.amount === undefined || input.amount === null ? null : BigInt(input.amount.amountMinor),
      absorbCategoryId: input.absorbCategoryId ?? null,
    });
    return toReceiptModel(view);
  }
}
