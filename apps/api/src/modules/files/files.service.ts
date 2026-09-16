import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { addMonths, toLocalDate, uuidv7 } from '@finmate/domain';

import { CONFIG, type AppConfig } from '../../config/config';
import { ApiError } from '../../common/filters/all-exceptions.filter';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { OBJECT_STORAGE, type ObjectStorage } from './object-storage';
import { SCANNER, type Scanner } from './scanner';

/**
 * Attachments — F-34, F-14, ADR-018, docs/06 §5 (`commitAttachment`) and §9 (`/v1/files/*`), task 4.1.1.
 *
 * ## The API signs; it never carries bytes
 *
 * ADR-018's whole point is that the request path stays small: `presign` allocates the row and returns a
 * short-lived URL, the client PUTs straight to MinIO/S3, and `commit` verifies what arrived. No method
 * here reads or writes an image body, which is why the p95 latency budget survives a 12 MiB receipt.
 *
 * ## Allocation is idempotent on the content, not the request
 *
 * docs/06 §9.2: re-uploading the same bytes within 24 h returns the **existing** `attachmentId`. That
 * is a deliberate difference from the ledger's `idempotencyKey`: a client retrying an upload after a
 * dropped response must not produce a second row, and `(purpose, sha256)` is the identity it can
 * actually state. Outside the window a new row is allocated, so a genuinely re-photographed receipt is
 * a new attachment rather than a silent overwrite.
 *
 * ## Nothing becomes usable by accident
 *
 * A row is `PENDING` from allocation. `commit` HEADs the object, compares the declared size and the
 * upload's `x-amz-meta-sha256`, runs the {@link Scanner} hook, and only then links it to a Transaction.
 * A row that never arrived, or arrived short, becomes `FAILED`; a rejected one becomes `INFECTED` and
 * its object is deleted immediately (docs/03 §4).
 *
 * ## Retention
 *
 * `purge` implements the two rules docs/03 §4 and docs/08 §7 state: an **orphan** (unreferenced, or an
 * abandoned `PENDING` upload) is removed after a grace period, and **every** attachment is hard-deleted
 * 24 months after capture. It is the `files.purge` job and it is idempotent — deleting a row that is
 * already gone is a no-op, and removing an object that is already gone succeeds.
 *
 * @module apps/api/src/modules/files
 */

/** docs/06 §9.2's allowlist. Anything else is refused before a row is allocated. */
export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
  'application/pdf',
] as const;

/** docs/06 §9.2: 12 MiB, sized for a phone photo at full resolution. */
export const MAX_BYTE_SIZE = 12 * 1024 * 1024;

/** Mirrors the `attachments.purpose` CHECK constraint (docs/03 §4). */
export const PURPOSES = ['RECEIPT', 'TRANSACTION', 'IMPORT', 'AVATAR'] as const;

/** docs/06 §9.2: `10/min` per household. */
export const PRESIGN_RATE_LIMIT = 10;
export const PRESIGN_RATE_WINDOW_SECONDS = 60;

/** docs/06 §9.2: the `(purpose, sha256)` idempotency window. */
export const IDEMPOTENCY_WINDOW_HOURS = 24;

/**
 * How long an unreferenced attachment survives.
 *
 * Long enough that a client which uploads and then navigates away to type the amount still can commit
 * it, short enough that a forgotten upload is not a permanent blob.
 */
export const ORPHAN_GRACE_HOURS = 24;

/** docs/08 §7 row 17: a Receipt image is kept for 24 months, then hard-deleted. */
export const RETENTION_MONTHS = 24;

export interface PresignInput {
  readonly purpose: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
}

export interface PresignView {
  readonly attachmentId: string;
  readonly uploadUrl: string;
  readonly method: 'PUT';
  /** The client must send these verbatim: they are part of the signature. */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: string;
  /** `true` when an idempotent re-upload reused an existing row. */
  readonly reused: boolean;
}

export interface FileView {
  readonly id: string;
  readonly purpose: string;
  readonly mimeType: string;
  readonly byteSize: bigint;
  readonly sha256: string;
  readonly scanState: string;
  readonly downloadUrl: string | null;
  readonly createdAt: Date;
}

export interface CommitInput {
  readonly attachmentId: string;
  readonly transactionId?: string | null;
}

export interface PurgeResult {
  /** Rows the pass considered. */
  readonly scanned: number;
  readonly objectsDeleted: number;
  readonly rowsDeleted: number;
  /** Object deletions that failed; the row is kept so the next pass retries it. */
  readonly failed: number;
}

