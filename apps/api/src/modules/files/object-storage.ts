import type { AppConfig } from '../../config/config';
import { presignS3Request, signS3Request, type PresignedRequest } from './sigv4';

/**
 * The object-storage seam — ADR-018, docs/05 §1, docs/06 §9, task 4.1.1.
 *
 * ## Why a seam with an inert default
 *
 * Receipt images are the most sensitive artefacts the product holds, and bytes never transit the API:
 * the client PUTs straight to S3/MinIO with a short-lived presigned URL and the API only ever *signs*.
 * That means the API's whole relationship with storage is four operations, and the module that owns
 * them should not care which vendor answers — MinIO in development, a managed S3-compatible service
 * if it is cheaper (ADR-018), or nothing at all.
 *
 * `UNCONFIGURED_OBJECT_STORAGE` is the honest default: with no `S3_*` configuration the module reports
 * storage **unavailable** and a presign request fails with a readable error instead of returning a URL
 * that cannot work. That is the same shape as `UNCONFIGURED_EMBEDDINGS` (ADR-021) and it matters
 * because CI has no MinIO: `api:test` must be able to boot the module without one.
 *
 * ## No vendor SDK
 *
 * The three operations here are a canonical request and an HMAC chain. `@aws-sdk/client-s3` plus
 * `@aws-sdk/s3-request-presigner` is tens of megabytes and a supply-chain surface for signing a URL,
 * so the signing lives in `./sigv4.ts`, dependency-free and tested against AWS's own example. ADR-004
 * asks for an ADR before a new dependency; the answer here is not to add one.
 *
 * @module apps/api/src/modules/files
 */

/** DI token. Nothing outside this module imports a storage implementation. */
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

/** What a `HEAD` tells us about an uploaded object. */
export interface StoredObject {
  readonly byteSize: number;
  /** MinIO/S3 report the MD5 ETag; we record `sha256` ourselves, in object metadata. */
  readonly etag: string | null;
  readonly contentType: string | null;
  /**
   * The `x-amz-meta-sha256` the client sent at upload time, when it sent one.
   *
   * This is the client's **claim**, not a measurement — S3 has no way to enforce a body hash on a
   * presigned PUT. It is compared against the declared `attachments.sha256` so a mismatched upload is
   * caught, and it is explicitly not treated as integrity proof.
   */
  readonly declaredSha256: string | null;
}

export interface ObjectStorage {
  /** `false` when no `S3_*` configuration is present; callers must not attempt an operation. */
  readonly available: boolean;
  readonly unavailableReason: string | null;
  presignPut(input: {
    readonly key: string;
    readonly contentType: string;
    readonly sha256: string;
    readonly expiresSeconds: number;
  }): PresignedRequest;
  presignGet(input: { readonly key: string; readonly expiresSeconds: number }): PresignedRequest;
  /** `null` when the object is not there (a 404 is an answer, not an error). */
  head(key: string): Promise<StoredObject | null>;
  /**
   * The object's bytes, for the one caller that legitimately needs them: OCR.
   *
   * ADR-018's rule is that bytes never transit the API *on the request path* — a client uploads and
   * downloads directly. Reading an image server-side to hand it to a LOCAL or EEA OCR provider is a
   * different operation with a different justification, and it is why this method exists here rather
   * than in a feature module: storage stays owned by `files`.
   */
  getBytes(key: string): Promise<Uint8Array>;
  /** Idempotent: removing an object that is already gone is a success. */
  remove(key: string): Promise<void>;
  /** Create the bucket when it is missing. Used by `pnpm storage:init`, never on a request path. */
  ensureBucket(): Promise<void>;
}

class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

export const UNCONFIGURED_OBJECT_STORAGE: ObjectStorage = (() => {
  const reason =
    'Object storage is not configured: set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY ' +
    '(ADR-018). Attachments cannot be uploaded on this deployment.';
  const refuse = (): never => {
    throw new StorageError(reason);
  };
  return {
    available: false,
    unavailableReason: reason,
    presignPut: refuse,
    presignGet: refuse,
    head: async () => refuse(),
    getBytes: async () => refuse(),
    remove: async () => refuse(),
    ensureBucket: async () => refuse(),
  };
})();

/** An S3/MinIO adapter over the hand-rolled SigV4 signer. */
export class S3ObjectStorage implements ObjectStorage {
  readonly available = true;
  readonly unavailableReason = null;

  constructor(
    private readonly endpoint: string,
    private readonly bucket: string,
    private readonly region: string,
    private readonly accessKey: string,
    private readonly secretKey: string,
  ) {}

  presignPut(input: {
    readonly key: string;
    readonly contentType: string;
    readonly sha256: string;
    readonly expiresSeconds: number;
  }): PresignedRequest {
    return this.presign('PUT', input.key, input.expiresSeconds, {
      'content-type': input.contentType,
      // Recorded at upload so `commit` can compare it without reading the body back.
      'x-amz-meta-sha256': input.sha256,
    });
  }

