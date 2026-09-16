import { createHash, createHmac } from 'node:crypto';

/**
 * A dependency-free AWS Signature Version 4 signer (S3 flavour), used by the files module to hand a
 * browser a single-use URL that PUTs an object straight to S3/MinIO and to sign the bucket
 * operations the API itself performs (HEAD/DELETE/PUT).
 *
 * It is deliberately a pure function module: no NestJS, no Prisma, no client — crypto is
 * `node:crypto` only, so it can be unit-tested in isolation and the test vector below can be
 * checked against AWS's own published example.
 *
 * S3 is the one service whose canonical URI is **not** normalised: the object key's `/` are path
 * separators, and a `%2F` inside a key means something else, so the key is encoded segment by
 * segment and the separators are kept.
 */

export interface SigV4Request {
  readonly method: 'GET' | 'PUT' | 'HEAD' | 'DELETE' | 'POST';
  /** Base URL, e.g. `http://localhost:9000` or `https://s3.eu-central-1.amazonaws.com`. May carry a path prefix; the bucket is appended as a path segment (path-style addressing). */
  readonly endpoint: string;
  readonly bucket: string;
  /** Object key, may contain `/`. Must be URI-encoded segment-by-segment for the canonical URI and the final URL. Empty for a bucket-level operation. */
  readonly key: string;
  readonly region: string;
  readonly accessKey: string;
  readonly secretKey: string;
  /** Injected so tests are deterministic. */
  readonly now: Date;
  /** Headers the caller will send; all of them are signed. `host` is derived and must not be passed. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface PresignedRequest {
  readonly url: string;
  readonly method: string;
  /** Exactly the headers the client must send (host included), values as sent. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * RFC 3986 unreserved characters — the only ones AWS leaves unencoded.
 *
 * Everything else in a key (`+`, `=`, `&`, `,`, `:`, `@`, space, …) must be percent-encoded with
 * uppercase hex, because a raw `+` in a query string is read as a space by many servers and a raw
 * `&`/`=` splits the parameters.
 */
const UNRESERVED = /[A-Za-z0-9\-_.~]/;

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
const TERMINATOR = 'aws4_request';
/** AWS refuses an `X-Amz-Expires` outside this range (docs: 1..604800 seconds). */
const MIN_EXPIRES_SECONDS = 1;
const MAX_EXPIRES_SECONDS = 604800;
/** S3 accepts this literal for query-string authentication when the client cannot hash a body. */
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

interface QueryPair {
  readonly name: string;
  readonly value: string;
}

/** Percent-encode one string per RFC 3986, byte by byte so multi-byte UTF-8 is encoded correctly. */
function rfc3986Encode(value: string): string {
  let encoded = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const character = String.fromCharCode(byte);
    encoded += UNRESERVED.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return encoded;
}

/**
 * AWS canonicalises header values by trimming and collapsing internal whitespace runs to one
 * space; a client that sends `a   b` and one that sends `a b` must produce the same signature.
 */
function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * The canonical URI always starts at the bucket: `<endpoint path prefix>/<bucket>/<key>`, each
 * segment encoded on its own so the key's `/` survive as separators.
 *
 * An empty key is a **bucket-level** operation (`PUT /bucket` creates it, `HEAD /bucket` checks
 * it), so it contributes no segment at all: the URI is `/bucket`, never `/bucket/`.
 */
function canonicalPath(endpointPath: string, bucket: string, key: string): string {
  const prefix = endpointPath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(rfc3986Encode);
  const keySegments = key.length === 0 ? [] : key.split('/').map(rfc3986Encode);
  return `/${[...prefix, rfc3986Encode(bucket), ...keySegments].join('/')}`;
}

/** Query parameters the endpoint already carries. `URLSearchParams` has already decoded them. */
function endpointQuery(url: URL): QueryPair[] {
  const pairs: QueryPair[] = [];
  url.searchParams.forEach((value, name) => {
    pairs.push({ name, value });
  });
  return pairs;
}

/**
 * The canonical query string, sorted by name in byte order and encoded on both sides. Sorting is
 * over the **encoded** names AWS-side; every name here is ASCII, so code-unit order is byte order.
 */
function canonicalQuery(pairs: readonly QueryPair[]): string {
  return [...pairs]
    .sort((left, right) => {
      if (left.name !== right.name) {
        return left.name < right.name ? -1 : 1;
      }
      if (left.value === right.value) {
        return 0;
      }
      return left.value < right.value ? -1 : 1;
    })
    .map((pair) => `${rfc3986Encode(pair.name)}=${rfc3986Encode(pair.value)}`)
    .join('&');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** The `AWS4<secret>` → date → region → service → terminator key chain. */
function signingKey(secretKey: string, date: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretKey}`, date), region), SERVICE), TERMINATOR);
}

function sortedHeaderNames(headers: Readonly<Record<string, string>>): string[] {
  return Object.keys(headers).sort();
}

/**
 * `METHOD\n<canonical URI>\n<canonical query>\n<canonical headers>\n<signed headers>\n<payload hash>`
 * — with the canonical headers already newline-terminated, so joining on `\n` leaves the blank line
 * that separates them from the signed-header list.
 */
function buildCanonicalRequest(
  method: string,
  path: string,
  query: string,
  headers: Readonly<Record<string, string>>,
  payloadHash: string,
): string {
  const names = sortedHeaderNames(headers);
  const canonicalHeaders = names.map((name) => `${name}:${headers[name] ?? ''}\n`).join('');
  return [method, path, query, canonicalHeaders, names.join(';'), payloadHash].join('\n');
}

function requireBucket(bucket: string): void {
  if (bucket.length === 0) {
    throw new Error('bucket must not be empty');
  }
}

function hostOf(url: URL): string {
  // Derived, never caller-supplied: `Host` is what the client's HTTP stack actually sends, so a
  // caller-provided value would be signed while a different one goes on the wire.
  return url.host;
}

/**
 * Lowercased name → canonical value for every header that will be signed. The derived `host` and
 * the signer's own `x-amz-*` headers are applied last so they always win.
 */
function signedHeaderMap(
  host: string,
  callerHeaders: Readonly<Record<string, string>> | undefined,
  ownHeaders: Readonly<Record<string, string>>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [name, value] of Object.entries(callerHeaders ?? {})) {
    map[name.toLowerCase()] = canonicalHeaderValue(value);
  }
  map['host'] = host;
  for (const [name, value] of Object.entries(ownHeaders)) {
    map[name.toLowerCase()] = value;
  }
  return map;
}

/** Hex SHA-256 of a buffer — exported because the files module records `attachments.sha256`. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** `YYYYMMDDTHHMMSSZ` and `YYYYMMDD` for the `x-amz-date`/credential scope. Exported for tests. */
export function amzDates(now: Date): { readonly dateTime: string; readonly date: string } {
  // `toISOString` is UTC by definition, which is what SigV4 requires regardless of the server TZ.
  const iso = now.toISOString();
  const date = iso.slice(0, 10).replace(/-/g, '');
  const time = iso.slice(11, 19).replace(/:/g, '');
  return { dateTime: `${date}T${time}Z`, date };
}

/**
 * Presign a single-use URL. `expiresSeconds` becomes `X-Amz-Expires` (AWS accepts 1..604800).
 *
 * The payload is signed as `UNSIGNED-PAYLOAD`: a browser cannot compute a hash of a body it has not
 * sent yet, and S3 accepts that literal for query-string authentication.
 */
export function presignS3Request(
  request: SigV4Request & { readonly expiresSeconds: number },
): PresignedRequest {
  const { method, endpoint, bucket, key, region, accessKey, secretKey, now, headers } = request;
  const { expiresSeconds } = request;

  if (
    !Number.isInteger(expiresSeconds) ||
    expiresSeconds < MIN_EXPIRES_SECONDS ||
    expiresSeconds > MAX_EXPIRES_SECONDS
  ) {
    throw new Error(
      `expiresSeconds must be an integer between ${MIN_EXPIRES_SECONDS} and ${MAX_EXPIRES_SECONDS}, got ${expiresSeconds}`,
    );
  }
  requireBucket(bucket);

  const url = new URL(endpoint);
  const { dateTime, date } = amzDates(now);
  const scope = `${date}/${region}/${SERVICE}/${TERMINATOR}`;
  const path = canonicalPath(url.pathname, bucket, key);

  const headerMap = signedHeaderMap(hostOf(url), headers, {});
  // The signed-header list is needed by the query before the canonical request is hashed, so it is
  // derived here and the canonical request recomputes the identical list from the identical map.
  const signedHeaderList = sortedHeaderNames(headerMap).join(';');

  const query = canonicalQuery([
    ...endpointQuery(url),
    { name: 'X-Amz-Algorithm', value: ALGORITHM },
    { name: 'X-Amz-Credential', value: `${accessKey}/${scope}` },
    { name: 'X-Amz-Date', value: dateTime },
    { name: 'X-Amz-Expires', value: String(expiresSeconds) },
    { name: 'X-Amz-SignedHeaders', value: signedHeaderList },
  ]);

  const canonicalRequest = buildCanonicalRequest(method, path, query, headerMap, UNSIGNED_PAYLOAD);
  const stringToSign = [ALGORITHM, dateTime, scope, sha256Hex(Buffer.from(canonicalRequest))].join(
    '\n',
  );
  const signatureHex = createHmac('sha256', signingKey(secretKey, date, region))
    .update(stringToSign, 'utf8')
    .digest('hex');

  return {
    url: `${url.origin}${path}?${query}&X-Amz-Signature=${signatureHex}`,
    method,
    headers: headerMap,
  };
}

/** Sign a request the server itself will send. Returns the URL and the headers to send. */
export function signS3Request(
  request: SigV4Request & {
    /** Hex SHA-256 of the body, or of the empty string when there is no body. Defaults to the empty-string hash. */
    readonly payloadSha256?: string;
  },
): PresignedRequest {
  const { method, endpoint, bucket, key, region, accessKey, secretKey, now, headers } = request;
  const { payloadSha256 } = request;

  requireBucket(bucket);

  const url = new URL(endpoint);
  const { dateTime, date } = amzDates(now);
  const scope = `${date}/${region}/${SERVICE}/${TERMINATOR}`;
  const payloadHash = payloadSha256 ?? sha256Hex(new Uint8Array(0));
  const path = canonicalPath(url.pathname, bucket, key);

  const headerMap = signedHeaderMap(hostOf(url), headers, {
    'x-amz-date': dateTime,
    'x-amz-content-sha256': payloadHash,
  });
  const signedHeaderList = sortedHeaderNames(headerMap).join(';');
  const query = canonicalQuery(endpointQuery(url));

  const canonicalRequest = buildCanonicalRequest(method, path, query, headerMap, payloadHash);
  const stringToSign = [ALGORITHM, dateTime, scope, sha256Hex(Buffer.from(canonicalRequest))].join(
    '\n',
  );
  const signatureHex = createHmac('sha256', signingKey(secretKey, date, region))
    .update(stringToSign, 'utf8')
    .digest('hex');

  return {
    url: query.length > 0 ? `${url.origin}${path}?${query}` : `${url.origin}${path}`,
    method,
    headers: {
      ...headerMap,
      authorization:
        `${ALGORITHM} Credential=${accessKey}/${scope}, ` +
        `SignedHeaders=${signedHeaderList}, Signature=${signatureHex}`,
    },
  };
}
