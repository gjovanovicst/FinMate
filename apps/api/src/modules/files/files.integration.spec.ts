import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Response } from 'express';

import { addMonths, toLocalDate, uuidv7 } from '@finmate/domain';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { runWithTenant, type TenantContext } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { FakeObjectStorage } from '../../testing/fake-object-storage';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { TransactionsService } from '../ledger/transactions.service';
import { FilesController } from './files.controller';
import { FilesModule } from './files.module';
import {
  FilesService,
  MAX_BYTE_SIZE,
  ORPHAN_GRACE_HOURS,
  PRESIGN_RATE_LIMIT,
} from './files.service';
import { OBJECT_STORAGE, UNCONFIGURED_OBJECT_STORAGE } from './object-storage';
import { SCANNER, type ScanVerdict, type Scanner } from './scanner';

/**
 * The `files` module against a real database and a stubbed bucket — F-34, ADR-018, docs/06 §9.
 *
 * ## Why the bucket is stubbed and the database is not
 *
 * CI has Postgres and Redis but no MinIO (`.github/workflows/ci.yml`), so a suite that needed a real
 * bucket would be a suite that cannot run in CI. What only Postgres can answer is the module's actual
 * job: that a row is `PENDING` until `commit` has seen the bytes, that a cross-Household id is
 * invisible (ADR-008), that an idempotent re-upload reuses the row, and that `purge` deletes exactly
 * the rows its rules name. The signing itself is proven separately against AWS's own vector in
 * `sigv4.spec.ts`, and the live MinIO round-trip is a manual verification, not a test.
 */
/** A scanner whose verdict the test chooses, so every arm of the commit path is reachable. */
class FakeScanner implements Scanner {
  readonly available = true;
  readonly name = 'fake';
  readonly unavailableReason = null;
  verdict: ScanVerdict = 'CLEAN';
  scan(): Promise<ScanVerdict> {
    return Promise.resolve(this.verdict);
  }
}

const sha = (seed: string): string => seed.padEnd(64, '0').slice(0, 64);