  presignGet(input: { readonly key: string; readonly expiresSeconds: number }): PresignedRequest {
    return this.presign('GET', input.key, input.expiresSeconds, {});
  }

  async head(key: string): Promise<StoredObject | null> {
    const signed = signS3Request(this.request('HEAD', key));
    const response = await fetch(signed.url, { method: 'HEAD', headers: sendHeaders(signed) });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new StorageError(`Object storage answered ${response.status} on HEAD ${key}.`);
    }
    return {
      byteSize: Number(response.headers.get('content-length') ?? 0),
      etag: response.headers.get('etag'),
      contentType: response.headers.get('content-type'),
      declaredSha256: response.headers.get('x-amz-meta-sha256'),
    };
  }

  async getBytes(key: string): Promise<Uint8Array> {
    const signed = signS3Request(this.request('GET', key));
    const response = await fetch(signed.url, { method: 'GET', headers: sendHeaders(signed) });
    if (!response.ok) {
      throw new StorageError(`Object storage answered ${response.status} on GET ${key}.`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async remove(key: string): Promise<void> {
    const signed = signS3Request(this.request('DELETE', key));
    const response = await fetch(signed.url, { method: 'DELETE', headers: sendHeaders(signed) });
    // 204 is the normal answer and 404 means it is already gone — both are success for a purge.
    if (response.status === 204 || response.status === 404) return;
    if (!response.ok) {
      throw new StorageError(`Object storage answered ${response.status} on DELETE ${key}.`);
    }
  }

  /**
   * `HEAD /bucket`, then `PUT /bucket` when it is absent.
   *
   * A bucket is a deployment concern, not a per-request one, so this is called by an explicit script
   * rather than on the presign path — a lazy create inside a request would be a side effect on the
   * hot path, and it would need write permission the API otherwise does not use.
   */
  async ensureBucket(): Promise<void> {
    const head = signS3Request(this.request('HEAD', ''));
    const existing = await fetch(head.url, { method: 'HEAD', headers: sendHeaders(head) });
    if (existing.ok) return;
    if (existing.status !== 404) {
      throw new StorageError(`Object storage answered ${existing.status} on HEAD /${this.bucket}.`);
    }

    const create = signS3Request(this.request('PUT', ''));
    const created = await fetch(create.url, { method: 'PUT', headers: sendHeaders(create) });
    // 409 means another process won the race, which is the outcome we wanted.
    if (created.ok || created.status === 409) return;
    throw new StorageError(
      `Could not create bucket "${this.bucket}": object storage answered ${created.status}.`,
    );
  }

  private presign(
    method: 'GET' | 'PUT',
    key: string,
    expiresSeconds: number,
    headers: Readonly<Record<string, string>>,
  ): PresignedRequest {
    return presignS3Request({
      ...this.request(method, key),
      expiresSeconds,
      headers,
      now: new Date(),
    });
  }

  private request(
    method: 'GET' | 'PUT' | 'HEAD' | 'DELETE',
    key: string,
  ): {
    readonly method: typeof method;
    readonly endpoint: string;
    readonly bucket: string;
    readonly key: string;
    readonly region: string;
    readonly accessKey: string;
    readonly secretKey: string;
    readonly now: Date;
  } {
    return {
      method,
      endpoint: this.endpoint,
      bucket: this.bucket,
      key,
      region: this.region,
      accessKey: this.accessKey,
      secretKey: this.secretKey,
      now: new Date(),
    };
  }
}

/**
 * The headers to hand to `fetch` for a signed request.
 *
 * `host` is **removed on purpose**: it is part of `SignedHeaders`, so the signature already covers it,
 * but the HTTP stack sets the real `Host` from the URL. Passing it explicitly is either ignored or
 * rejected depending on the runtime, and neither is worth the ambiguity — the signature stays valid
 * because the value the runtime sends is the one that was signed.
 */
function sendHeaders(signed: { readonly headers: Readonly<Record<string, string>> }): Record<string, string> {
  const { host: _host, ...rest } = signed.headers;
  return rest;
}

/**
 * The adapter this deployment gets: a real one when all four settings are present, the inert one
 * otherwise. Partial configuration is treated as none, because a signer missing its secret can only
 * produce signatures the server will reject.
 */
export function makeObjectStorage(config: AppConfig): ObjectStorage {
  const { S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = config;
  if (
    S3_ENDPOINT === undefined ||
    S3_BUCKET === undefined ||
    S3_ACCESS_KEY_ID === undefined ||
    S3_SECRET_ACCESS_KEY === undefined
  ) {
    return UNCONFIGURED_OBJECT_STORAGE;
  }
  return new S3ObjectStorage(S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY);
}
