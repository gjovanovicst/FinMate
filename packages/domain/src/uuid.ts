/**
 * UUIDv7 generation — time-ordered identifiers.
 *
 * docs/03-domain-model.md §3.3: primary keys are **UUIDv7 generated server-side**. The database
 * has no `DEFAULT gen_random_uuid()` on purpose:
 *
 *  - v7 is time-ordered, so an index on the primary key stays compact and insert-friendly. A v4
 *    UUID scatters writes across the whole B-tree, which is a real cost on a transactions table.
 *  - Generating in the application means an offline client can create a row (via `client_id`)
 *    whose identity is already known before it reaches the server, which is what makes the
 *    outbox/idempotency design in docs/05 §7 work.
 *
 * Layout (RFC 9562 §5.7):
 *   48 bits  unix_ts_ms   milliseconds since epoch, big-endian
 *    4 bits  version       0b0111
 *   12 bits  rand_a
 *    2 bits  variant       0b10
 *   62 bits  rand_b
 *
 * @module @finmate/domain
 */

/** Monotonic guard: two IDs generated in the same millisecond must still sort in call order. */
let lastTimestamp = -1;
let sequence = 0;

const MAX_SEQUENCE = 0xfff; // 12 bits of rand_a

/**
 * Generate a UUIDv7 string.
 *
 * Within a single millisecond, the 12-bit `rand_a` field is used as a counter so that IDs remain
 * strictly increasing — important when rows are inserted from the same event loop turn (bulk
 * capture can create several Transactions at once).
 */
export function uuidv7(now: number = Date.now()): string {
  const timestamp = Math.floor(now);

  if (timestamp === lastTimestamp) {
    sequence += 1;
    if (sequence > MAX_SEQUENCE) {
      // Counter exhausted inside one millisecond: borrow the next millisecond. Deterministic and
      // still monotonic, which matters more than strict wall-clock accuracy here.
      lastTimestamp += 1;
      sequence = 0;
    }
  } else {
    lastTimestamp = timestamp;
    sequence = 0;
  }

  const ts = BigInt(lastTimestamp);
  const bytes = new Uint8Array(16);

  // 48-bit big-endian timestamp.
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);

  // rand_a (12 bits) carries the in-millisecond sequence so ordering is guaranteed.
  bytes[6] = (sequence >> 8) & 0x0f;
  bytes[7] = sequence & 0xff;

  // rand_b (62 bits) is cryptographically random.
  const tail = new Uint8Array(8);
  globalThis.crypto.getRandomValues(tail);
  bytes.set(tail, 8);

  // version = 7
  bytes[6] = (bytes[6] ?? 0) | 0x70;
  // variant = 0b10
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  return toUuidString(bytes);
}

const HEX: readonly string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0'),
);

function toUuidString(bytes: Uint8Array): string {
  const h = (i: number): string => HEX[bytes[i] ?? 0] ?? '00';
  return (
    h(0) + h(1) + h(2) + h(3) + '-' +
    h(4) + h(5) + '-' +
    h(6) + h(7) + '-' +
    h(8) + h(9) + '-' +
    h(10) + h(11) + h(12) + h(13) + h(14) + h(15)
  );
}

/** Extract the millisecond timestamp encoded in a UUIDv7. Useful for debugging and tests. */
export function uuidv7Timestamp(uuid: string): number {
  const hex = uuid.replace(/-/g, '').slice(0, 12);
  return Number(BigInt('0x' + hex));
}
