import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import {
  receiptTotals,
  roundingLineAmount,
  uuidv7,
  type ReconciliationState,
} from '@finmate/domain';

import { CONFIG, type AppConfig } from '../../config/config';
import { ApiError } from '../../common/filters/all-exceptions.filter';
import type { CursorPage } from '../../graphql/pagination';
import { normalisePageSize } from '../../graphql/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { ClassificationService } from '../classification/classification.service';
import { FilesService } from '../files/files.service';
import { OCR, type OcrService } from './ocr';

/**
 * Receipts — F-14, docs/06 §5.9 and §9.5, docs/03 §4, task 4.1.3.
 *
 * ## The chain, and who owns each half
 *
 * ```text
 * attachment ──► OCR (seam) ──► lines ──► [validate] ──► receipt_items ──► [classify] ──► categories
 *                                                                             │
 *                                                            receipt total ───┴──► I-6 reconciliation
 * ```
 *
 * This service owns the orchestration and the rows. The arithmetic is `@finmate/domain`'s
 * (`receiptTotals`, `roundingLineAmount`); the model call is the {@link OcrService} seam; the item
 * categories come from the **same** `ClassificationService.parse` the capture path uses, so an item
 * and a typed fragment can never disagree about what a category means.
 *
 * ## OCR output is untrusted input
 *
 * docs/06 §9.5 is explicit: *"the webhook body is untrusted input"*. The same applies to a synchronous
 * provider result. Every amount is re-read as a **string** of minor units and rejected if it is not
 * (`Number`/`parseFloat` never appear — ADR-003), every category comes from the Household's own tree
 * through the classifier rather than from the model, and a currency that is not the ledger currency is
 * refused rather than converted. A compromised provider can put lines in front of a user; it cannot
 * write a number into the ledger — the transaction is created by 4.1.4, only once I-6 is satisfied.
 *
 * ## Extraction is idempotent per receipt
 *
 * A second `extract` replaces the receipt's items rather than appending: the OCR result is the whole
 * truth about the lines it read, and merging two runs would double every line. `line_no` is the
 * ordering key the DDL makes unique per receipt, so a replacement is a delete-then-insert inside one
 * transaction.
 *
 * @module apps/api/src/modules/receipts
 */

export interface ReceiptItemView {
  readonly id: string;
  readonly receiptId: string;
  readonly lineNo: number;
  readonly rawText: string;
  readonly normalizedName: string | null;
  readonly quantity: number | null;
  readonly unitPriceMinor: bigint | null;
  readonly amountMinor: bigint;
  readonly categoryId: string | null;
  readonly confidence: number | null;
  readonly needsReview: boolean;
}

