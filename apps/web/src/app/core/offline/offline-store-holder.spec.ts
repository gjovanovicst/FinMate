// @vitest-environment jsdom
import 'fake-indexeddb/auto';

// FIRST import, deliberately: the JIT compiler must be loaded before the testing module is used.
import { initAngularTesting } from '@web-test/angular-testing';

import { TestBed } from '@angular/core/testing';
import { openDB } from 'idb';
import { afterEach, describe, expect, it } from 'vitest';

import { AppLockService } from '../app-lock/app-lock.service';
import { OFFLINE_DB_NAME, OFFLINE_DB_VERSION, OFFLINE_STORES, type OfflineRecord } from './offline-store';
import { OfflineStoreHolder } from './offline-store-holder';

initAngularTesting();

/**
 * Turning persistence on (ADR-025 decision 3, task 4.2.6a).
 *
 * The holder is where "the app lock turns persistence on with no data migration" becomes checkable: with
 * no lock the backing is the in-memory store, after arming it is IndexedDB, and locking again puts it
 * back. The `generation` bump is what stops a consumer caching a repository built for the other backing.
 */
const PIN = '123456';

function mount(): { holder: OfflineStoreHolder; lock: AppLockService } {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({});
  return {
    holder: TestBed.inject(OfflineStoreHolder),
    lock: TestBed.inject(AppLockService),
  };
}

async function rawRecordCount(): Promise<number> {
  const db = await openDB(OFFLINE_DB_NAME, OFFLINE_DB_VERSION, {
    upgrade(database) {
      for (const store of OFFLINE_STORES) {
        if (!database.objectStoreNames.contains(store)) database.createObjectStore(store, { keyPath: 'key' });
      }
    },
  });
  let count = 0;
  for (const store of OFFLINE_STORES) count += (await db.getAll(store as never)).length;
  db.close();
  return count;
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('OfflineStoreHolder', () => {
  it('builds an in-memory backing with no lock, and writes nothing to disk', async () => {
    const { holder, lock } = mount();
    await lock.refresh();

    const repository = await holder.repository();
    expect(repository.persistent).toBe(false);

    await repository.put('snapshot', 'probe', { anything: true }, 60_000);
    expect(await repository.get('snapshot', 'probe')).toEqual({ anything: true });
    // The claim ADR-025 decision 3 makes: nothing confidential reaches disk while there is no lock.
    expect(await rawRecordCount()).toBe(0);
  });

  it('switches to the durable backing when the lock is armed, and back when it is locked', async () => {
    const { holder, lock } = mount();
    await lock.refresh();

    const before = await holder.repository();
    const beforeGeneration = holder.generation();
    expect(before.persistent).toBe(false);

    expect(await lock.enableWithPin(PIN, 0)).toBe(true);

    const after = await holder.repository();
    expect(after.persistent).toBe(true);
    // A different object, and the generation moved: a consumer caching the old repository rebuilds.
    expect(after).not.toBe(before);
    expect(holder.generation()).toBeGreaterThan(beforeGeneration);

    // Now the same write is durable, which is the reason to arm the lock at all.
    await after.put('snapshot', 'probe', { anything: true }, 60_000);
    const stored = (await openDB(OFFLINE_DB_NAME, OFFLINE_DB_VERSION)).getAll('snapshot') as Promise<
      OfflineRecord[]
    >;
    expect(await stored).toHaveLength(1);

    lock.lock();

    const locked = await holder.repository();
    expect(locked.persistent).toBe(false);
    // Locked means the page cannot read what is on disk: the record is there and invisible.
    expect(await locked.get('snapshot', 'probe')).toBeNull();
  });

  it('wipes the durable records and rebuilds the backing on purge', async () => {
    const { holder, lock } = mount();
    await lock.refresh();
    await lock.enableWithPin(PIN, 0);

    const repository = await holder.repository();
    await repository.put('outbox', 'probe', { queued: true }, 60_000);
    expect(await rawRecordCount()).toBeGreaterThan(0);

    await lock.purge();

    expect(await rawRecordCount()).toBe(0);
    const afterPurge = await holder.repository();
    expect(afterPurge.persistent).toBe(false);
    expect(await afterPurge.get('outbox', 'probe')).toBeNull();
  });
});
