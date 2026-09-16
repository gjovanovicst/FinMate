import { createHash, createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { amzDates, presignS3Request, sha256Hex, signS3Request } from './sigv4';
import type { PresignedRequest, SigV4Request } from './sigv4';

const VECTOR = {
  bucket: 'examplebucket',
  key: 'test.txt',
  region: 'us-east-1',
  accessKey: 'AKIAIOSFODNN7EXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  now: new Date('2013-05-24T00:00:00Z'),
  expiresSeconds: 86400,
} as const;

/** The published presigned-GET example, verbatim, in its original virtual-hosted form. */
const DOCUMENTED_CANONICAL_REQUEST = [
  'GET',
  '/test.txt',
  'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host',
  'host:examplebucket.s3.amazonaws.com\n',
  'host',
  'UNSIGNED-PAYLOAD',
].join('\n');
const DOCUMENTED_SIGNATURE = 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404';
const DOCUMENTED_CANONICAL_REQUEST_SHA256 =
  '3bfa292879f6447bbcda7001decf97f4a54dc650c8942174ae0a9121cf58ad04';

/**
 * The same vector under the **path-style** addressing this interface supports. Only the canonical
 * URI line and the `host` header line change, so the signature follows deterministically from the
 * published one — checked below by recomputing it with the reference implementation after that
 * implementation has itself reproduced the published signature.
 */
const PATH_STYLE_CANONICAL_REQUEST = DOCUMENTED_CANONICAL_REQUEST.replace(
  '/test.txt',
  '/examplebucket/test.txt',
).replace('host:examplebucket.s3.amazonaws.com', 'host:s3.amazonaws.com');
const PATH_STYLE_SIGNATURE = '733255ef022bec3f2a8701cd61d4b371f3f28c9f193a1f02279211d48d5193d7';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * A second, independent SigV4 implementation written against the documentation rather than the
 * module under test. It is anchored to AWS's published signature first (see the first test), so
 * later assertions that the emitted signature equals this implementation's are meaningful rather
 * than tautological.
 */
const REF_UNRESERVED = /[A-Za-z0-9\-_.~]/;

function refEncode(value: string): string {
  let encoded = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const character = String.fromCharCode(byte);
    encoded += REF_UNRESERVED.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return encoded;
}

interface ReferenceInput {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signedHeaders: string;
  readonly payloadHash: string;
  readonly dateTime: string;
  readonly scope: string;
  readonly secretKey: string;
}

function referenceSignature(input: ReferenceInput): {
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly signature: string;
} {
  const canonicalHeaders = input.signedHeaders
    .split(';')
    .map((name) => `${name}:${input.headers[name] ?? ''}\n`)
    .join('');
  const canonicalRequest = [
    input.method,
    input.path,
    input.query,
    canonicalHeaders,
    input.signedHeaders,
    input.payloadHash,
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    input.dateTime,
    input.scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const [date = '', region = ''] = input.scope.split('/');
  const dateKey = createHmac('sha256', `AWS4${input.secretKey}`).update(date, 'utf8').digest();
  const regionKey = createHmac('sha256', dateKey).update(region, 'utf8').digest();
  const serviceKey = createHmac('sha256', regionKey).update('s3', 'utf8').digest();
  const signingKey = createHmac('sha256', serviceKey).update('aws4_request', 'utf8').digest();
  return {
    canonicalRequest,
    stringToSign,
    signature: createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex'),
  };
}

/** Re-serialise a URL's query the way the canonical request requires: sorted by name, encoded. */
function reserialiseQuery(params: URLSearchParams, exclude: readonly string[] = []): string {
  const pairs: Array<{ name: string; value: string }> = [];
  params.forEach((value, name) => {
    if (!exclude.includes(name)) {
      pairs.push({ name, value });
    }
  });
  pairs.sort((left, right) => {
    if (left.name !== right.name) {
      return left.name < right.name ? -1 : 1;
    }
    return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
  });
  return pairs.map((pair) => `${refEncode(pair.name)}=${refEncode(pair.value)}`).join('&');
}

function requiredParam(params: URLSearchParams, name: string): string {
  const value = params.get(name);
  if (value === null) {
    throw new Error(`the URL is missing ${name}`);
  }
  return value;
}

/** `AKIA…/20130524/us-east-1/s3/aws4_request` → `20130524/us-east-1/s3/aws4_request`. */
function scopeFromCredential(credential: string): string {
  return credential.slice(credential.indexOf('/') + 1);
}

/** Rebuild the canonical request from a presigned URL and recompute its signature. */
function referenceForPresignedUrl(result: PresignedRequest, secretKey: string) {
  const url = new URL(result.url);
  return referenceSignature({
    method: result.method,
    path: url.pathname,
    query: reserialiseQuery(url.searchParams, ['X-Amz-Signature']),
    headers: result.headers,
    signedHeaders: requiredParam(url.searchParams, 'X-Amz-SignedHeaders'),
    // Query-string authentication signs the literal, because the client hashes no body.
    payloadHash: 'UNSIGNED-PAYLOAD',
    dateTime: requiredParam(url.searchParams, 'X-Amz-Date'),
    scope: scopeFromCredential(requiredParam(url.searchParams, 'X-Amz-Credential')),
    secretKey,
  });
}

/** Rebuild the canonical request from a header-signed result and recompute its signature. */
function referenceForAuthorization(result: PresignedRequest, secretKey: string) {
  const url = new URL(result.url);
  const authorization = result.headers['authorization'] ?? '';
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
      authorization,
    );
  if (match === null) {
    throw new Error(`unparseable Authorization header: ${authorization}`);
  }
  const computed = referenceSignature({
    method: result.method,
    path: url.pathname,
    query: reserialiseQuery(url.searchParams),
    headers: result.headers,
    signedHeaders: match[2] ?? '',
    payloadHash: result.headers['x-amz-content-sha256'] ?? '',
    dateTime: result.headers['x-amz-date'] ?? '',
    scope: scopeFromCredential(match[1] ?? ''),
    secretKey,
  });
  return { ...computed, emittedSignature: match[3] ?? '' };
}

const MINIO_ENDPOINT = 'http://localhost:9000';

function minioRequest(overrides: Partial<SigV4Request> & { readonly key: string }): SigV4Request {
  return {
    method: 'PUT',
    endpoint: MINIO_ENDPOINT,
    bucket: 'finmate-attachments',
    region: 'eu-central-1',
    accessKey: 'minio-access-key',
    secretKey: 'minio-secret-key',
    now: new Date('2024-01-02T03:04:05.678Z'),
    ...overrides,
  };
}

describe('amzDates', () => {
  it('formats the pair in UTC, which is what the credential scope requires', () => {
    expect(amzDates(new Date('2013-05-24T00:00:00Z'))).toEqual({
      dateTime: '20130524T000000Z',
      date: '20130524',
    });
    expect(amzDates(new Date('2024-12-31T23:59:59Z'))).toEqual({
      dateTime: '20241231T235959Z',
      date: '20241231',
    });
  });
});

describe('sha256Hex', () => {
  it('matches the known empty-string digest the payload default relies on', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(EMPTY_SHA256);
    expect(sha256Hex(Buffer.from('hello', 'utf8'))).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});

describe('the AWS published presigned-GET vector', () => {
  const request = {
    method: 'GET',
    endpoint: 'https://s3.amazonaws.com',
    bucket: VECTOR.bucket,
    key: VECTOR.key,
    region: VECTOR.region,
    accessKey: VECTOR.accessKey,
    secretKey: VECTOR.secretKey,
    now: VECTOR.now,
    expiresSeconds: VECTOR.expiresSeconds,
  } as const;

  it('anchors the reference implementation to the document before it is used as an oracle', () => {
    expect(createHash('sha256').update(DOCUMENTED_CANONICAL_REQUEST).digest('hex')).toBe(
      DOCUMENTED_CANONICAL_REQUEST_SHA256,
    );
    expect(
      referenceSignature({
        method: 'GET',
        path: '/test.txt',
        query:
          'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host',
        headers: { host: 'examplebucket.s3.amazonaws.com' },
        signedHeaders: 'host',
        payloadHash: 'UNSIGNED-PAYLOAD',
        dateTime: '20130524T000000Z',
        scope: '20130524/us-east-1/s3/aws4_request',
        secretKey: VECTOR.secretKey,
      }).signature,
    ).toBe(DOCUMENTED_SIGNATURE);
  });

  it('emits the documented canonical request, translated to path-style addressing', () => {
    const result = presignS3Request(request);
    const reference = referenceForPresignedUrl(result, VECTOR.secretKey);
    // Virtual-hosted (`examplebucket.s3.amazonaws.com`, URI `/test.txt`) is not what this interface
    // supports, so exactly those two lines must differ from the document and nothing else may.
    expect(reference.canonicalRequest).toBe(PATH_STYLE_CANONICAL_REQUEST);
    expect(reference.stringToSign).toBe(
      [
        'AWS4-HMAC-SHA256',
        '20130524T000000Z',
        '20130524/us-east-1/s3/aws4_request',
        createHash('sha256').update(PATH_STYLE_CANONICAL_REQUEST).digest('hex'),
      ].join('\n'),
    );
  });

  it('carries the documented date, credential scope and algorithm', () => {
    const url = new URL(presignS3Request(request).url);
    expect(url.searchParams.get('X-Amz-Date')).toBe('20130524T000000Z');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('86400');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request',
    );
    // The credential's `/` must survive as %2F in the query string, or the parameter splits.
    expect(presignS3Request(request).url).toContain(
      'X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request',
    );
  });

  it('self-verifies: recomputing from the emitted URL reproduces its X-Amz-Signature', () => {
    const result = presignS3Request(request);
    const reference = referenceForPresignedUrl(result, VECTOR.secretKey);
    const emitted = new URL(result.url).searchParams.get('X-Amz-Signature');
    expect(emitted).toBe(reference.signature);
    // And the recomputation is the published vector's signature under path-style addressing,
    // because it comes from the canonical request that differs from the document in two lines.
    expect(emitted).toBe(PATH_STYLE_SIGNATURE);
  });
});

describe('presignS3Request key encoding', () => {
  it('encodes every character RFC 3986 requires and never leaves a raw + in the path', () => {
    const result = presignS3Request({
      ...minioRequest({ key: 'a b+c=d&e.txt' }),
      expiresSeconds: 600,
    });
    const url = new URL(result.url);
    expect(url.pathname).toBe('/finmate-attachments/a%20b%2Bc%3Dd%26e.txt');
    expect(result.url).toContain('/finmate-attachments/a%20b%2Bc%3Dd%26e.txt');
    expect(url.pathname).not.toContain('+');
    // `+` and the query separators would change meaning if they reached the query string raw.
    expect(url.pathname).not.toContain('&');
    expect(url.pathname).not.toContain('=');
  });

  it('keeps / in a key as a separator rather than encoding it as %2F', () => {
    const result = presignS3Request({
      ...minioRequest({ key: 'households/42/receipt 1+2.pdf' }),
      expiresSeconds: 60,
    });
    expect(new URL(result.url).pathname).toBe(
      '/finmate-attachments/households/42/receipt%201%2B2.pdf',
    );
  });

  it('signs the encoded canonical URI, not the raw key', () => {
    const result = presignS3Request({
      ...minioRequest({ key: 'a b+c=d&e.txt' }),
      expiresSeconds: 600,
    });
    const reference = referenceForPresignedUrl(result, 'minio-secret-key');
    expect(reference.canonicalRequest.split('\n')[1]).toBe(
      '/finmate-attachments/a%20b%2Bc%3Dd%26e.txt',
    );
    expect(new URL(result.url).searchParams.get('X-Amz-Signature')).toBe(reference.signature);
  });

  it('keeps an endpoint path prefix in front of the bucket', () => {
    const result = presignS3Request({
      ...minioRequest({ key: 'note.txt', endpoint: `${MINIO_ENDPOINT}/minio` }),
      expiresSeconds: 60,
    });
    const url = new URL(result.url);
    expect(url.origin).toBe(MINIO_ENDPOINT);
    expect(url.pathname).toBe('/minio/finmate-attachments/note.txt');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(referenceForPresignedUrl(result, 'minio-secret-key').signature).toBe(
      url.searchParams.get('X-Amz-Signature'),
    );
  });

  it('preserves a query the endpoint already carries, and signs it', () => {
    const result = presignS3Request({
      ...minioRequest({ key: 'note.txt', endpoint: `${MINIO_ENDPOINT}?versionId=abc123` }),
      expiresSeconds: 60,
    });
    const url = new URL(result.url);
    expect(url.searchParams.get('versionId')).toBe('abc123');
    expect(referenceForPresignedUrl(result, 'minio-secret-key').signature).toBe(
      url.searchParams.get('X-Amz-Signature'),
    );
  });
});

describe('presignS3Request validation', () => {
  it('emits every required X-Amz-* parameter', () => {
    const result = presignS3Request({
      ...minioRequest({ key: 'receipt.jpg' }),
      expiresSeconds: 900,
    });
    const params = new URL(result.url).searchParams;
    expect(params.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(params.get('X-Amz-Credential')).toBe(
      'minio-access-key/20240102/eu-central-1/s3/aws4_request',
    );
    expect(params.get('X-Amz-Date')).toBe('20240102T030405Z');
    expect(params.get('X-Amz-Expires')).toBe('900');
    expect(params.get('X-Amz-SignedHeaders')).toBe('host');
    expect(params.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects an expiresSeconds below the accepted range', () => {
    expect(() =>
      presignS3Request({ ...minioRequest({ key: 'receipt.jpg' }), expiresSeconds: 0 }),
    ).toThrow(/expiresSeconds/);
  });

  it('rejects an expiresSeconds above the accepted range', () => {
    expect(() =>
      presignS3Request({ ...minioRequest({ key: 'receipt.jpg' }), expiresSeconds: 604801 }),
    ).toThrow(/604800/);
  });

  it('rejects an empty bucket', () => {
    expect(() =>
      presignS3Request({
        ...minioRequest({ key: 'receipt.jpg', bucket: '' }),
        expiresSeconds: 60,
      }),
    ).toThrow(/bucket/);
  });
});

describe('signS3Request', () => {
  it('adds x-amz-date, x-amz-content-sha256 and an Authorization header', () => {
    const result = signS3Request(
      minioRequest({
        method: 'DELETE',
        key: 'households/42/receipt 1.pdf',
        headers: { 'Content-Type': 'application/pdf' },
      }),
    );

    expect(result.method).toBe('DELETE');
    expect(result.url).toBe(
      'http://localhost:9000/finmate-attachments/households/42/receipt%201.pdf',
    );
    expect(result.headers['x-amz-date']).toBe('20240102T030405Z');
    expect(result.headers['x-amz-content-sha256']).toBe(EMPTY_SHA256);
    expect(result.headers['host']).toBe('localhost:9000');
    expect(result.headers['content-type']).toBe('application/pdf');
    expect(result.headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it('lists exactly the signed headers, lowercased and sorted, and names region and s3', () => {
    const result = signS3Request(
      minioRequest({
        method: 'PUT',
        key: 'note.txt',
        headers: { 'Content-Type': 'text/plain', 'X-Amz-Meta-Owner': 'household' },
      }),
    );
    const authorization = result.headers['authorization'] ?? '';
    const signed = /SignedHeaders=([^,]+), Signature=/.exec(authorization)?.[1] ?? '';

    expect(signed).toBe('content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-owner');
    expect(signed).toBe(signed.split(';').sort().join(';'));
    expect(signed).toBe(
      Object.keys(result.headers)
        .filter((name) => name !== 'authorization')
        .sort()
        .join(';'),
    );
    expect(authorization).toContain(
      'Credential=minio-access-key/20240102/eu-central-1/s3/aws4_request',
    );
  });

  it('self-verifies: recomputing from the result reproduces the Authorization signature', () => {
    const result = signS3Request(
      minioRequest({ method: 'HEAD', key: 'note.txt', headers: { 'Content-Type': 'text/plain' } }),
    );
    const reference = referenceForAuthorization(result, 'minio-secret-key');
    expect(reference.signature).toBe(reference.emittedSignature);
    // The final line of a canonical request is always the payload hash.
    expect(reference.canonicalRequest.split('\n').at(-1)).toBe(EMPTY_SHA256);
  });

  it('signs a caller-supplied payload hash instead of the empty-body one', () => {
    const bodyHash = sha256Hex(Buffer.from('receipt bytes', 'utf8'));
    const result = signS3Request({
      ...minioRequest({ method: 'PUT', key: 'receipt.jpg' }),
      payloadSha256: bodyHash,
    });
    expect(result.headers['x-amz-content-sha256']).toBe(bodyHash);
    const reference = referenceForAuthorization(result, 'minio-secret-key');
    expect(reference.signature).toBe(reference.emittedSignature);
    expect(reference.canonicalRequest.split('\n').at(-1)).toBe(bodyHash);
  });

  it('collapses whitespace in header values the way the canonical request requires', () => {
    const result = signS3Request(
      minioRequest({
        key: 'note.txt',
        headers: { 'Content-Type': '  text/plain   ; charset=utf-8 ' },
      }),
    );
    expect(result.headers['content-type']).toBe('text/plain ; charset=utf-8');
    const reference = referenceForAuthorization(result, 'minio-secret-key');
    expect(reference.signature).toBe(reference.emittedSignature);
  });

  it('rejects an empty bucket', () => {
    expect(() => signS3Request(minioRequest({ key: 'note.txt', bucket: '' }))).toThrow(/bucket/);
  });
});

describe('signS3Request bucket-level operations', () => {
  it('treats an empty key as the bucket itself, with no trailing slash', () => {
    const result = signS3Request(minioRequest({ method: 'PUT', key: '' }));

    expect(result.method).toBe('PUT');
    expect(result.url).toBe('http://localhost:9000/finmate-attachments');
    expect(result.url.endsWith('/finmate-attachments')).toBe(true);
    expect(result.headers['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=minio-access-key\/20240102\/eu-central-1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
    );

    // The canonical URI is /bucket, and the Authorization signature verifies against it.
    const reference = referenceForAuthorization(result, 'minio-secret-key');
    expect(reference.canonicalRequest.split('\n')[1]).toBe('/finmate-attachments');
    expect(reference.signature).toBe(reference.emittedSignature);
  });

  it('signs a bucket HEAD the same way, with the region in the credential scope', () => {
    const result = signS3Request(minioRequest({ method: 'HEAD', key: '', region: 'us-east-1' }));
    expect(result.url).toBe('http://localhost:9000/finmate-attachments');
    expect(result.headers['authorization']).toContain(
      'Credential=minio-access-key/20240102/us-east-1/s3/aws4_request',
    );
    const reference = referenceForAuthorization(result, 'minio-secret-key');
    expect(reference.signature).toBe(reference.emittedSignature);
  });
});

describe('determinism', () => {
  it('produces byte-identical output for identical inputs and the same now', () => {
    const request = minioRequest({ key: 'receipt.jpg', headers: { 'Content-Type': 'image/jpeg' } });

    const firstPresign = presignS3Request({ ...request, expiresSeconds: 900 });
    const secondPresign = presignS3Request({ ...request, expiresSeconds: 900 });
    expect(JSON.stringify(secondPresign)).toBe(JSON.stringify(firstPresign));

    const firstSign = signS3Request(request);
    const secondSign = signS3Request({ ...request, headers: { 'Content-Type': 'image/jpeg' } });
    expect(JSON.stringify(secondSign)).toBe(JSON.stringify(firstSign));
  });

  it('changes the signature when the key or the instant changes', () => {
    const base = minioRequest({ key: 'receipt.jpg' });
    const other = signS3Request(minioRequest({ key: 'other.jpg' }));
    expect(other.headers['authorization']).not.toBe(signS3Request(base).headers['authorization']);

    const later = signS3Request(
      minioRequest({ key: 'receipt.jpg', now: new Date('2024-01-02T03:04:06Z') }),
    );
    expect(later.headers['x-amz-date']).toBe('20240102T030406Z');
    expect(later.headers['authorization']).not.toBe(signS3Request(base).headers['authorization']);
  });
});