/**
 * Validate a presign request, returning the problem or `null`.
 *
 * A pure function so every boundary is unit-testable without a database or a bucket — the same reason
 * `duplicate-detection.ts` is separate from the capture service.
 */
export function validatePresignInput(input: PresignInput): string | null {
  if (!(PURPOSES as readonly string[]).includes(input.purpose)) {
    return `Unknown purpose "${input.purpose}". Allowed: ${PURPOSES.join(', ')}.`;
  }
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(input.mimeType)) {
    return `Unsupported file type "${input.mimeType}". Allowed: ${ALLOWED_MIME_TYPES.join(', ')}.`;
  }
  if (!Number.isInteger(input.byteSize) || input.byteSize <= 0) {
    return 'byteSize must be a positive whole number of bytes.';
  }
  if (input.byteSize > MAX_BYTE_SIZE) {
    return `That file is ${input.byteSize} bytes; the limit is ${MAX_BYTE_SIZE} (12 MiB).`;
  }
  // Lower-case hex, exactly 64 characters: anything else is not a SHA-256 and cannot be matched.
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) {
    return 'sha256 must be 64 lower-case hexadecimal characters.';
  }
  return null;
}

/** The extension an object key carries. A key without one is a key MinIO guesses a type for. */
export function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/heic':
      return 'heic';
    case 'image/webp':
      return 'webp';
    case 'application/pdf':
      return 'pdf';
    default:
      return 'bin';
  }
}

/** `household/<id>/<random>.<ext>` — docs/08 T-04: scoped keys, never enumerable, never a listing. */
export function storageKeyFor(householdId: string, mimeType: string): string {
  return `household/${householdId}/${randomUUID()}.${extensionFor(mimeType)}`;
}

/** The signed headers a **client** must send: everything but `host`, which the runtime owns. */
export function clientHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'host'));
}

interface AttachmentRow {
  readonly id: string;
  readonly household_id: string;
  readonly storage_key: string;
  readonly mime_type: string;
  readonly byte_size: bigint;
  readonly sha256: string;
  readonly purpose: string;
  readonly scan_state: string;
  readonly created_at: Date;
}

