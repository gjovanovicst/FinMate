import type { ObjectStorage } from '../modules/files/object-storage';

/**
 * An in-memory {@link ObjectStorage} for integration tests.
 *
 * CI has Postgres and Redis but no MinIO (`.github/workflows/ci.yml`), and a suite that needed a real
 * bucket would be a suite that cannot run there. It is shared rather than copied because two suites now
 * need one — `files` for upload/download and `receipts` for the OCR read path — and two fakes would
 * drift in exactly the way a fake must not: silently.
 *
 * `presignPut` returns `host` in its header map on purpose: the real signer signs it, and the module
 * strips it before a client sees it. A fake that omitted it would stop exercising that.
 */
export class FakeObjectStorage implements ObjectStorage {
  readonly available = true;
  readonly unavailableReason = null;
  readonly objects = new Map<string, { byteSize: number; contentType: string; sha256: string; bytes: Uint8Array }>();
  readonly removed: string[] = [];
  headCalls = 0;

  presignPut(input: {
    readonly key: string;
    readonly contentType: string;
    readonly sha256: string;
    readonly expiresSeconds: number;
  }): { url: string; method: string; headers: Record<string, string> } {
    return {
      url: `https://storage.test/${input.key}?sig=put`,
      method: 'PUT',
      headers: {
        host: 'storage.test',
        'content-type': input.contentType,
        'x-amz-meta-sha256': input.sha256,
      },
    };
  }

  presignGet(input: { readonly key: string; readonly expiresSeconds: number }): {
    url: string;
    method: string;
    headers: Record<string, string>;
  } {
    return { url: `https://storage.test/${input.key}?sig=get`, method: 'GET', headers: {} };
  }

  async head(key: string): Promise<{
    byteSize: number;
    etag: null;
    contentType: string;
    declaredSha256: string;
  } | null> {
    this.headCalls += 1;
    const object = this.objects.get(key);
    return object === undefined
      ? null
      : {
          byteSize: object.byteSize,
          etag: null,
          contentType: object.contentType,
          declaredSha256: object.sha256,
        };
  }

  async getBytes(key: string): Promise<Uint8Array> {
    const object = this.objects.get(key);
    if (object === undefined) throw new Error(`no object at ${key}`);
    return object.bytes;
  }

  async remove(key: string): Promise<void> {
    this.removed.push(key);
    this.objects.delete(key);
  }

  async ensureBucket(): Promise<void> {}

  /** Put an object as a successful client PUT would have. */
  put(key: string, bytes: Uint8Array, contentType: string, sha256: string): void {
    this.objects.set(key, { byteSize: bytes.length, contentType, sha256, bytes });
  }
}
