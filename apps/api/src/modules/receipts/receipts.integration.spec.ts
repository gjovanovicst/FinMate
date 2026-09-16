import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OcrResult } from '@finmate/ai';
import { uuidv7 } from '@finmate/domain';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { runWithTenant, type TenantContext } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { FakeObjectStorage } from '../../testing/fake-object-storage';
import { AuthModule } from '../auth/auth.module';
import { ClassificationModule } from '../classification/classification.module';
import { FilesModule } from '../files/files.module';
import { FilesService } from '../files/files.service';
import { OBJECT_STORAGE } from '../files/object-storage';
import { OCR, type OcrOutcome, type OcrRequest, type OcrService } from './ocr';
import { ReceiptsModule } from './receipts.module';
import { ReceiptsService } from './receipts.service';

/**
 * Receipts against a real database, a stubbed bucket and a **scripted** OCR provider — F-14,
 * docs/06 §5.9, I-6.
 *
 * What only this level can answer: that an item's category comes from the Household's own rules
 * (through the same pipeline a typed fragment uses), that OCR output is treated as untrusted input,
 * that re-extraction replaces rather than appends, that I-6 is recomputed after every mutation, and
 * that a second Household can see and change none of it (ADR-008).
 *
 * The OCR *seam* is scripted on purpose — no provider is configured in this build, and a suite that
 * needed one could not run in CI. The seam's own behaviour over a router is covered separately.
 */
class ScriptedOcr implements OcrService {
  available = true;
  unavailableReason: string | null = null;
  result: OcrResult = {
    lines: [
      { text: 'MLEKO 2.8%', amountMinor: '17900' },
      { text: 'HLEB 500G', amountMinor: '8900' },
    ],
    totalMinor: '26800',
    currency: 'RSD',
    occurredOn: '2026-10-10',
    merchantName: 'LIDL SRBIJA',
    confidence: 0.91,
  };
  thrown: string | null = null;

  read(_request: OcrRequest): Promise<OcrOutcome> {
    if (this.thrown !== null) return Promise.resolve({ ok: false, reason: this.thrown });
    return Promise.resolve({ ok: true, result: this.result, provider: 'scripted' });
  }
}