/** A scan state a client may download: the two the DDL calls linkable (docs/03 §4). */
const LINKABLE_SCAN_STATES = new Set(['CLEAN', 'SKIPPED']);

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(SCANNER) private readonly scanner: Scanner,
  ) {}

  /** `false` when this deployment has no object storage; the REST layer reports it readably. */
  get storageAvailable(): boolean {
    return this.storage.available;
  }

  // -------------------------------------------------------------------------------------------
  // Upload
  // -------------------------------------------------------------------------------------------

  async presign(householdId: string, input: PresignInput): Promise<PresignView> {
    const problem = validatePresignInput(input);
    if (problem !== null) throw new ApiError('VALIDATION_FAILED', problem);
    if (!this.storage.available) {
      throw new ApiError(
        'VALIDATION_FAILED',
        this.storage.unavailableReason ?? 'Object storage is not configured.',
      );
    }

    const allowance = await this.rateLimit.consume(
      'files.presign',
      householdId,
      PRESIGN_RATE_LIMIT,
      PRESIGN_RATE_WINDOW_SECONDS,
    );
    if (!allowance.allowed) {
      throw new ApiError(
        'RATE_LIMITED',
        `Too many uploads. Try again in ${allowance.retryAfterSeconds ?? PRESIGN_RATE_WINDOW_SECONDS} seconds.`,
      );
    }

    const cutoff = new Date(Date.now() - IDEMPOTENCY_WINDOW_HOURS * 60 * 60 * 1000);
    const existing = await this.prisma.client.attachments.findFirst({
      where: {
        household_id: householdId,
        purpose: input.purpose,
        sha256: input.sha256,
        created_at: { gte: cutoff },
      },
      orderBy: { id: 'desc' },
    });

    const row: AttachmentRow =
      existing ??
      (await this.prisma.client.attachments.create({
        data: {
          id: uuidv7(),
          household_id: householdId,
          storage_key: storageKeyFor(householdId, input.mimeType),
          mime_type: input.mimeType,
          byte_size: BigInt(input.byteSize),
          sha256: input.sha256,
          purpose: input.purpose,
          // Nothing is linkable or downloadable until `commit` has seen the bytes.
          scan_state: 'PENDING',
        },
      }));

    const expiresSeconds = this.config.S3_UPLOAD_URL_TTL_SECONDS;
    const signed = this.storage.presignPut({
      key: row.storage_key,
      contentType: row.mime_type,
      sha256: row.sha256,
      expiresSeconds,
    });

    return {
      attachmentId: row.id,
      uploadUrl: signed.url,
      method: 'PUT',
      // `host` is part of the signature but must not be *sent* by the client: the browser sets the
      // real `Host` header itself, and a scripted client cannot set it at all. Everything else here
      // (`content-type`, `x-amz-meta-sha256`) is signed and must be sent verbatim.
      headers: clientHeaders(signed.headers),
      expiresAt: new Date(Date.now() + expiresSeconds * 1000).toISOString(),
      reused: existing !== null,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------------------------

  /** One attachment of this Household, or `null` — the scoped predicate is the tenancy check (ADR-008). */
  async getById(householdId: string, id: string): Promise<FileView | null> {
    const row = await this.prisma.client.attachments.findFirst({
      where: { id, household_id: householdId },
    });
    return row === null ? null : this.toView(row);
  }

  /**
   * The download decision, kept separate from the view so the REST layer can answer `302` while
   * GraphQL answers with a nullable `downloadUrl`.
   *
   * `'pending'` is not an error: the row exists and is simply not linkable yet, which is the state a
   * client sits in between a successful PUT and `commitAttachment`.
   */
  async downloadTarget(householdId: string, id: string): Promise<{ url: string } | 'pending' | null> {
    const row = await this.prisma.client.attachments.findFirst({
      where: { id, household_id: householdId },
    });
    if (row === null) return null;
    if (!LINKABLE_SCAN_STATES.has(row.scan_state) || !this.storage.available) return 'pending';
    return {
      url: this.storage.presignGet({
        key: row.storage_key,
        expiresSeconds: this.config.S3_DOWNLOAD_URL_TTL_SECONDS,
      }).url,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Commit and delete
  // -------------------------------------------------------------------------------------------

  /**
   * Verify an upload and, optionally, attach it to a Transaction.
   *
   * Idempotent: a row already decided is not re-scanned, so a retried commit after a dropped response
   * links the Transaction instead of failing on a second HEAD.
   *
   * **Linking requires a linkable state.** A row that failed or was quarantined cannot be attached by
   * committing it a second time with a `transactionId` — otherwise the "not downloadable" guarantee
   * would stop at the download and a `FAILED`/`INFECTED` blob could still be referenced by a
   * Transaction.
   */
  async commit(householdId: string, input: CommitInput): Promise<FileView> {
    if (!this.storage.available) {
      throw new ApiError(
        'VALIDATION_FAILED',
        this.storage.unavailableReason ?? 'Object storage is not configured.',
      );
    }

    const row = await this.prisma.client.attachments.findFirst({
      where: { id: input.attachmentId, household_id: householdId },
    });
    if (row === null) throw new ApiError('NOT_FOUND', 'Attachment not found.');

    if (input.transactionId !== undefined && input.transactionId !== null) {
      const transaction = await this.prisma.client.transactions.findFirst({
        where: { id: input.transactionId, household_id: householdId, deleted_at: null },
        select: { id: true },
      });
      if (transaction === null) throw new ApiError('NOT_FOUND', 'Transaction not found.');
    }

    let scanState = row.scan_state;
    if (scanState === 'PENDING') {
      const stored = await this.storage.head(row.storage_key);
      if (stored === null) {
        await this.setScanState(row.id, householdId, 'FAILED');
        throw new ApiError(
          'VALIDATION_FAILED',
          'The upload did not arrive. Upload the file to the presigned URL, then commit again.',
        );
      }
      if (BigInt(stored.byteSize) !== row.byte_size) {
        await this.setScanState(row.id, householdId, 'FAILED');
        throw new ApiError(
          'VALIDATION_FAILED',
          `The uploaded object is ${stored.byteSize} bytes but ${row.byte_size.toString()} were declared.`,
        );
      }
      if (stored.declaredSha256 !== null && stored.declaredSha256 !== row.sha256) {
        await this.setScanState(row.id, householdId, 'FAILED');
        throw new ApiError(
          'VALIDATION_FAILED',
          'The uploaded object declares a different sha256 than the presign request did.',
        );
      }

      const verdict = await this.scanner.scan({
        key: row.storage_key,
        mimeType: row.mime_type,
        byteSize: stored.byteSize,
      });
      if (verdict === 'INFECTED') {
        // Quarantine: the bytes go now, the row stays as the record of what happened.
        await this.safeRemove(row.storage_key);
        await this.setScanState(row.id, householdId, 'INFECTED');
        throw new ApiError(
          'VALIDATION_FAILED',
          'The uploaded file did not pass the format/virus check and was discarded.',
        );
      }
      await this.setScanState(row.id, householdId, verdict);
      scanState = verdict;
    }

    if (input.transactionId !== undefined && input.transactionId !== null) {
      if (!LINKABLE_SCAN_STATES.has(scanState)) {
        throw new ApiError(
          'VALIDATION_FAILED',
          `That attachment is ${scanState} and cannot be attached to a Transaction.`,
        );
      }
      await this.prisma.client.transactions.updateMany({
        where: { id: input.transactionId, household_id: householdId, deleted_at: null },
        data: { attachment_id: row.id },
      });
    }

    const fresh = await this.prisma.client.attachments.findFirst({
      where: { id: row.id, household_id: householdId },
    });
    return this.toView(fresh ?? row);
  }

  /** Remove an attachment and its object. `false` when the id is not this Household's. */
  async remove(householdId: string, id: string): Promise<boolean> {
    const row = await this.prisma.client.attachments.findFirst({
      where: { id, household_id: householdId },
      select: { id: true, storage_key: true },
    });
    if (row === null) return false;

    if (this.storage.available) {
      // Object-first: a row deleted before its blob would leave an object nothing can name again.
      await this.safeRemove(row.storage_key);
    }
    // `transactions.attachment_id` and `receipts.attachment_id` are `ON DELETE SET NULL` (docs/03 §4),
    // so a referenced attachment detaches rather than blocking the delete.
    await this.prisma.client.attachments.deleteMany({ where: { id: row.id, household_id: householdId } });
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Retention
  // -------------------------------------------------------------------------------------------

  /**
   * `files.purge` — docs/05 §8, docs/03 §4, docs/08 §7.
   *
   * Four rules, all of them "this blob should not exist any more":
   *
   * 1. `INFECTED` / `FAILED` — quarantine and abandon, removed at the next pass.
   * 2. A `PENDING` row older than the grace period — an upload that was presigned and never committed.
   * 3. An **unreferenced** row older than the grace period — a committed upload the user then dropped.
   * 4. Anything past the 24-month retention, referenced or not.
   */
  async purge(householdId: string, options: { readonly now?: Date } = {}): Promise<PurgeResult> {
    const now = options.now ?? new Date();
    const orphanCutoff = new Date(now.getTime() - ORPHAN_GRACE_HOURS * 60 * 60 * 1000);
    const retentionCutoff = new Date(
      `${addMonths(toLocalDate(now, 'UTC'), -RETENTION_MONTHS)}T00:00:00.000Z`,
    );

    const rows = await this.prisma.client.attachments.findMany({
      where: {
        household_id: householdId,
        OR: [
          { scan_state: { in: ['INFECTED', 'FAILED'] } },
          { scan_state: 'PENDING', created_at: { lt: orphanCutoff } },
          {
            created_at: { lt: orphanCutoff },
            transactions: { none: {} },
            receipts: { none: {} },
          },
          { created_at: { lt: retentionCutoff } },
        ],
      },
      select: { id: true, storage_key: true },
    });

    let objectsDeleted = 0;
    let rowsDeleted = 0;
    let failed = 0;

    for (const row of rows) {
      if (this.storage.available) {
        try {
          await this.storage.remove(row.storage_key);
          objectsDeleted += 1;
        } catch (error) {
          // The row is kept so the next pass retries: deleting it now would orphan the blob forever.
          failed += 1;
          this.logger.warn(
            `files.purge could not remove ${row.storage_key}: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
      }
      const result = await this.prisma.client.attachments.deleteMany({
        where: { id: row.id, household_id: householdId },
      });
      rowsDeleted += result.count;
    }

    return { scanned: rows.length, objectsDeleted, rowsDeleted, failed };
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  private async setScanState(
    id: string,
    householdId: string,
    scanState: string,
  ): Promise<void> {
    await this.prisma.client.attachments.updateMany({
      where: { id, household_id: householdId },
      data: { scan_state: scanState },
    });
  }

  private async safeRemove(key: string): Promise<void> {
    try {
      await this.storage.remove(key);
    } catch (error) {
      // A blob we cannot remove must not fail the row's transition; `files.purge` retries it.
      this.logger.warn(
        `Could not remove ${key}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private toView(row: AttachmentRow): FileView {
    return {
      id: row.id,
      purpose: row.purpose,
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      sha256: row.sha256,
      scanState: row.scan_state,
      downloadUrl:
        LINKABLE_SCAN_STATES.has(row.scan_state) && this.storage.available
          ? this.storage.presignGet({
              key: row.storage_key,
              expiresSeconds: this.config.S3_DOWNLOAD_URL_TTL_SECONDS,
            }).url
          : null,
      createdAt: row.created_at,
    };
  }

  /** The bucket the module signs against, for the `storage:init` script and its log line. */
  get bucket(): string | null {
    return this.config.S3_BUCKET ?? null;
  }
}
