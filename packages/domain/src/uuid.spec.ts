import { describe, expect, it } from 'vitest';

import { uuidv7, uuidv7Timestamp } from './uuid';

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7 (docs/03 §3.3 — time-ordered keys generated server-side)', () => {
  it('produces a well-formed RFC 9562 version 7 UUID', () => {
    expect(uuidv7()).toMatch(UUID_V7_PATTERN);
  });

  it('encodes the timestamp it was given, so index locality is real', () => {
    const now = 1_760_000_000_000; // 2025-10-09
    expect(uuidv7Timestamp(uuidv7(now))).toBe(now);
  });

  it('is strictly increasing within a single millisecond', () => {
    // Bulk capture creates several Transactions in one event-loop turn; without the in-ms
    // counter these would sort arbitrarily and defeat the point of v7.
    const now = 1_760_000_000_000;
    const ids = Array.from({ length: 50 }, () => uuidv7(now));
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is increasingly ordered across milliseconds', () => {
    const a = uuidv7(1_760_000_000_000);
    const b = uuidv7(1_760_000_000_001);
    expect(a < b).toBe(true);
  });

  it('does not collide across many generations', () => {
    const ids = new Set(Array.from({ length: 5_000 }, () => uuidv7()));
    expect(ids.size).toBe(5_000);
  });
});
