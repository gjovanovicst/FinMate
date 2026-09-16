import { loadConfig } from '../../config/config';
import { makeObjectStorage } from './object-storage';

/**
 * `pnpm storage:init` — create the attachments bucket if it is missing (ADR-018, task 4.1.1).
 *
 * MinIO does not create a bucket on first write, so a fresh `pnpm dev:infra` has object storage that
 * answers every presigned PUT with `NoSuchBucket`. The API deliberately does **not** create it lazily
 * on the presign path: that would be a side effect on a request, and it would need bucket-write
 * permission the API otherwise does not use. A deployment creates the bucket once, out of band; this
 * script is that step for development.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const storage = makeObjectStorage(config);
  if (!storage.available) {
    console.error(storage.unavailableReason ?? 'Object storage is not configured.');
    process.exitCode = 1;
    return;
  }

  await storage.ensureBucket();
  console.log(`Object storage ready: bucket "${config.S3_BUCKET}" at ${config.S3_ENDPOINT}.`);
}

void main();
