import { Field, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

import { UuidScalar } from '../../graphql/scalars/uuid.scalar';
import type { FileView } from './files.service';

/**
 * Attachment — F-34, docs/06 §5 (`Attachment`, `commitAttachment`, `deleteAttachment`), task 4.1.1.
 *
 * ## The two enums come from the DDL, not from docs/06's sketch
 *
 * docs/06 §5 sketched `AttachmentPurpose { RECEIPT TRANSACTION_PROOF OTHER }` and
 * `FileScanState { PENDING CLEAN REJECTED }`; docs/03 §4 — which is canonical — has
 * `purpose IN ('RECEIPT','TRANSACTION','IMPORT','AVATAR')` and
 * `scan_state IN ('PENDING','CLEAN','INFECTED','FAILED','SKIPPED')`. The schema is what a `CHECK`
 * constraint enforces, so the enums below are the DDL's values and docs/06 §5 is corrected.
 *
 * ## `storage_key` is not exposed
 *
 * docs/06 §5 is explicit: raw object paths are an internal detail, and a client receives a presigned
 * URL. Exposing the key would hand a client the one string it could try to enumerate (threat T-04).
 *
 * ## `downloadUrl` is computed per read
 *
 * It is a short-lived signature, not a stored field, so the property resolves by signing against the
 * configured storage. It is `null` while the row is not linkable (`PENDING`, `INFECTED`, `FAILED`) or
 * when the deployment has no storage at all.
 *
 * @module apps/api/src/modules/files
 */

/** Mirrors the `attachments.purpose` CHECK constraint (docs/03 §4). */
export enum AttachmentPurpose {
  RECEIPT = 'RECEIPT',
  TRANSACTION = 'TRANSACTION',
  IMPORT = 'IMPORT',
  AVATAR = 'AVATAR',
}

registerEnumType(AttachmentPurpose, {
  name: 'AttachmentPurpose',
  description: 'Why the file was uploaded — a Receipt photo, a Transaction proof, an import or an avatar.',
});

/** Mirrors the `attachments.scan_state` CHECK constraint (docs/03 §4). */
export enum FileScanState {
  PENDING = 'PENDING',
  CLEAN = 'CLEAN',
  INFECTED = 'INFECTED',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
}

registerEnumType(FileScanState, {
  name: 'FileScanState',
  description:
    '`PENDING` until `commitAttachment` has seen the bytes. `CLEAN`/`SKIPPED` are downloadable — and ' +
    '`SKIPPED` means **not scanned**, which this build produces when no scanner is configured ' +
    '(docs/08 §9.4). `INFECTED`/`FAILED` are never downloadable.',
});

@ObjectType()
export class AttachmentModel {
  @Field(() => UuidScalar)
  id!: string;

  @Field(() => AttachmentPurpose)
  purpose!: AttachmentPurpose;

  @Field(() => String)
  mimeType!: string;

  @Field(() => Int, { description: 'Bytes. Capped at 12 MiB by the presign allowlist (docs/06 §9.2).' })
  byteSize!: number;

  @Field(() => String, { description: 'Lower-case hex SHA-256 of the bytes, declared at presign.' })
  sha256!: string;

  @Field(() => String, {
    nullable: true,
    description: 'A short-lived presigned GET, or null while the row is not linkable.',
  })
  downloadUrl!: string | null;

  @Field(() => FileScanState)
  scanState!: FileScanState;

  @Field(() => Date)
  createdAt!: Date;
}

@InputType()
export class CommitAttachmentInput {
  @Field(() => UuidScalar)
  attachmentId!: string;

  @Field(() => UuidScalar, {
    nullable: true,
    description: 'Attach the file to a Transaction in the same Household.',
  })
  transactionId?: string | null;
}

export function toAttachmentModel(view: FileView): AttachmentModel {
  const model = new AttachmentModel();
  model.id = view.id;
  model.purpose = view.purpose as AttachmentPurpose;
  model.mimeType = view.mimeType;
  // `Int!` on the wire and 12 MiB is the ceiling, so this cannot lose precision.
  model.byteSize = Number(view.byteSize);
  model.sha256 = view.sha256;
  model.downloadUrl = view.downloadUrl;
  model.scanState = view.scanState as FileScanState;
  model.createdAt = view.createdAt;
  return model;
}