export interface ReceiptView {
  readonly id: string;
  readonly transactionId: string | null;
  readonly merchantId: string | null;
  readonly capturedAt: Date;
  readonly totalMinor: bigint | null;
  /** The ledger currency when the receipt has none of its own (ADR-011). Never null on the wire. */
  readonly currency: string;
  readonly ocrConfidence: number | null;
  readonly reconciliation: ReconciliationState;
  /** Σ items, computed on read (docs/03 §6: a derived value, never stored). */
  readonly itemsTotalMinor: bigint;
  /** `total − itemsTotal`, signed. */
  readonly varianceMinor: bigint;
  readonly attachmentId: string | null;
  readonly items: readonly ReceiptItemView[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ExtractionResult {
  readonly extracted: boolean;
  readonly itemsWritten: number;
  /** Why nothing was written, in the seam's machine-readable form. */
  readonly reason: string | null;
  /** Lines whose amount could not be read, so they are not items. */
  readonly linesWithoutAmount: number;
  /** True when the provider's currency was not the ledger currency; its total was ignored. */
  readonly currencyMismatch: boolean;
}

export interface CreateReceiptInput {
  readonly attachmentId: string;
  readonly totalMinor?: bigint | null;
  readonly capturedAt?: Date | null;
  readonly merchantId?: string | null;
}

export interface ReceiptItemInput {
  readonly rawText: string;
  readonly amountMinor: bigint;
  readonly quantity?: number | null;
  readonly unitPriceMinor?: bigint | null;
  readonly categoryId?: string | null;
}

export interface UpdateReceiptItemInput {
  readonly receiptItemId: string;
  readonly rawText?: string | null;
  readonly amountMinor?: bigint | null;
  readonly quantity?: number | null;
  readonly categoryId?: string | null;
  readonly clearCategory?: boolean | null;
}

export interface ReconcileInput {
  readonly receiptId: string;
  readonly action: 'ACCEPT_MATCH' | 'ADJUST_ITEM' | 'ADJUST_TOTAL' | 'ADD_ROUNDING_LINE';
  readonly adjustmentItemId?: string | null;
  /** The new **absolute** amount for ADJUST_ITEM / ADJUST_TOTAL (never a signed delta; see the model). */
  readonly setMinor?: bigint | null;
  readonly absorbCategoryId?: string | null;
}

interface ReceiptRow {
  readonly id: string;
  readonly household_id: string;
  readonly transaction_id: string | null;
  readonly merchant_id: string | null;
  readonly captured_at: Date;
  readonly total_minor: bigint | null;
  readonly currency: string | null;
  readonly ocr_confidence: unknown;
  readonly reconciliation: string;
  readonly attachment_id: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface ItemRow {
  readonly id: string;
  readonly receipt_id: string;
  readonly line_no: number;
  readonly raw_text: string;
  readonly normalized_name: string | null;
  readonly quantity: unknown;
  readonly unit_price_minor: bigint | null;
  readonly amount_minor: bigint;
  readonly category_id: string | null;
  readonly confidence: unknown;
  readonly needs_review: boolean;
}

/**
 * I-6 over a page of rows.
 *
 * The domain takes `{amountMinor}` and the row carries `amount_minor`; the translation lives here so
 * the pure module never learns a database column name.
 */
function totalsOf(
  items: readonly ItemRow[],
  totalMinor: bigint | null,
  manual: boolean,
): ReturnType<typeof receiptTotals> {
  return receiptTotals(
    items.map((item) => ({ amountMinor: item.amount_minor })),
    totalMinor,
    { manual },
  );
}

/** A string of minor units, or `null`. The only parse the money path allows (ADR-003). */
function minorFrom(value: string | null | undefined): bigint | null {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return null;
  return BigInt(value);
}

@Injectable()
export class ReceiptsService {
  private readonly logger = new Logger(ReceiptsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly classification: ClassificationService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(OCR) private readonly ocr: OcrService | null = null,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------------------------

  async list(
    householdId: string,
    first?: number,
    after?: string,
  ): Promise<CursorPage<ReceiptView>> {
    const take = normalisePageSize(first);
    const where = {
      household_id: householdId,
      deleted_at: null,
      ...(after !== undefined ? { id: { lt: after } } : {}),
    };
    const [rows, totalCount] = await Promise.all([
      this.prisma.client.receipts.findMany({ where, orderBy: { id: 'desc' }, take: take + 1 }),
      this.prisma.client.receipts.count({ where }),
    ]);
    const hasNextPage = rows.length > take;
    const page = hasNextPage ? rows.slice(0, take) : rows;

    // One query for every page row's items, not one per row: a list of receipts is exactly the shape
    // that turns an N+1 into a slow screen.
    const itemRows =
      page.length === 0
        ? []
        : await this.prisma.client.receipt_items.findMany({
            where: { household_id: householdId, receipt_id: { in: page.map((row) => row.id) } },
            orderBy: { line_no: 'asc' },
          });
    const itemsByReceipt = new Map<string, ItemRow[]>();
    for (const item of itemRows) {
      const bucket = itemsByReceipt.get(item.receipt_id) ?? [];
      bucket.push(item);
      itemsByReceipt.set(item.receipt_id, bucket);
    }

    const currency = await this.ledgerCurrency(householdId);
    return {
      items: page.map((row) => this.viewWith(row, itemsByReceipt.get(row.id) ?? [], currency)),
      totalCount,
      hasNextPage,
      endCursor: hasNextPage ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /** One receipt, or `null` — the scoped predicate is the tenancy check (ADR-008). */
  async getById(householdId: string, id: string): Promise<ReceiptView | null> {
    const row = await this.prisma.client.receipts.findFirst({
      where: { id, household_id: householdId, deleted_at: null },
    });
    if (row === null) return null;
    return this.toView(row, await this.ledgerCurrency(householdId));
  }

  // -------------------------------------------------------------------------------------------
  // Creating and extracting
  // -------------------------------------------------------------------------------------------

  /**
   * A Receipt over an uploaded Attachment.
   *
   * The attachment must be a `RECEIPT` purpose and already linkable (`CLEAN`/`SKIPPED`) — the same
   * guard `commitAttachment` applies, because a `PENDING` or quarantined object must not become receipt
   * data. The total is optional: docs/02 §4.11 lets the user type one, and without one the receipt is
   * `PENDING` rather than mismatched.
   */
  async create(householdId: string, input: CreateReceiptInput): Promise<ReceiptView> {
    const attachment = await this.files.getById(householdId, input.attachmentId);
    if (attachment === null) throw new ApiError('NOT_FOUND', 'Attachment not found.');
    if (attachment.purpose !== 'RECEIPT') {
      throw new ApiError(
        'VALIDATION_FAILED',
        `That attachment's purpose is ${attachment.purpose}, not RECEIPT.`,
      );
    }
    if (attachment.downloadUrl === null && attachment.scanState === 'PENDING') {
      throw new ApiError('VALIDATION_FAILED', 'That attachment has not been scanned yet.');
    }
    if (attachment.scanState === 'FAILED' || attachment.scanState === 'INFECTED') {
      throw new ApiError('VALIDATION_FAILED', `That attachment is ${attachment.scanState}.`);
    }

    if (input.merchantId !== undefined && input.merchantId !== null) {
      const merchant = await this.prisma.client.merchants.findFirst({
        where: { id: input.merchantId },
        select: { id: true },
      });
      if (merchant === null) throw new ApiError('NOT_FOUND', 'Merchant not found.');
    }

    const currency = await this.ledgerCurrency(householdId);
    const totals = receiptTotals([], input.totalMinor ?? null);
    const row = await this.prisma.client.receipts.create({
      data: {
        id: uuidv7(),
        household_id: householdId,
        attachment_id: input.attachmentId,
        merchant_id: input.merchantId ?? null,
        captured_at: input.capturedAt ?? new Date(),
        total_minor: input.totalMinor ?? null,
        currency: input.totalMinor === null || input.totalMinor === undefined ? null : currency,
        reconciliation: totals.state,
      },
    });
    return this.toView(row, currency);
  }

  /**
   * Run OCR and write the lines as items, classifying each one.
   *
   * Returns `{extracted: false, reason}` when the seam is unavailable or the provider failed — **no
   * mutation at all**, so a receipt that could not be read stays exactly as the user left it and the
   * screen can offer manual itemisation (docs/02 §4.11).
   */
  async extract(householdId: string, receiptId: string): Promise<ExtractionResult> {
    const receipt = await this.requireReceipt(householdId, receiptId);
    if (receipt.attachment_id === null) {
      throw new ApiError('VALIDATION_FAILED', 'That receipt has no attachment to read.');
    }

    const ocr = this.ocr;
    if (ocr === null || !ocr.available) {
      // The reason a client branches on is a **code**, and the readable sentence is logged rather than
      // returned: a UI that matched on prose would break the first time the sentence was reworded.
      if (ocr?.unavailableReason != null) this.logger.log(`Receipt extraction skipped: ${ocr.unavailableReason}`);
      return {
        extracted: false,
        itemsWritten: 0,
        reason: 'AI_UNAVAILABLE:no-provider-configured',
        linesWithoutAmount: 0,
        currencyMismatch: false,
      };
    }

    const { bytes, mimeType } = await this.files.readBytes(householdId, receipt.attachment_id);
    const outcome = await ocr.read({
      imageBase64: Buffer.from(bytes).toString('base64'),
      mimeType,
      locale: this.config.APP_DEFAULT_LOCALE,
    });
    if (!outcome.ok) {
      return {
        extracted: false,
        itemsWritten: 0,
        reason: outcome.reason,
        linesWithoutAmount: 0,
        currencyMismatch: false,
      };
    }

    const currency = await this.ledgerCurrency(householdId);
    const providerCurrency = outcome.result.currency;
    // ADR-011: one ledger currency. A provider that read another one is not converted — its total is
    // simply not trusted, and the user can type the real one. The items themselves are still useful.
    const currencyMismatch = providerCurrency !== null && providerCurrency !== currency;
    const providerTotal = currencyMismatch ? null : minorFrom(outcome.result.totalMinor);

    let linesWithoutAmount = 0;
    const items: { rawText: string; amountMinor: bigint }[] = [];
    for (const line of outcome.result.lines) {
      const amountMinor = minorFrom(line.amountMinor);
      if (amountMinor === null || amountMinor < 0n) {
        // A line whose amount was not read is not an item: guessing 0 would understate the receipt and
        // inventing the difference is exactly what I-6 exists to catch. It is reported instead.
        linesWithoutAmount += 1;
        continue;
      }
      items.push({ rawText: line.text, amountMinor });
    }

    const classified = await Promise.all(
      items.map(async (item) => ({
        ...item,
        category: await this.classifyItem(householdId, item.rawText),
      })),
    );

    // A fresh read wins when the provider produced a total, and an existing total is kept when it did
    // not. The asymmetry is deliberate: `extract` is an explicit retry, and a retry that kept a stale
    // total would make a corrected run unable to fix it. What the provider could **not** read is never
    // used to erase a total the user asserted — that stays until `ADJUST_TOTAL` or a better read.
    const totalMinor = currencyMismatch ? null : (providerTotal ?? receipt.total_minor);
    const totals = receiptTotals(classified, totalMinor, {
      manual: receipt.reconciliation === 'MANUAL',
    });

    await this.prisma.client.$transaction(async (tx) => {
      await tx.receipt_items.deleteMany({ where: { receipt_id: receipt.id, household_id: householdId } });
      if (classified.length > 0) {
        await tx.receipt_items.createMany({
          data: classified.map((item, index) => ({
            id: uuidv7(),
            household_id: householdId,
            receipt_id: receipt.id,
            line_no: index + 1,
            raw_text: item.rawText,
            amount_minor: item.amountMinor,
            category_id: item.category.categoryId,
            confidence: item.category.confidence,
            needs_review: item.category.needsReview,
          })),
        });
      }
      await tx.receipts.updateMany({
        where: { id: receipt.id, household_id: householdId },
        data: {
          total_minor: totalMinor,
          currency: totalMinor === null ? null : currency,
          ocr_confidence: outcome.result.confidence,
          reconciliation: totals.state,
          updated_at: new Date(),
        },
      });
    });

    this.logger.log(
      `Receipt ${receipt.id}: ${classified.length} items from ${outcome.provider}, ` +
        `${linesWithoutAmount} lines without an amount`,
    );

    return {
      extracted: true,
      itemsWritten: classified.length,
      reason: null,
      linesWithoutAmount,
      currencyMismatch,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Items and reconciliation
  // -------------------------------------------------------------------------------------------

  /** Manual itemisation and per-item override — docs/06 §5.9's `UpdateReceiptItemInput`. */
  async addItem(householdId: string, receiptId: string, input: ReceiptItemInput): Promise<ReceiptView> {
    const receipt = await this.requireReceipt(householdId, receiptId);
    const rawText = input.rawText.trim();
    if (rawText.length === 0) throw new ApiError('VALIDATION_FAILED', 'An item needs text.');
    if (input.amountMinor < 0n) {
      throw new ApiError('VALIDATION_FAILED', 'An item amount cannot be negative (docs/03 §4).');
    }
    if (input.categoryId !== undefined && input.categoryId !== null) {
      await this.assertCategory(householdId, input.categoryId);
    }

    const last = await this.prisma.client.receipt_items.findFirst({
      where: { receipt_id: receipt.id, household_id: householdId },
      orderBy: { line_no: 'desc' },
      select: { line_no: true },
    });

    await this.prisma.client.receipt_items.create({
      data: {
        id: uuidv7(),
        household_id: householdId,
        receipt_id: receipt.id,
        line_no: (last?.line_no ?? 0) + 1,
        raw_text: rawText,
        amount_minor: input.amountMinor,
        quantity: input.quantity ?? null,
        unit_price_minor: input.unitPriceMinor ?? null,
        category_id: input.categoryId ?? null,
        // A line the user typed without a category is a question, not an answer: `commitReceipt` turns
        // each item into a Split, and a Split without a Category is I-8's blocking lane. Confidence 1
        // when they did choose one — that is a user decision, not a model's guess.
        confidence: input.categoryId === undefined || input.categoryId === null ? null : 1,
        needs_review: input.categoryId === undefined || input.categoryId === null,
      },
    });

    await this.recompute(householdId, receipt.id);
    return (await this.getById(householdId, receipt.id)) as ReceiptView;
  }

  async updateItem(
    householdId: string,
    input: UpdateReceiptItemInput,
  ): Promise<ReceiptView> {
    const item = await this.prisma.client.receipt_items.findFirst({
      where: { id: input.receiptItemId, household_id: householdId },
      select: { id: true, receipt_id: true },
    });
    if (item === null) throw new ApiError('NOT_FOUND', 'Receipt item not found.');

    if (input.amountMinor !== undefined && input.amountMinor !== null && input.amountMinor < 0n) {
      throw new ApiError('VALIDATION_FAILED', 'An item amount cannot be negative (docs/03 §4).');
    }
    if (input.categoryId !== undefined && input.categoryId !== null) {
      await this.assertCategory(householdId, input.categoryId);
    }

    await this.prisma.client.receipt_items.updateMany({
      where: { id: item.id, household_id: householdId },
      data: {
        ...(input.rawText === undefined || input.rawText === null ? {} : { raw_text: input.rawText.trim() }),
        ...(input.amountMinor === undefined || input.amountMinor === null
          ? {}
          : { amount_minor: input.amountMinor }),
        ...(input.quantity === undefined ? {} : { quantity: input.quantity }),
        ...(input.clearCategory === true ? { category_id: null } : {}),
        ...(input.categoryId === undefined || input.categoryId === null
          ? {}
          : { category_id: input.categoryId, confidence: 1, needs_review: false }),
      },
    });

    await this.recompute(householdId, item.receipt_id);
    return (await this.getById(householdId, item.receipt_id)) as ReceiptView;
  }

  async removeItem(householdId: string, receiptItemId: string): Promise<ReceiptView> {
    const item = await this.prisma.client.receipt_items.findFirst({
      where: { id: receiptItemId, household_id: householdId },
      select: { id: true, receipt_id: true },
    });
    if (item === null) throw new ApiError('NOT_FOUND', 'Receipt item not found.');
    await this.prisma.client.receipt_items.deleteMany({
      where: { id: item.id, household_id: householdId },
    });
    await this.recompute(householdId, item.receipt_id);
    return (await this.getById(householdId, item.receipt_id)) as ReceiptView;
  }

  /**
   * The four answers to a mismatch — docs/06 §5.9.
   *
   * `ADD_ROUNDING_LINE` adds one line for the **positive** gap and marks the receipt `MANUAL`: the
   * figures now agree, but because the user added the line, not because the receipt said so. A negative
   * gap has no legal line (see `roundingLineAmount`), so that arm is refused with the reason rather
   * than a negative amount that the `receipt_items` CHECK would reject anyway.
   */
  async reconcile(householdId: string, input: ReconcileInput): Promise<ReceiptView> {
    const receipt = await this.requireReceipt(householdId, input.receiptId);
    const current = await this.totalsFor(householdId, receipt);

    switch (input.action) {
      case 'ACCEPT_MATCH': {
        if (current.state === 'PENDING') {
          throw new ApiError('VALIDATION_FAILED', 'There is no total to accept yet.');
        }
        if (current.state === 'MISMATCH') {
          throw new ApiError(
            'VALIDATION_FAILED',
            `The items and the total differ by ${current.varianceMinor.toString()} minor units.`,
          );
        }
        // Already reconciled — idempotent, because a retried confirm is not an error.
        return (await this.getById(householdId, receipt.id)) as ReceiptView;
      }

      case 'ADJUST_ITEM': {
        if (input.adjustmentItemId === undefined || input.adjustmentItemId === null) {
          throw new ApiError('VALIDATION_FAILED', 'ADJUST_ITEM needs an item.');
        }
        const next = input.setMinor ?? null;
        if (next === null) throw new ApiError('VALIDATION_FAILED', 'ADJUST_ITEM needs an amount.');
        if (next < 0n) {
          throw new ApiError('VALIDATION_FAILED', 'An item amount cannot be negative (docs/03 §4).');
        }
        const item = await this.prisma.client.receipt_items.findFirst({
          where: { id: input.adjustmentItemId, receipt_id: receipt.id, household_id: householdId },
          select: { id: true },
        });
        if (item === null) throw new ApiError('NOT_FOUND', 'Receipt item not found.');
        await this.prisma.client.receipt_items.updateMany({
          where: { id: item.id, household_id: householdId },
          data: { amount_minor: next },
        });
        break;
      }

      case 'ADJUST_TOTAL': {
        const next = input.setMinor ?? null;
        if (next === null) throw new ApiError('VALIDATION_FAILED', 'ADJUST_TOTAL needs an amount.');
        if (next < 0n) throw new ApiError('VALIDATION_FAILED', 'A receipt total cannot be negative.');
        await this.prisma.client.receipts.updateMany({
          where: { id: receipt.id, household_id: householdId },
          data: { total_minor: next, currency: await this.ledgerCurrency(householdId) },
        });
        break;
      }

      case 'ADD_ROUNDING_LINE': {
        const amount = roundingLineAmount(current.varianceMinor);
        if (amount === null) {
          throw new ApiError(
            'VALIDATION_FAILED',
            current.varianceMinor === 0n
              ? 'Nothing to absorb: the items already match the total.'
              : 'The items are above the total, and a receipt line cannot be negative (docs/03 §4). ' +
                'Adjust an item or the total instead.',
          );
        }
        if (input.absorbCategoryId !== undefined && input.absorbCategoryId !== null) {
          await this.assertCategory(householdId, input.absorbCategoryId);
        }
        const last = await this.prisma.client.receipt_items.findFirst({
          where: { receipt_id: receipt.id, household_id: householdId },
          orderBy: { line_no: 'desc' },
          select: { line_no: true },
        });
        await this.prisma.client.receipt_items.create({
          data: {
            id: uuidv7(),
            household_id: householdId,
            receipt_id: receipt.id,
            line_no: (last?.line_no ?? 0) + 1,
            raw_text: 'Rounding',
            amount_minor: amount,
            category_id: input.absorbCategoryId ?? null,
            confidence: 1,
            needs_review: false,
          },
        });
        break;
      }

      default: {
        // `DETACH_TRANSACTION` is 4.1.4's arm, and a switch that silently ignored an unknown action
        // would answer "done" to a request it did not perform.
        throw new ApiError('VALIDATION_FAILED', `Unsupported reconciliation action "${input.action}".`);
      }
    }

    const manual = input.action === 'ADD_ROUNDING_LINE';
    await this.recompute(householdId, receipt.id, manual);
    return (await this.getById(householdId, receipt.id)) as ReceiptView;
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  private async requireReceipt(householdId: string, id: string): Promise<ReceiptRow> {
    const row = await this.prisma.client.receipts.findFirst({
      where: { id, household_id: householdId, deleted_at: null },
    });
    if (row === null) throw new ApiError('NOT_FOUND', 'Receipt not found.');
    return row;
  }

  private async itemsFor(householdId: string, receiptId: string): Promise<readonly ItemRow[]> {
    return this.prisma.client.receipt_items.findMany({
      where: { receipt_id: receiptId, household_id: householdId },
      orderBy: { line_no: 'asc' },
    });
  }

  private async totalsFor(
    householdId: string,
    receipt: ReceiptRow,
  ): Promise<ReturnType<typeof receiptTotals>> {
    const items = await this.itemsFor(householdId, receipt.id);
    return totalsOf(items, receipt.total_minor, receipt.reconciliation === 'MANUAL');
  }

  /** Recompute I-6 and persist it. Called after every mutation that can move either side. */
  private async recompute(householdId: string, receiptId: string, manual = false): Promise<void> {
    const receipt = await this.requireReceipt(householdId, receiptId);
    const items = await this.itemsFor(householdId, receiptId);
    const totals = totalsOf(items, receipt.total_minor, manual || receipt.reconciliation === 'MANUAL');
    await this.prisma.client.receipts.updateMany({
      where: { id: receiptId, household_id: householdId },
      data: { reconciliation: totals.state, updated_at: new Date() },
    });
  }

  /**
   * One item's category, through the **capture pipeline** with AI disabled.
   *
   * Rules and keywords only: an item line is short, the same rules that decide a typed fragment decide
   * it, and sending a receipt's every line to a model would be the most expensive and least private
   * way to answer a question the Household's own keywords already answer (ADR-002). The parse writes a
   * `classification_decisions` row per item, so an item's category is auditable exactly like a typed
   * one.
   */
  private async classifyItem(
    householdId: string,
    rawText: string,
  ): Promise<{ categoryId: string | null; confidence: number; needsReview: boolean }> {
    try {
      const parsed = await this.classification.parse(householdId, { text: rawText, allowAi: false });
      const fragment = parsed.fragments[0];
      if (fragment === undefined) return { categoryId: null, confidence: 0, needsReview: true };
      return {
        categoryId: fragment.categoryId,
        confidence: fragment.confidence,
        // The blocking lane is I-8's, and an item with no category is exactly what it is for.
        needsReview: fragment.categoryId === null || fragment.needsReview,
      };
    } catch (error) {
      // A line the parser cannot read is still a line the user must see; it simply arrives uncategorised.
      this.logger.warn(
        `Item classification failed for "${rawText}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return { categoryId: null, confidence: 0, needsReview: true };
    }
  }

  private async assertCategory(householdId: string, categoryId: string): Promise<void> {
    const category = await this.prisma.client.categories.findFirst({
      where: { id: categoryId, household_id: householdId, deleted_at: null },
      select: { kind: true },
    });
    if (category === null) throw new ApiError('NOT_FOUND', 'Category not found.');
    if (category.kind !== 'EXPENSE') {
      // A receipt is spending; I-3's kind check applies to the items that will become Splits.
      throw new ApiError('VALIDATION_FAILED', 'A receipt item must be an EXPENSE category (I-3).');
    }
  }

  private async ledgerCurrency(householdId: string): Promise<string> {
    const household = await this.prisma.client.households.findFirst({
      where: { id: householdId },
      select: { ledger_currency: true },
    });
    return household?.ledger_currency ?? 'RSD';
  }

  private async toView(row: ReceiptRow, currency: string): Promise<ReceiptView> {
    return this.viewWith(row, await this.itemsFor(row.household_id, row.id), currency);
  }

  private viewWith(row: ReceiptRow, items: readonly ItemRow[], currency: string): ReceiptView {
    const totals = totalsOf(items, row.total_minor, row.reconciliation === 'MANUAL');
    return {
      id: row.id,
      transactionId: row.transaction_id,
      merchantId: row.merchant_id,
      capturedAt: row.captured_at,
      totalMinor: row.total_minor,
      // The ledger currency when the receipt has no total of its own, so a client never has to invent
      // one to render `itemsTotal` (ADR-011).
      currency: row.currency ?? currency,
      ocrConfidence: row.ocr_confidence === null ? null : Number(row.ocr_confidence),
      reconciliation: row.reconciliation as ReconciliationState,
      itemsTotalMinor: totals.itemsTotalMinor,
      varianceMinor: totals.varianceMinor,
      attachmentId: row.attachment_id,
      items: items.map((item) => this.toItemView(item)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toItemView(row: ItemRow): ReceiptItemView {
    return {
      id: row.id,
      receiptId: row.receipt_id,
      lineNo: row.line_no,
      rawText: row.raw_text,
      normalizedName: row.normalized_name,
      quantity: row.quantity === null ? null : Number(row.quantity),
      unitPriceMinor: row.unit_price_minor,
      amountMinor: row.amount_minor,
      categoryId: row.category_id,
      confidence: row.confidence === null ? null : Number(row.confidence),
      needsReview: row.needs_review,
    };
  }
}
