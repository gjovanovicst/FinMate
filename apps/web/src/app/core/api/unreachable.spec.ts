import { describe, expect, it } from 'vitest';

import { isUnreachable, readHttpStatus } from './unreachable';

/**
 * The one definition of "nothing answered" (ADR-033).
 *
 * It is asserted directly because three modules now branch on it — the error messages, the auth store
 * and the guard that decides whether an unlocked install may reach its local data — and a `401` being
 * mistaken for an outage would open the offline shell over a revoked session.
 */
describe('isUnreachable', () => {
  it('treats a request that never arrived, and a proxy with no upstream, as unreachable', () => {
    for (const status of [0, 502, 503, 504]) {
      expect(isUnreachable({ status }), `status ${status}`).toBe(true);
    }
  });

  it('does not treat an answer as an outage', () => {
    // 401 in particular: it is how a revoke and an expired session arrive, and ADR-033 requires that
    // case to stay on the sign-in path.
    for (const status of [200, 400, 401, 403, 404, 409, 429, 500]) {
      expect(isUnreachable({ status }), `status ${status}`).toBe(false);
    }
  });

  it('is defensive about what it is handed', () => {
    // The outbox's own failures carry `status`, a GraphQL parse error does not; neither should throw.
    expect(isUnreachable(null)).toBe(false);
    expect(isUnreachable(undefined)).toBe(false);
    expect(isUnreachable('offline')).toBe(false);
    expect(isUnreachable(new Error('Failed to fetch'))).toBe(false);
    expect(isUnreachable({ status: '504' })).toBe(false);
    expect(readHttpStatus({ status: 0 })).toBe(0);
    expect(readHttpStatus({})).toBeNull();
  });
});
