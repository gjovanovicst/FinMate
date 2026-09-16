import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { AiModule } from '../ai/ai.module';
import { ClassificationModule } from '../classification/classification.module';
import { FilesModule } from '../files/files.module';
import { LedgerModule } from '../ledger/ledger.module';
import { ReceiptsResolver } from './receipts.resolver';
import { ReceiptsService } from './receipts.service';

/**
 * Receipts (F-14) — docs/05 §3's `receipts` module, task 4.1.3.
 *
 * It owns `receipts` and `receipt_items`, and it **composes** rather than reimplements:
 *
 * - `FilesModule` supplies the attachment's bytes (`readBytes`) and the linkable-state guard, so this
 *   module never signs a URL or touches the bucket;
 * - `ClassificationModule` supplies `ClassificationService.parse`, the **same** pipeline a typed
 *   fragment goes through, so an item's category and a Transaction's category cannot disagree about
 *   what a keyword means — and so each item leaves a `classification_decisions` audit row;
 * - `LedgerModule` supplies `TransactionsService.create` for the *Napravi transakciju* arm, which is
 *   how a receipt becomes a CONFIRMED Transaction with its Splits — through the ledger's own validation
 *   (I-1, I-3, I-10) rather than an insert of its own.
 *
 * The `OCR` token is the third seam of its kind in this codebase (`AI_CLASSIFIER`, `NARRATOR`) and it
 * comes from `AiModule` (ADR-031 decision 6): with no `OCR` endpoint `RoutedOcrService` is not built
 * and the token is `UNCONFIGURED_OCR`, so receipts are itemised by hand and the screen never offers
 * extraction it cannot perform.
 *
 * @module apps/api/src/modules/receipts
 */
@Module({
  imports: [PrismaModule, FilesModule, LedgerModule, ClassificationModule, AiModule],
  providers: [ReceiptsService, ReceiptsResolver],
  exports: [ReceiptsService],
})
export class ReceiptsModule {}