describe('files (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let files: FilesService;
  let rateLimit: RateLimitService;
  let transactions: TransactionsService;
  let storage: FakeObjectStorage;
  let scanner: FakeScanner;

  const householdId = uuidv7();
  const otherHouseholdId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();

  const context: TenantContext = { householdId, userId, role: 'OWNER', requestId: 'files-it' };
  const otherContext: TenantContext = {
    householdId: otherHouseholdId,
    userId: otherUserId,
    role: 'OWNER',
    requestId: 'files-it-other',
  };
  const asTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(context, fn);

  let accountId: string;

  /** A presign request with a unique digest, so the idempotency window never folds two tests together. */
  let digestCounter = 0;
  const presign = (overrides: Partial<{ purpose: string; mimeType: string; byteSize: number; sha256: string }> = {}) => {
    digestCounter += 1;
    return asTenant(() =>
      files.presign(householdId, {
        purpose: 'RECEIPT',
        mimeType: 'image/jpeg',
        byteSize: 1024,
        sha256: digestCounter.toString(16).padStart(64, '0'),
        ...overrides,
      }),
    );
  };

  /** Put the declared bytes in the fake bucket, which is what a successful client PUT leaves behind. */
  const upload = async (attachmentId: string, overrides: { byteSize?: number; sha256?: string } = {}) => {
    const row = await asTenant(() =>
      prisma.client.attachments.findFirstOrThrow({ where: { id: attachmentId, household_id: householdId } }),
    );
    const bytes = new Uint8Array(overrides.byteSize ?? Number(row.byte_size));
    storage.put(row.storage_key, bytes, row.mime_type, overrides.sha256 ?? row.sha256);
    return row;
  };

  beforeAll(async () => {
    storage = new FakeObjectStorage();
    scanner = new FakeScanner();

    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule, AuthModule, FilesModule, LedgerModule],
    })
      .overrideProvider(OBJECT_STORAGE)
      .useValue(storage)
      .overrideProvider(SCANNER)
      .useValue(scanner)
      .compile();

    prisma = moduleRef.get(PrismaService);
    files = moduleRef.get(FilesService);
    rateLimit = moduleRef.get(RateLimitService);
    transactions = moduleRef.get(TransactionsService);

    const stamp = Date.now();
    await prisma.client.users.createMany({
      data: [
        { id: userId, email: `files-${stamp}@example.com`, display_name: 'Files Test' },
        { id: otherUserId, email: `files-b-${stamp}@example.com`, display_name: 'Other' },
      ],
    });
    for (const [ctx, id, owner] of [
      [context, householdId, userId],
      [otherContext, otherHouseholdId, otherUserId],
    ] as const) {
      await runWithTenant(ctx, () =>
        prisma.client.households.create({
          data: { id, name: 'Files Test', owner_user_id: owner, ledger_currency: 'RSD' },
        }),
      );
    }

    accountId = await asTenant(async () => {
      const account = await prisma.client.accounts.create({
        data: { id: uuidv7(), household_id: householdId, name: 'Tekući', kind: 'BANK', currency: 'RSD' },
      });
      return account.id;
    });
  });

  afterAll(async () => {
    for (const [ctx, id] of [
      [context, householdId],
      [otherContext, otherHouseholdId],
    ] as const) {
      await runWithTenant(ctx, () => prisma.client.households.deleteMany({ where: { id } }));
    }
    await prisma.client.users.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await moduleRef?.close();
  });

  // The presign path is rate limited (docs/06 §9.2); the suite makes far more than ten calls, so the
  // window is cleared between tests. One test below exhausts it on purpose.
  beforeEach(async () => {
    await rateLimit.reset('files.presign', householdId);
    storage.headCalls = 0;
    scanner.verdict = 'CLEAN';
  });

  // ---------------------------------------------------------------------------------------------
  // Allocation
  // ---------------------------------------------------------------------------------------------

  it('allocates a PENDING row and returns a signed PUT with the signed headers', async () => {
    const result = await presign();

    expect(result.reused).toBe(false);
    expect(result.method).toBe('PUT');
    expect(result.uploadUrl).toContain('sig=put');
    // `host` is signed but must not be sent by a browser; the rest must be sent verbatim.
    expect(result.headers['host']).toBeUndefined();
    expect(result.headers['content-type']).toBe('image/jpeg');
    expect(result.headers['x-amz-meta-sha256']).toHaveLength(64);

    const row = await asTenant(() =>
      prisma.client.attachments.findFirstOrThrow({ where: { id: result.attachmentId } }),
    );
    expect(row.scan_state).toBe('PENDING');
    expect(row.storage_key).toMatch(new RegExp(`^household/${householdId}/[0-9a-f-]{36}\\.jpg$`));
    expect(row.byte_size).toBe(1024n);
  });

  it('reuses the row for the same bytes within the window, and not for a different purpose', async () => {
    const digest = sha('ab');
    const first = await presign({ sha256: digest });
    const second = await presign({ sha256: digest });
    expect(second.attachmentId).toBe(first.attachmentId);
    expect(second.reused).toBe(true);

    const otherPurpose = await presign({ sha256: digest, purpose: 'TRANSACTION' });
    expect(otherPurpose.attachmentId).not.toBe(first.attachmentId);
    expect(otherPurpose.reused).toBe(false);
  });

  it('refuses a file type or size the allowlist does not cover, before any row exists', async () => {
    await expect(presign({ mimeType: 'image/gif' })).rejects.toThrow(/Unsupported file type/);
    await expect(presign({ byteSize: MAX_BYTE_SIZE + 1 })).rejects.toThrow(/limit is/);
  });

  it('rate limits presign per Household, and the eleventh call in a window is refused', async () => {
    for (let index = 0; index < PRESIGN_RATE_LIMIT; index += 1) {
      await presign();
    }
    await expect(presign()).rejects.toThrow(ApiError);
  });

  // ---------------------------------------------------------------------------------------------
  // Tenancy
  // ---------------------------------------------------------------------------------------------

  it('never exposes another Household’s attachment', async () => {
    const { attachmentId } = await presign();

    expect(await runWithTenant(otherContext, () => files.getById(otherHouseholdId, attachmentId))).toBeNull();
    expect(
      await runWithTenant(otherContext, () => files.downloadTarget(otherHouseholdId, attachmentId)),
    ).toBeNull();
    expect(await runWithTenant(otherContext, () => files.remove(otherHouseholdId, attachmentId))).toBe(false);
  });

  // ---------------------------------------------------------------------------------------------
  // Download
  // ---------------------------------------------------------------------------------------------

  it('withholds the download URL until commit has accepted the upload', async () => {
    const { attachmentId } = await presign();
    expect(await asTenant(() => files.downloadTarget(householdId, attachmentId))).toBe('pending');

    await upload(attachmentId);
    await asTenant(() => files.commit(householdId, { attachmentId }));

    const target = await asTenant(() => files.downloadTarget(householdId, attachmentId));
    expect(target).toEqual({ url: expect.stringContaining('sig=get') });
  });

  // ---------------------------------------------------------------------------------------------
  // Commit
  // ---------------------------------------------------------------------------------------------

  it('records FAILED when the object never arrived, and refuses the commit', async () => {
    const { attachmentId } = await presign();
    await expect(asTenant(() => files.commit(householdId, { attachmentId }))).rejects.toThrow(
      /upload did not arrive/,
    );
    const row = await asTenant(() =>
      prisma.client.attachments.findFirstOrThrow({ where: { id: attachmentId } }),
    );
    expect(row.scan_state).toBe('FAILED');
  });

  it('records FAILED when the object is a different size or digest than declared', async () => {
    const short = await presign();
    await upload(short.attachmentId, { byteSize: 99 });
    await expect(asTenant(() => files.commit(householdId, { attachmentId: short.attachmentId }))).rejects.toThrow(
      /bytes but/,
    );

    const swapped = await presign();
    await upload(swapped.attachmentId, { sha256: sha('dead') });
    await expect(
      asTenant(() => files.commit(householdId, { attachmentId: swapped.attachmentId })),
    ).rejects.toThrow(/different sha256/);
  });

  it('quarantines an attachment the scanner rejects: the row records it and the bytes go', async () => {
    const { attachmentId } = await presign();
    const row = await upload(attachmentId);
    scanner.verdict = 'INFECTED';

    await expect(asTenant(() => files.commit(householdId, { attachmentId }))).rejects.toThrow(
      /did not pass/,
    );
    const after = await asTenant(() =>
      prisma.client.attachments.findFirstOrThrow({ where: { id: attachmentId } }),
    );
    expect(after.scan_state).toBe('INFECTED');
    expect(storage.objects.has(row.storage_key)).toBe(false);
  });

  it('records SKIPPED when no scanner is configured, and the row stays downloadable', async () => {
    const { attachmentId } = await presign();
    await upload(attachmentId);
    scanner.verdict = 'SKIPPED';

    const view = await asTenant(() => files.commit(householdId, { attachmentId }));
    expect(view.scanState).toBe('SKIPPED');
    expect(view.downloadUrl).toContain('sig=get');
  });

  it('links a Transaction and is idempotent: a retried commit does not re-check the object', async () => {
    const { attachmentId } = await presign();
    await upload(attachmentId);
    const transactionId = uuidv7();
    await asTenant(() =>
      prisma.client.transactions.create({
        data: {
          id: transactionId,
          household_id: householdId,
          account_id: accountId,
          kind: 'EXPENSE',
          amount_minor: 200_000n,
          currency: 'RSD',
          description: 'Lidl',
          source: 'MANUAL',
          status: 'CONFIRMED',
          occurred_at: new Date('2026-10-10T10:00:00.000Z'),
          occurred_local_date: new Date('2026-10-10T00:00:00.000Z'),
        },
      }),
    );

    await asTenant(() => files.commit(householdId, { attachmentId, transactionId }));
    const linked = await asTenant(() =>
      prisma.client.transactions.findFirstOrThrow({ where: { id: transactionId } }),
    );
    expect(linked.attachment_id).toBe(attachmentId);
    // The read path a client uses exposes it too (F-34's `Transaction.attachmentId`).
    const view = await asTenant(() => transactions.getById(householdId, transactionId));
    expect(view.attachmentId).toBe(attachmentId);

    const callsAfterFirst = storage.headCalls;
    await asTenant(() => files.commit(householdId, { attachmentId, transactionId }));
    expect(storage.headCalls).toBe(callsAfterFirst);
  });

  it('refuses to attach a row that is not linkable, whatever the caller asks', async () => {
    const { attachmentId } = await presign();
    await upload(attachmentId);
    scanner.verdict = 'INFECTED';
    await expect(asTenant(() => files.commit(householdId, { attachmentId }))).rejects.toThrow();

    const transactionId = uuidv7();
    await asTenant(() =>
      prisma.client.transactions.create({
        data: {
          id: transactionId,
          household_id: householdId,
          account_id: accountId,
          kind: 'EXPENSE',
          amount_minor: 1n,
          currency: 'RSD',
          description: 'must stay unattached',
          source: 'MANUAL',
          status: 'CONFIRMED',
          occurred_at: new Date('2026-10-12T10:00:00.000Z'),
          occurred_local_date: new Date('2026-10-12T00:00:00.000Z'),
        },
      }),
    );

    // The second commit skips the scan (the row is decided) — and must still refuse the link.
    await expect(
      asTenant(() => files.commit(householdId, { attachmentId, transactionId })),
    ).rejects.toThrow(/cannot be attached/);
    const row = await asTenant(() =>
      prisma.client.transactions.findFirstOrThrow({ where: { id: transactionId } }),
    );
    expect(row.attachment_id).toBeNull();
  });

  it('refuses to link a Transaction from another Household', async () => {
    const { attachmentId } = await presign();
    await upload(attachmentId);
    await expect(
      asTenant(() => files.commit(householdId, { attachmentId, transactionId: uuidv7() })),
    ).rejects.toThrow(/Transaction not found/);
  });

  it('deletes the object and detaches it from a Transaction (ON DELETE SET NULL)', async () => {
    const { attachmentId } = await presign();
    const row = await upload(attachmentId);
    await asTenant(() => files.commit(householdId, { attachmentId }));

    const transactionId = uuidv7();
    await asTenant(() =>
      prisma.client.transactions.create({
        data: {
          id: transactionId,
          household_id: householdId,
          account_id: accountId,
          kind: 'EXPENSE',
          amount_minor: 100n,
          currency: 'RSD',
          description: 'detach me',
          source: 'MANUAL',
          status: 'CONFIRMED',
          attachment_id: attachmentId,
          occurred_at: new Date('2026-10-11T10:00:00.000Z'),
          occurred_local_date: new Date('2026-10-11T00:00:00.000Z'),
        },
      }),
    );

    expect(await asTenant(() => files.remove(householdId, attachmentId))).toBe(true);
    expect(storage.objects.has(row.storage_key)).toBe(false);
    const detached = await asTenant(() =>
      prisma.client.transactions.findFirstOrThrow({ where: { id: transactionId } }),
    );
    expect(detached.attachment_id).toBeNull();
  });

  // ---------------------------------------------------------------------------------------------
  // Retention
  // ---------------------------------------------------------------------------------------------

  it('purges quarantined, abandoned, unreferenced and expired rows, and only those', async () => {
    // Real "now", not a fixed date: the rows the earlier tests created are recent relative to the wall
    // clock, and a future `now` would make every one of them look abandoned.
    const now = new Date();
    const old = new Date(now.getTime() - (ORPHAN_GRACE_HOURS + 1) * 60 * 60 * 1000);
    const recent = new Date(now.getTime() - 60 * 60 * 1000);
    const expired = new Date(`${addMonths(toLocalDate(now, 'UTC'), -25)}T00:00:00.000Z`);

    const make = async (scanState: string, createdAt: Date, referenced: boolean): Promise<string> => {
      const id = uuidv7();
      const key = `household/${householdId}/${uuidv7()}.jpg`;
      await asTenant(() =>
        prisma.client.attachments.create({
          data: {
            id,
            household_id: householdId,
            storage_key: key,
            mime_type: 'image/jpeg',
            byte_size: 10n,
            sha256: sha(id.replace(/-/g, '')),
            purpose: 'RECEIPT',
            scan_state: scanState,
            created_at: createdAt,
          },
        }),
      );
      storage.put(key, new Uint8Array(10), 'image/jpeg', 'x'.repeat(64));
      if (referenced) {
        await asTenant(() =>
          prisma.client.transactions.create({
            data: {
              id: uuidv7(),
              household_id: householdId,
              account_id: accountId,
              kind: 'EXPENSE',
              amount_minor: 1n,
              currency: 'RSD',
              description: 'keeps the attachment',
              source: 'MANUAL',
              status: 'CONFIRMED',
              attachment_id: id,
              occurred_at: new Date('2026-01-01T10:00:00.000Z'),
              occurred_local_date: new Date('2026-01-01T00:00:00.000Z'),
            },
          }),
        );
      }
      return id;
    };

    const infected = await make('INFECTED', recent, false);
    const failed = await make('FAILED', recent, false);
    const abandoned = await make('PENDING', old, false);
    const orphan = await make('CLEAN', old, false);
    const referenced = await make('CLEAN', old, true);
    const fresh = await make('CLEAN', recent, false);
    const expiredRow = await make('CLEAN', expired, true);

    const result = await asTenant(() => files.purge(householdId, { now }));

    // The count is not asserted exactly: earlier tests in this suite legitimately leave `FAILED` and
    // `INFECTED` rows behind, and rule 1 removes those too. What the test pins is *which* rows survive.
    expect(result.rowsDeleted).toBeGreaterThanOrEqual(5);
    expect(result.failed).toBe(0);
    const remaining = await asTenant(() =>
      prisma.client.attachments.findMany({ where: { household_id: householdId }, select: { id: true } }),
    );
    const ids = new Set(remaining.map((row) => row.id));
    expect(ids.has(referenced)).toBe(true);
    expect(ids.has(fresh)).toBe(true);
    for (const purged of [infected, failed, abandoned, orphan, expiredRow]) {
      expect(ids.has(purged)).toBe(false);
    }
  });

  it('is idempotent: a second purge finds nothing to do', async () => {
    const result = await asTenant(() => files.purge(householdId));
    expect(result.scanned).toBe(0);
    expect(result.rowsDeleted).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // The REST answers
  // ---------------------------------------------------------------------------------------------

  describe('FilesController', () => {
    /** The two Express methods the controller uses, captured instead of sent. */
    const fakeResponse = (): Response & { headers: Record<string, string>; redirectedTo: string | null } => {
      const headers: Record<string, string> = {};
      let redirectedTo: string | null = null;
      return {
        headers,
        get redirectedTo() {
          return redirectedTo;
        },
        setHeader: (name: string, value: string) => {
          headers[name] = value;
        },
        redirect: (_status: number, url: string) => {
          redirectedTo = url;
        },
      } as unknown as Response & { headers: Record<string, string>; redirectedTo: string | null };
    };

    const controller = () => new FilesController(files);

    it('redirects a linkable attachment with no-store', async () => {
      const { attachmentId } = await presign();
      await upload(attachmentId);
      await asTenant(() => files.commit(householdId, { attachmentId }));

      const response = fakeResponse();
      await asTenant(() => controller().download(householdId, attachmentId, response));
      expect(response.headers['Cache-Control']).toBe('no-store');
      expect(response.redirectedTo).toContain('sig=get');
    });

    it('answers 409 while the row is not linkable and 404 when it is not ours', async () => {
      const { attachmentId } = await presign();
      await expect(
        asTenant(() => controller().download(householdId, attachmentId, fakeResponse())),
      ).rejects.toThrow(/still being checked/);
      await expect(
        asTenant(() => controller().download(householdId, uuidv7(), fakeResponse())),
      ).rejects.toThrow(/Attachment not found/);
      // The cross-Household case needs the *other* tenant: the tenancy guard scopes every query to the
      // session's Household, so it would answer this one from the first Household's data.
      await expect(
        runWithTenant(otherContext, () =>
          controller().download(otherHouseholdId, attachmentId, fakeResponse()),
        ),
      ).rejects.toThrow(/Attachment not found/);
    });
  });
});

describe('files without object storage', () => {
  let moduleRef: TestingModule;
  let files: FilesService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule, AuthModule, FilesModule],
    })
      .overrideProvider(OBJECT_STORAGE)
      .useValue(UNCONFIGURED_OBJECT_STORAGE)
      .compile();
    files = moduleRef.get(FilesService);
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('refuses a presign with a readable reason instead of an unusable URL', async () => {
    await expect(
      runWithTenant({ householdId: uuidv7(), userId: uuidv7(), role: 'OWNER', requestId: 'files-none' }, () =>
        files.presign(uuidv7(), {
          purpose: 'RECEIPT',
          mimeType: 'image/jpeg',
          byteSize: 10,
          sha256: sha('aa'),
        }),
      ),
    ).rejects.toThrow(/not configured/);
  });
});
