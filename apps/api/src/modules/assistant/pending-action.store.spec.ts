import { describe, expect, it } from 'vitest';

import type { RedisService } from '../../common/redis/redis.service';
import {
  PendingActionStore,
  PROPOSAL_TTL_SECONDS,
  type ExecutedActionResult,
  type PendingActionProposal,
} from './pending-action.store';

/**
 * An in-memory stand-in for the two Redis commands this store uses, so the policy is tested without
 * infrastructure — the same approach `rate-limit.service.spec.ts` takes for the limiter.
 *
 * `GETDEL` is simulated honestly (read **and** delete in one step) because atomic consumption is the
 * property under test: a fake that read then deleted in two calls would pass a test the real store
 * could fail.
 */
function fakeRedis(): {
  service: RedisService;
  store: Map<string, string>;
  expireArgs: { key: string; ttl: number }[];
  state: { fail: boolean };
} {
  const store = new Map<string, string>();
  const expireArgs: { key: string; ttl: number }[] = [];
  const state = { fail: false };

  const client = {
    set: async (key: string, value: string, mode: string, ttl: number): Promise<'OK'> => {
      if (state.fail) throw new Error('redis unavailable');
      store.set(key, value);
      if (mode === 'EX') expireArgs.push({ key, ttl });
      return 'OK';
    },
    getdel: async (key: string): Promise<string | null> => {
      if (state.fail) throw new Error('redis unavailable');
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    },
    get: async (key: string): Promise<string | null> => {
      if (state.fail) throw new Error('redis unavailable');
      return store.get(key) ?? null;
    },
  };

  return { service: { client } as unknown as RedisService, store, expireArgs, state };
}

function proposal(overrides: Partial<PendingActionProposal> = {}): PendingActionProposal {
  return {
    id: 'p1',
    householdId: 'h1',
    userId: 'u1',
    action: 'ADD_CATEGORY',
    slots: { name: 'Putovanja', kind: 'EXPENSE' },
    preview: { sentence: 'Nova kategorija „Putovanja” (rashod, bez nadređene)', diff: [] },
    createdAt: '2026-09-17T00:00:00.000Z',
    ...overrides,
  };
}

const result: ExecutedActionResult = {
  action: 'ADD_CATEGORY',
  createdId: 'c1',
  createdLabel: 'Putovanja',
  undo: 'SOFT_DELETE',
  sentence: 'Nova kategorija „Putovanja” (rashod, bez nadređene)',
  executedAt: '2026-09-17T00:01:00.000Z',
};

describe('PendingActionStore (ADR-035 decision 6)', () => {
  it('stores a proposal under a household-scoped key with a TTL', async () => {
    const { service, expireArgs } = fakeRedis();

    expect(await new PendingActionStore(service).put(proposal())).toBe(true);

    expect(expireArgs).toEqual([{ key: 'assistant:action:proposal:h1:p1', ttl: PROPOSAL_TTL_SECONDS }]);
  });

  it('consumes the proposal on take, so two confirms cannot both proceed', async () => {
    const { service } = fakeRedis();
    const store = new PendingActionStore(service);
    await store.put(proposal());

    const first = await store.take('h1', 'p1');
    const second = await store.take('h1', 'p1');

    expect(first?.slots['name']).toBe('Putovanja');
    expect(second).toBeNull();
  });

  it('cannot reach another Household\'s proposal', async () => {
    const { service } = fakeRedis();
    const store = new PendingActionStore(service);
    await store.put(proposal({ householdId: 'h1' }));

    expect(await store.take('h2', 'p1')).toBeNull();
  });

  it('refuses to store, and to read back, while Redis is down — it fails closed', async () => {
    const { service, state } = fakeRedis();
    const store = new PendingActionStore(service);

    state.fail = true;
    expect(await store.put(proposal())).toBe(false);
    expect(await store.take('h1', 'p1')).toBeNull();

    // And a proposal stored before the outage is still retrieved once Redis returns.
    state.fail = false;
    await store.put(proposal());
    expect((await store.take('h1', 'p1'))?.id).toBe('p1');
  });

  it('treats an unrecognisable blob as no proposal rather than casting it', async () => {
    // The shape check is what stops a value written by an older build from being executed by this one.
    const { service, store } = fakeRedis();
    store.set('assistant:action:proposal:h1:p1', JSON.stringify({ id: 'p1' }));

    expect(await new PendingActionStore(service).take('h1', 'p1')).toBeNull();
  });

  it('remembers an outcome against the idempotency key, so a retry is not a second write', async () => {
    const { service } = fakeRedis();
    const store = new PendingActionStore(service);

    expect(await store.recallResult('h1', 'k1')).toBeNull();
    await store.rememberResult('h1', 'k1', result);

    expect((await store.recallResult('h1', 'k1'))?.createdId).toBe('c1');
    // Scoped to the Household, like the proposal itself.
    expect(await store.recallResult('h2', 'k1')).toBeNull();
  });
});