describe('receipts (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let receipts: ReceiptsService;
  let files: FilesService;
  let storage: FakeObjectStorage;
  let ocr: ScriptedOcr;
  let rateLimit: RateLimitService;

  const householdId = uuidv7();
  const otherHouseholdId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();

  const context: TenantContext = { householdId, userId, role: 'OWNER', requestId: 'receipts-it' };
  const otherContext: TenantContext = {
    householdId: otherHouseholdId,
    userId: otherUserId,
    role: 'OWNER',
    requestId: 'receipts-it-other',
  };
  const asTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(context, fn);

  let categoryId: string;

  /** An uploaded, committed RECEIPT attachment — what the upload flow from 4.1.2 leaves behind. */
  async function uploadedAttachment(purpose = 'RECEIPT'): Promise<string> {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sha256 = 'a'.repeat(64);
    const presigned = await asTenant(() =>
      files.presign(householdId, {
        purpose,
        mimeType: 'image/jpeg',
        byteSize: bytes.length,
        sha256,
      }),
    );
    const row = await asTenant(() =>
      prisma.client.attachments.findFirstOrThrow({ where: { id: presigned.attachmentId } }),
    );
    storage.put(row.storage_key, bytes, 'image/jpeg', sha256);
    await asTenant(() => files.commit(householdId, { attachmentId: presigned.attachmentId }));
    return presigned.attachmentId;
  }

  beforeAll(async () => {
    storage = new FakeObjectStorage();
    ocr = new ScriptedOcr();

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot(),
        PrismaModule,
        AuthModule,
        FilesModule,
        ClassificationModule,
        ReceiptsModule,
      ],
    })
      .overrideProvider(OBJECT_STORAGE)
      .useValue(storage)
      .overrideProvider(OCR)
      .useValue(ocr)
      .compile();

    prisma = moduleRef.get(PrismaService);
    receipts = moduleRef.get(ReceiptsService);
    files = moduleRef.get(FilesService);
    rateLimit = moduleRef.get(RateLimitService);

    const stamp = Date.now();
    await prisma.client.users.createMany({
      data: [
        { id: userId, email: `receipts-${stamp}@example.com`, display_name: 'Receipts Test' },
        { id: otherUserId, email: `receipts-b-${stamp}@example.com`, display_name: 'Other' },
      ],
    });
    for (const [ctx, id, owner] of [
      [context, householdId, userId],
      [otherContext, otherHouseholdId, otherUserId],
    ] as const) {
      await runWithTenant(ctx, () =>
        prisma.client.households.create({
          data: { id, name: 'Receipts Test', owner_user_id: owner, ledger_currency: 'RSD' },
        }),
      );
    }

    categoryId = await asTenant(async () => {
      const account = await prisma.client.accounts.create({
        data: { id: uuidv7(), household_id: householdId, name: 'Tekući', kind: 'BANK', currency: 'RSD' },
      });
      void account;
      const food = await prisma.client.categories.create({
        data: { id: uuidv7(), household_id: householdId, name: 'Hrana', kind: 'EXPENSE' },
      });
      // A **strong** keyword (weight 2.0) is what decides a category alone (docs/04 §5.4, §8.1.3), so
      // an item line resolves without a model — which is the whole point of rules before AI (ADR-002).
      await prisma.client.category_keywords.createMany({
        data: [
          { id: uuidv7(), household_id: householdId, category_id: food.id, keyword: 'mleko', polarity: 'INCLUDE', weight: 2 },
          { id: uuidv7(), household_id: householdId, category_id: food.id, keyword: 'hleb', polarity: 'INCLUDE', weight: 2 },
        ],
      });
      return food.id;
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

  // Every test uploads at least one attachment, and the presign path is rate limited to ten a minute
  // per Household (docs/06 §9.2), so the window is cleared rather than the limit weakened.
  beforeEach(async () => {
    await rateLimit.reset('files.presign', householdId);
  });

  // ---------------------------------------------------------------------------------------------
  // Creating
  // ---------------------------------------------------------------------------------------------

  it('opens a PENDING receipt over a RECEIPT attachment', async () => {
    const attachmentId = await uploadedAttachment();
    const receipt = await asTenant(() => receipts.create(householdId, { attachmentId }));

    expect(receipt.reconciliation).toBe('PENDING');
    expect(receipt.totalMinor).toBeNull();
    expect(receipt.items).toEqual([]);
    expect(receipt.itemsTotalMinor).toBe(0n);
    // The ledger currency is reported even with no total, so a client never invents one (ADR-011).
    expect(receipt.currency).toBe('RSD');
    expect(receipt.attachmentId).toBe(attachmentId);
  });

  it('refuses an attachment that is not a RECEIPT, or not this Household’s', async () => {
    const transactionPhoto = await uploadedAttachment('TRANSACTION');
    await expect(
      asTenant(() => receipts.create(householdId, { attachmentId: transactionPhoto })),
    ).rejects.toThrow(/not RECEIPT/);

    await expect(
      asTenant(() => receipts.create(householdId, { attachmentId: uuidv7() })),
    ).rejects.toThrow(/Attachment not found/);
  });

  // ---------------------------------------------------------------------------------------------
  // Extraction
  // ---------------------------------------------------------------------------------------------

  it('writes OCR lines as items, categorised by the Household’s own rules', async () => {
    const attachmentId = await uploadedAttachment();
    const receipt = await asTenant(() => receipts.create(householdId, { attachmentId }));

    const result = await asTenant(() => receipts.extract(householdId, receipt.id));
    expect(result).toEqual({
      extracted: true,
      itemsWritten: 2,
      reason: null,
      linesWithoutAmount: 0,
      currencyMismatch: false,
    });

    const after = await asTenant(() => receipts.getById(householdId, receipt.id));
    expect(after?.items).toHaveLength(2);
    // 17900 + 8900 = 26800, and the provider's total is 26800: I-6 is satisfied exactly.
    expect(after?.itemsTotalMinor).toBe(26800n);
    expect(after?.varianceMinor).toBe(0n);
    expect(after?.reconciliation).toBe('MATCHED');
    expect(after?.ocrConfidence).toBeCloseTo(0.91);
    expect(after?.totalMinor).toBe(26800n);

    // The category came from the keyword, not from the provider — and it is auditable like any other.
    expect(after?.items.every((item) => item.categoryId === categoryId)).toBe(true);
    expect(after?.items.every((item) => item.needsReview === false)).toBe(true);
    const decisions = await asTenant(() =>
      prisma.client.classification_decisions.count({ where: { household_id: householdId } }),
    );
    expect(decisions).toBeGreaterThanOrEqual(2);
  });

  it('replaces the items on a second run rather than appending them', async () => {
    const attachmentId = await uploadedAttachment();
    const receipt = await asTenant(() => receipts.create(householdId, { attachmentId }));
    await asTenant(() => receipts.extract(householdId, receipt.id));

    ocr.result = {
      lines: [{ text: 'MLEKO 2.8%', amountMinor: '17900' }],
      totalMinor: '17900',
      currency: 'RSD',
      occurredOn: null,
      merchantName: null,
      confidence: 0.8,
    };
    await asTenant(() => receipts.extract(householdId, receipt.id));

    const after = await asTenant(() => receipts.getById(householdId, receipt.id));
    expect(after?.items).toHaveLength(1);
    expect(after?.items[0]?.lineNo).toBe(1);
    expect(after?.reconciliation).toBe('MATCHED');
    ocr.result = new ScriptedOcr().result;
  });

  it('writes nothing at all when the OCR seam is unavailable', async () => {
    const attachmentId = await uploadedAttachment();
    const receipt = await asTenant(() => receipts.create(householdId, { attachmentId }));
    ocr.thrown = 'AI_UNAVAILABLE:no-provider-configured';

    const result = await asTenant(() => receipts.extract(householdId, receipt.id));
    expect(result.extracted).toBe(false);
    expect(result.reason).toBe('AI_UNAVAILABLE:no-provider-configured');

    const after = await asTenant(() => receipts.getById(householdId, receipt.id));
    expect(after?.items).toEqual([]);
    expect(after?.reconciliation).toBe('PENDING');
    ocr.thrown = null;
  });

  it('skips a line whose amount was not read, and says how many', async () => {
    const attachmentId = await uploadedAttachment();
    const receipt = await asTenant(() => receipts.create(householdId, { attachmentId }));
    ocr.result = {
      lines: [
        { text: 'MLEKO 2.8%', amountMinor: '17900' },
        { text: '*** POPUST ***', amountMinor: null },
      ],
      totalMinor: '17900',
      currency: 'RSD',
      occurredOn: null,
      merchantName: null,
      confidence: 0.7,
    };

    const result = await asTenant(() => receipts.extract(householdId, receipt.id));
    expect(result.itemsWritten).toBe(1);
    expect(result.linesWithoutAmount).toBe(1);
    ocr.result = new ScriptedOcr().result;
  });

  it('ignores a total in another currency rather than converting it (ADR-011)', async () => {
    const attachmentId = await uploadedAttachment();
    const receipt = await asTenant(() => receipts.create(householdId, { attachmentId }));
    ocr.result = { ...new ScriptedOcr().result, currency: 'EUR', totalMinor: '2000' };

    const result = await asTenant(() => receipts.extract(householdId, receipt.id));
    expect(result.currencyMismatch).toBe(true);
    expect(result.itemsWritten).toBe(2);

    const after = await asTenant(() => receipts.getById(householdId, receipt.id));
    expect(after?.totalMinor).toBeNull();
    expect(after?.reconciliation).toBe('PENDING');
    ocr.result = new ScriptedOcr().result;
  });

  // ---------------------------------------------------------------------------------------------
  // I-6 and reconciliation
  // ---------------------------------------------------------------------------------------------

  it('recomputes I-6 after a manual change, and marks a hand-added line MANUAL', async () => {
    const attachmentId = await uploadedAttachment();
    const receipt = await asTenant(() => receipts.create(householdId, { attachmentId }));
    ocr.result = { ...new ScriptedOcr().result, totalMinor: '26900', lines: [{ text: 'MLEKO 2.8%', amountMinor: '17900' }] };
    await asTenant(() => receipts.extract(householdId, receipt.id));

    // 26900 − 17900 = 9000: a real mismatch, and ACCEPT_MATCH must refuse it.
    const mismatched = await asTenant(() => receipts.getById(householdId, receipt.id));
    expect(mismatched?.reconciliation).toBe('MISMATCH');
    await expect(
      asTenant(() => receipts.reconcile(householdId, { receiptId: receipt.id, action: 'ACCEPT_MATCH' })),
    ).rejects.toThrow(/differ by 9000/);

    // A rounding line absorbs the gap and the state says **who** reconciled it.
    const reconciled = await asTenant(() =>
      receipts.reconcile(householdId, {
        receiptId: receipt.id,
        action: 'ADD_ROUNDING_LINE',
        absorbCategoryId: categoryId,
      }),
    );
    expect(reconciled.reconciliation).toBe('MANUAL');
    expect(reconciled.items).toHaveLength(2);
    expect(reconciled.itemsTotalMinor).toBe(26900n);
    expect(reconciled.varianceMinor).toBe(0n);

    // And a matched receipt accepts ACCEPT_MATCH idempotently.
    const accepted = await asTenant(() =>
      receipts.reconcile(householdId, { receiptId: receipt.id, action: 'ACCEPT_MATCH' }),
    );
    expect(accepted.reconciliation).toBe('MANUAL');
    ocr.result = new ScriptedOcr().result;
  });

  it('refuses a rounding line when the items overshoot, and offers the other two answers', async () => {
    const attachmentId = await uploadedAttachment();
    const receipt = await asTenant(() => receipts.create(householdId, { attachmentId }));
    ocr.result = { ...new ScriptedOcr().result, totalMinor: '10000', lines: [{ text: 'MLEKO 2.8%', amountMinor: '17900' }] };
    await asTenant(() => receipts.extract(householdId, receipt.id));

    await expect(
      asTenant(() =>
        receipts.reconcile(householdId, { receiptId: receipt.id, action: 'ADD_ROUNDING_LINE' }),
      ),
    ).rejects.toThrow(/cannot be negative/);

    // ADJUST_TOTAL sets the total to the absolute value the user asserts.
    const fixed = await asTenant(() =>
      receipts.reconcile(householdId, { receiptId: receipt.id, action: 'ADJUST_TOTAL', setMinor: 17900n }),
    );
    expect(fixed.reconciliation).toBe('MATCHED');
    ocr.result = new ScriptedOcr().result;
  });

  it('allows a per-item override, which is a user decision and clears needsReview', async () => {
    const attachmentId = await uploadedAttachment();
    const receipt = await asTenant(() => receipts.create(householdId, { attachmentId }));
    await asTenant(() => receipts.extract(householdId, receipt.id));
    const item = (await asTenant(() => receipts.getById(householdId, receipt.id)))?.items[0];
    expect(item).toBeDefined();

    const updated = await asTenant(() =>
      receipts.updateItem(householdId, {
        receiptItemId: item!.id,
        amountMinor: 20000n,
        categoryId,
      }),
    );
    expect(updated.items[0]?.amountMinor).toBe(20000n);
    expect(updated.items[0]?.confidence).toBe(1);
    expect(updated.items[0]?.needsReview).toBe(false);
    // 20000 + 8900 = 28900 against the provider's 26800: the mismatch is the *point* of I-6.
    expect(updated.reconciliation).toBe('MISMATCH');
    expect(updated.varianceMinor).toBe(-2100n);
  });

  it('supports manual itemisation end to end: add, then remove', async () => {
    const attachmentId = await uploadedAttachment();
    const receipt = await asTenant(() => receipts.create(householdId, { attachmentId }));

    const added = await asTenant(() =>
      receipts.addItem(householdId, receipt.id, {
        rawText: 'Mleko 1l',
        amountMinor: 17900n,
        categoryId,
      }),
    );
    expect(added.items).toHaveLength(1);
    expect(added.items[0]?.lineNo).toBe(1);

    const removed = await asTenant(() => receipts.removeItem(householdId, added.items[0]!.id));
    expect(removed.items).toEqual([]);
    expect(removed.reconciliation).toBe('PENDING');
  });

  // ---------------------------------------------------------------------------------------------
  // Tenancy
  // ---------------------------------------------------------------------------------------------

  it('never exposes or mutates another Household’s receipt', async () => {
    const attachmentId = await uploadedAttachment();
    const receipt = await asTenant(() => receipts.create(householdId, { attachmentId }));

    expect(await runWithTenant(otherContext, () => receipts.getById(otherHouseholdId, receipt.id))).toBeNull();
    expect(
      await runWithTenant(otherContext, () => receipts.list(otherHouseholdId)).then((page) => page.totalCount),
    ).toBe(0);
    await expect(
      runWithTenant(otherContext, () =>
        receipts.addItem(otherHouseholdId, receipt.id, { rawText: 'x', amountMinor: 1n }),
      ),
    ).rejects.toThrow(ApiError);
  });
});
