// @vitest-environment jsdom
// `OfflineStoreHolder` builds a repository on first use, and the app lock it asks for its durability
// reads IndexedDB at bootstrap — so this spec needs a DOM, and it stays on the in-memory backing
// (no `fake-indexeddb`) because that is the backing a store with no lock gets (ADR-025 decision 3).
import { initAngularTesting } from '@web-test/angular-testing';

import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { TAXONOMY_TTL_MS } from './offline-store';
import { OfflineStoreHolder } from './offline-store-holder';
import { TAXONOMY_ACCOUNTS_KEY, TAXONOMY_CATEGORIES_KEY, TaxonomyService } from './taxonomy.service';

initAngularTesting();

/**
 * The taxonomy cache (ADR-025 decision 5, R-27(a2)).
 *
 * The record exists because the composer cannot work without it: offline, `accountId` stays empty, the
 * commit sends `defaultAccountId: null`, and the server refuses the whole batch. What is asserted here
 * is the record's own contract — the round trip, the whitelist, and that a miss is a miss.
 */
const ACCOUNT = { id: 'acct-1', name: 'Everyday', currency: 'RSD', isArchived: false };
const CATEGORY = { id: 'cat-food', name: 'Hrana', kind: 'EXPENSE' as const, parentId: null };

function mount(): TaxonomyService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({});
  return TestBed.inject(TaxonomyService);
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('TaxonomyService', () => {
  it('round-trips both lists, with the moment they were read', async () => {
    const taxonomy = mount();

    await taxonomy.writeAccounts([ACCOUNT]);
    await taxonomy.writeCategories([CATEGORY]);

    const accounts = await taxonomy.readAccounts();
    expect(accounts?.accounts).toEqual([ACCOUNT]);
    expect(Number.isNaN(Date.parse(accounts?.syncedAt ?? ''))).toBe(false);
    expect((await taxonomy.readCategories())?.categories).toEqual([CATEGORY]);
  });

  it('returns null rather than an empty list when nothing was ever cached', async () => {
    const taxonomy = mount();

    // The distinction matters to the caller: `null` means "fall back to nothing and keep the live
    // error", while an empty list would read as "this Household has no accounts" and change the screen.
    expect(await taxonomy.readAccounts()).toBeNull();
    expect(await taxonomy.readCategories()).toBeNull();
  });

  it('stores the whitelist, not whatever object the caller had in hand', async () => {
    const taxonomy = mount();
    const wireRow = { ...ACCOUNT, balance: { amountMinor: '12345', currency: 'RSD' }, extra: 'secret' };

    // A wire row's *type* carries more fields, and TypeScript's excess-property check does not apply
    // to a variable — so the mapper is the guard, not the compiler.
    await taxonomy.writeAccounts([wireRow]);

    const [stored] = (await taxonomy.readAccounts())?.accounts ?? [];
    expect(stored).toEqual(ACCOUNT);
    expect(Object.keys(stored ?? {}).sort()).toEqual(['currency', 'id', 'isArchived', 'name']);
  });

  it('writes into the taxonomy store, one record per list', async () => {
    const taxonomy = mount();
    const repository = await TestBed.inject(OfflineStoreHolder).repository();

    await taxonomy.writeAccounts([ACCOUNT]);
    await taxonomy.writeCategories([CATEGORY]);

    expect(await repository.get('taxonomy', TAXONOMY_ACCOUNTS_KEY)).not.toBeNull();
    expect(await repository.get('taxonomy', TAXONOMY_CATEGORIES_KEY)).not.toBeNull();
    // 24 h, the store's own reference-record TTL (see the service header for why it is not longer).
    expect(TAXONOMY_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});
