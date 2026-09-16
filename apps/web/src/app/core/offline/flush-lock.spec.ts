import { describe, expect, it, vi } from 'vitest';

import { FLUSH_LOCK_NAME, withFlushLock } from './flush-lock';

/**
 * Which tab flushes (ADR-026 decision 4, resolved in 4.2.6).
 *
 * The loser must **skip**, not queue behind the winner: waiting would send the same entries a moment
 * later, which is a second batch for a queue that is already being drained. And a browser without Web
 * Locks must still flush — a lock that cannot be taken must not mean a queue that never drains.
 */
function fakeLocks(granted: boolean) {
  return {
    request: vi.fn(async (_name: string, _options: unknown, callback: (lock: unknown) => unknown) =>
      callback(granted ? { name: FLUSH_LOCK_NAME } : null),
    ),
  } as unknown as LockManager;
}

describe('the cross-tab flush lock', () => {
  it('runs the pass when the lock is free, and asks for it exclusively', async () => {
    const locks = fakeLocks(true);
    const send = vi.fn(async () => 'sent');

    expect(await withFlushLock(locks, send)).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
    expect(locks.request).toHaveBeenCalledWith(
      FLUSH_LOCK_NAME,
      { mode: 'exclusive', ifAvailable: true },
      expect.any(Function),
    );
  });

  it('skips the pass entirely when another tab holds the lock', async () => {
    const send = vi.fn(async () => 'sent');

    expect(await withFlushLock(fakeLocks(false), send)).toBeNull();
    // Not "sent twice slowly": not sent at all.
    expect(send).not.toHaveBeenCalled();
  });

  it('runs without Web Locks, because a single tab is the supported configuration', async () => {
    const send = vi.fn(async () => 'sent');

    expect(await withFlushLock(undefined, send)).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
