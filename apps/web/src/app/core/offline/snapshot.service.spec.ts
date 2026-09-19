// @vitest-environment jsdom
// FIRST import, deliberately: it loads the JIT compiler before any other Angular import (docs/15 §9).
// The spec is not a pure one: it mounts Angular services through `TestBed`.
import { initAngularTesting } from '@web-test/angular-testing';

import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GraphqlClient } from '../graphql/graphql.client';
import { OFFLINE_KEY_PROVIDER } from './offline-key-provider';
import { OfflineStoreHolder } from './offline-store-holder';
import { DASHBOARD_SNAPSHOT_KEY, SnapshotService, type DashboardFigures } from './snapshot.service';
import { SyncService } from './sync.service';
import type { CaptureCommitInput, CapturePreviewRow } from './sync.types';

initAngularTesting();

/**
 * The dashboard snapshot (ADR-027).
 *
 * Three things are asserted that the store's own spec cannot: the record is round-tripped whole, an
 * expired one reads as absent *without* labelling anything, and one `purge()` on the app's own
 * repository clears the snapshot **and** the queue — which is only true because both services inject
 * the same store (`OfflineStoreHolder`, ADR-027 decision 6).
 *
 * The store is the in-memory backing (`persistent: false`), which is also what the app gets until the
 * app lock ships (ADR-025 decision 3).
 */
const FIGURES: DashboardFigures = {
  today: '2026-09-14',
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
  daysElapsed: 14,
  daysInMonth: 30,
  safeToSpendToday: { amountMinor: '235000', currency: 'RSD' },
  available: { amountMinor: '1455000', currency: 'RSD' },
  isOverspent: false,
  spentThisMonth: { amountMinor: '6845000', currency: 'RSD' },
  incomeThisMonth: { amountMinor: '12000000', currency: 'RSD' },
  monthlyBudget: { amountMinor: '12000000', currency: 'RSD' },
  projectedTotal: { amountMinor: '14400000', currency: 'RSD' },
  projectedOverrun: null,
  paceIsReliable: true,
  needsReviewCount: 2,
};

const INPUT: CaptureCommitInput = {
  parseId: 'parse-1',
  rows: [
    {
      clientRowId: 'r1',
      idempotencyKey: 'i1',
      clientId: 'c1',
      kind: 'EXPENSE',
      amount: { amountMinor: '200000', currency: 'RSD' },
      categoryId: null,
      description: 'Lidl',
      occurredOn: '2026-09-14',
      acceptedProposalId: 'p1',
      merchantId: null,
      counterpartyId: null,
      confirmDespiteLowConfidence: false,
    },
  ],
  defaultAccountId: 'acct-1',
  occurredLocalDate: null,
  discardProposalIds: [],
  allowAi: true,
};

const PREVIEW: readonly CapturePreviewRow[] = [
  { clientRowId: 'r1', rawText: 'Lidl 2000', localCategoryId: null, localCategoryName: null },
];

function mount(): {
  readonly snapshot: SnapshotService;
  readonly stores: OfflineStoreHolder;
  readonly sync: SyncService;
} {
  TestBed.configureTestingModule({
    providers: [
      { provide: GraphqlClient, useValue: { query: vi.fn().mockResolvedValue({}) } },
      {
        provide: OFFLINE_KEY_PROVIDER,
        // The in-memory backing never asks for this key (ADR-025 decision 3).
        useValue: { persistent: false, dataKey: () => Promise.reject(new Error('not used')) },
      },
    ],
  });

  return {
    snapshot: TestBed.inject(SnapshotService),
    stores: TestBed.inject(OfflineStoreHolder),
    sync: TestBed.inject(SyncService),
  };
}

describe('SnapshotService', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('round-trips the dashboard figures with the moment they were read', async () => {
    const { snapshot } = mount();

    await snapshot.writeDashboard(FIGURES);
    const record = await snapshot.readDashboard();

    // The server's payload verbatim: no field dropped, none recomputed, `null`s intact.
    expect(record?.figures).toEqual(FIGURES);
    expect(Number.isNaN(Date.parse(record?.syncedAt ?? ''))).toBe(false);

    // Reading a snapshot is what marks the figures stale (ADR-027 decision 2).
    expect(snapshot.staleAt()).toBe(record?.syncedAt);
  });

  it('clears the stale mark when a live read is written', async () => {
    const { snapshot } = mount();
    await snapshot.writeDashboard(FIGURES);
    await snapshot.readDashboard();
    expect(snapshot.staleAt()).not.toBeNull();

    await snapshot.writeDashboard(FIGURES);

    expect(snapshot.staleAt()).toBeNull();
  });

  it('reads an expired record as null, and labels nothing', async () => {
    const { snapshot, stores } = mount();
    // The store's own TTL boundary: a record whose expiry has already passed is invisible.
    await (await stores.repository()).put(
      'snapshot',
      DASHBOARD_SNAPSHOT_KEY,
      { syncedAt: '2026-09-14T10:00:00.000Z', figures: FIGURES },
      -1,
    );

    expect(await snapshot.readDashboard()).toBeNull();
    expect(snapshot.staleAt()).toBeNull();
  });

  it('clears the snapshot and the queue with one purge, because both live in the one store', async () => {
    const { snapshot, stores, sync } = mount();
    await snapshot.writeDashboard(FIGURES);
    await sync.enqueueCapture(INPUT, PREVIEW);
    expect(sync.pendingCount()).toBe(1);

    await (await stores.repository()).purge();

    expect(await snapshot.readDashboard()).toBeNull();
    await sync.refresh();
    expect(sync.pendingCount()).toBe(0);
  });
});
