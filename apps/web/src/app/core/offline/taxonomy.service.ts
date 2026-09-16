/**
 * The taxonomy cache: the categories and accounts the composer needs, so a capture works offline.
 *
 * ADR-025 decision 5 names this record — *"the taxonomy cache (the categories and accounts the composer
 * needs)"* — and `offline-store.ts` has carried the `taxonomy` object store since 4.2.2 with **no writer**.
 * 4.3.6 measured what that cost: offline the composer's `accounts` query fails, `accountId` stays empty,
 * `commit()` sends `defaultAccountId: null`, and the server **refuses the whole atomic batch** — so an
 * offline capture could not land however long the user waited (R-27(a2)). This is the missing writer.
 *
 * What is stored is exactly what the screen renders, through a whitelist mapper: an account's id, name,
 * currency and archived flag; a category's id, name, kind and parent. **Nothing here is a figure**, so
 * nothing here needs the `podaci od <time>` label ADR-027 decision 2 requires of a *number* — a reference
 * list read yesterday is the list the server would send, and the screen's own error state already says the
 * server is unreachable. The record keeps `syncedAt` so a future screen can say when, without this one
 * having to invent copy for it.
 *
 * The TTL is {@link TAXONOMY_TTL_MS} — the store's own 24 h, the same as the snapshot's. Whether a
 * reference list should live longer than a figure is a decision nobody has made; it is recorded in
 * docs/09's 4.3.6 row rather than changed here.
 *
 * See ADR-025 decisions 3, 5 and 6, docs/08 §3.9, docs/02 §4.3 and R-27(a2).
 *
 * @module apps/web/src/app/core/offline
 */
import { Injectable, inject } from '@angular/core';

import { TAXONOMY_TTL_MS } from './offline-store';
import { OfflineStoreHolder } from './offline-store-holder';

/** The taxonomy store's two records. */
export const TAXONOMY_ACCOUNTS_KEY = 'accounts';
export const TAXONOMY_CATEGORIES_KEY = 'categories';

/**
 * One account, as the composer's picker needs it.
 *
 * The same four fields `AccountNode` in the capture screen declares, and no more: an offline record is
 * a minimised copy (docs/08 §3.9), not a cache of the wire model.
 */
export interface TaxonomyAccount {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly isArchived: boolean;
}

/** One category, as the composer's picker and its preview need it. */
export interface TaxonomyCategory {
  readonly id: string;
  readonly name: string;
  readonly kind: 'EXPENSE' | 'INCOME';
  readonly parentId: string | null;
}

/** What sits in the `taxonomy` store under {@link TAXONOMY_ACCOUNTS_KEY}. */
export interface AccountsTaxonomy {
  readonly syncedAt: string;
  readonly accounts: readonly TaxonomyAccount[];
}

/** What sits in the `taxonomy` store under {@link TAXONOMY_CATEGORIES_KEY}. */
export interface CategoriesTaxonomy {
  readonly syncedAt: string;
  readonly categories: readonly TaxonomyCategory[];
}

@Injectable({ providedIn: 'root' })
export class TaxonomyService {
  private readonly stores = inject(OfflineStoreHolder);

  /**
   * Cache the account list a **successful** read just returned.
   *
   * Called after the server answered, never on a timer (the rule ADR-027 decision 6 sets for the
   * snapshot, for the same reason: a background timer in a PWA is a promise iOS does not keep).
   */
  async writeAccounts(accounts: readonly TaxonomyAccount[]): Promise<void> {
    const record: AccountsTaxonomy = {
      syncedAt: new Date().toISOString(),
      accounts: accounts.map(toAccount),
    };
    await (await this.stores.repository()).put(
      'taxonomy',
      TAXONOMY_ACCOUNTS_KEY,
      record,
      TAXONOMY_TTL_MS,
    );
  }

  /** The last account list, or `null` when there is none or it has expired (the store filters expiry). */
  async readAccounts(): Promise<AccountsTaxonomy | null> {
    const repository = await this.stores.repository();
    const record = await repository.get<AccountsTaxonomy>('taxonomy', TAXONOMY_ACCOUNTS_KEY);
    return record ?? null;
  }

  /** Cache the category list a successful read just returned. See {@link writeAccounts}. */
  async writeCategories(categories: readonly TaxonomyCategory[]): Promise<void> {
    const record: CategoriesTaxonomy = {
      syncedAt: new Date().toISOString(),
      categories: categories.map(toCategory),
    };
    await (await this.stores.repository()).put(
      'taxonomy',
      TAXONOMY_CATEGORIES_KEY,
      record,
      TAXONOMY_TTL_MS,
    );
  }

  /** The last category list, or `null`. See {@link readAccounts}. */
  async readCategories(): Promise<CategoriesTaxonomy | null> {
    const repository = await this.stores.repository();
    const record = await repository.get<CategoriesTaxonomy>('taxonomy', TAXONOMY_CATEGORIES_KEY);
    return record ?? null;
  }
}

/**
 * The account whitelist.
 *
 * A mapper rather than storing the caller's object: a caller with a wire row in hand passes an object
 * whose *type* has more fields, and TypeScript's excess-property check only applies to a literal. This is
 * the one place the record's shape is decided, so a field added to the wire model cannot ride into disk.
 */
function toAccount(account: TaxonomyAccount): TaxonomyAccount {
  return {
    id: account.id,
    name: account.name,
    currency: account.currency,
    isArchived: account.isArchived,
  };
}

/** The category whitelist. See {@link toAccount}. */
function toCategory(category: TaxonomyCategory): TaxonomyCategory {
  return {
    id: category.id,
    name: category.name,
    kind: category.kind,
    parentId: category.parentId,
  };
}
