import { Module } from '@nestjs/common';

import { CONFIG } from '../../config/config';
import { PrismaModule } from '../../prisma/prisma.module';
import { FilesController } from './files.controller';
import { FilesResolver } from './files.resolver';
import { FilesService } from './files.service';
import { makeObjectStorage, OBJECT_STORAGE } from './object-storage';
import { makeScanner, SCANNER } from './scanner';

/**
 * Attachments (F-34, F-14) — docs/05 §3's `files` module, ADR-018, task 4.1.1.
 *
 * `files` owns `attachments` and nothing else. It does **not** own `transactions.attachment_id` or
 * `receipts.attachment_id`: linking is a column write, and `commit` performs exactly one of them (the
 * Transaction one) because that is the only owner that exists today. `receipts` arrives with 4.1.3 and
 * will link through the same call rather than through a second file path.
 *
 * ## Two injected seams, both configured here
 *
 * | Token | Real | Inert |
 * |---|---|---|
 * | `OBJECT_STORAGE` | `S3ObjectStorage` over the hand-rolled SigV4 signer | `UNCONFIGURED_OBJECT_STORAGE` |
 * | `SCANNER` | *(none in this build)* | `UNCONFIGURED_SCANNER`, which records `SKIPPED` |
 *
 * Both are `useFactory` providers reading `CONFIG`, so a deployment changes behaviour through
 * environment variables and a test overrides a token — no vendor is named in `FilesService`.
 *
 * @module apps/api/src/modules/files
 */
@Module({
  imports: [PrismaModule],
  controllers: [FilesController],
  providers: [
    FilesService,
    FilesResolver,
    {
      provide: OBJECT_STORAGE,
      inject: [CONFIG],
      useFactory: makeObjectStorage,
    },
    { provide: SCANNER, useFactory: makeScanner },
  ],
  exports: [FilesService, OBJECT_STORAGE],
})
export class FilesModule {}
