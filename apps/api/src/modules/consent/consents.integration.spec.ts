import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@finmate/domain';

import { ROLES_KEY } from '../../common/auth/guards';
import { runWithTenant, type TenantContext } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { ConsentModule } from './consent.module';
import { ConsentsResolver } from './consents.resolver';
import { ConsentsService } from './consents.service';
import { EXPOSED_CONSENT_KINDS } from './consent';

/**
 * The consent record against a real database — docs/08 §6.6, docs/03 §4, ADR-031.
 *
 * What only Postgres can answer, and what the router depends on:
 *
 * - **the newest row is the state, and it is total.** A GRANT followed immediately by a WITHDRAW is
 *   the case this file exists for: same millisecond, opposite answers, and getting it wrong means
 *   re-admitting egress after a user revoked it;
 * - **the history survives.** A withdrawal may not be an `UPDATE`, because docs/08 §6.6 says the
 *   record *is* the evidence that consent was held at a particular time;
 * - **tenancy.** One Household's grant must not admit another Household's text — the guard is the
 *   enforcement, and this asserts it end to end rather than trusting the middleware.
 */
describe('consent (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let consents: ConsentsService;

  const householdId = uuidv7();
  const otherHouseholdId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();

  const context: TenantContext = { householdId, userId, role: 'OWNER', requestId: 'consent-it' };
  const otherContext: TenantContext = {
    householdId: otherHouseholdId,
    userId: otherUserId,
    role: 'OWNER',
    requestId: 'consent-it-other',
  };
  const asTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(context, fn);

  beforeAll(async () => {
    Logger.overrideLogger(false);
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule, ConsentModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    consents = moduleRef.get(ConsentsService);

    const stamp = Date.now();
    await prisma.client.users.createMany({
      data: [
        { id: userId, email: `consent-${stamp}@example.com`, display_name: 'Consent Test' },
        { id: otherUserId, email: `consent-b-${stamp}@example.com`, display_name: 'Other' },
      ],
    });
    for (const [ctx, id, owner] of [
      [context, householdId, userId],
      [otherContext, otherHouseholdId, otherUserId],
    ] as const) {
      await runWithTenant(ctx, () =>
        prisma.client.households.create({
          data: { id, name: 'Consent Test', owner_user_id: owner, ledger_currency: 'RSD' },
        }),
      );
    }
  });

  afterAll(async () => {
    // Cascades from `households`: the consents, the memberships, everything this file wrote. Wrapped
    // in a tenant context even for cleanup — `households` is scoped by its own key, so ADR-008
    // refuses an unscoped `deleteMany` exactly as it refuses an unscoped read (docs/15).
    await runWithTenant(context, () =>
      prisma.client.households.deleteMany({ where: { id: householdId } }),
    );
    await runWithTenant(otherContext, () =>
      prisma.client.households.deleteMany({ where: { id: otherHouseholdId } }),
    );
    await prisma.client.users.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await moduleRef.close();
  });

  /** A fresh Household's row count for one kind — used to prove append-only. */
  async function rows(kind: string): Promise<number> {
    return runWithTenant(context, () => prisma.client.consents.count({ where: { kind } }));
  }

  it('reports NOT_ASKED, never DECLINED, for a Household that has never decided', async () => {
    const overview = await asTenant(() => consents.overview());

    expect(overview.map((view) => view.kind)).toEqual([...EXPOSED_CONSENT_KINDS]);
    for (const view of overview) {
      expect(view.state).toBe('NOT_ASKED');
      expect(view.recordedAt).toBeNull();
    }
    // The docs/08 §6.6 purpose vocabulary travels with the record, so a screen never has to hardcode
    // the mapping between a stored kind and the copy that was shown.
    const text = overview.find((view) => view.kind === 'AI_DATA_PROCESSING');
    expect(text?.purposes).toEqual(['AI_TEXT_EGRESS', 'AI_NARRATION']);
  });

  it('treats NOT_ASKED as refused: no consent, no egress', async () => {
    expect(await asTenant(() => consents.permits('CLASSIFY'))).toBe(false);
    expect(await asTenant(() => consents.permits('OCR'))).toBe(false);
  });

  it('grants one purpose without granting another', async () => {
    const granted = await asTenant(() =>
      consents.record({ kind: 'AI_DATA_PROCESSING', state: 'GRANTED', evidence: { surface: 'settings' } }),
    );

    expect(granted.state).toBe('GRANTED');
    expect(await asTenant(() => consents.permits('CLASSIFY'))).toBe(true);
    // PARSE and NARRATE share the text kind (docs/03 §4's CHECK has no value between them).
    expect(await asTenant(() => consents.permits('NARRATE'))).toBe(true);
    // The Receipt image is a different question and a different answer.
    expect(await asTenant(() => consents.permits('OCR'))).toBe(false);
  });

  it('never permits EMBED, which has no consent that could admit it', async () => {
    expect(await asTenant(() => consents.permits('EMBED'))).toBe(false);
  });

  it('withdraws: the next call is refused, and the grant is still in the table', async () => {
    const withdrawn = await asTenant(() =>
      consents.record({ kind: 'AI_DATA_PROCESSING', state: 'WITHDRAWN' }),
    );

    expect(withdrawn.state).toBe('WITHDRAWN');
    expect(await asTenant(() => consents.permits('CLASSIFY'))).toBe(false);
    // Append-only: the GRANT row is untouched, which is the evidence docs/08 §6.6 requires. A shared
    // `granted` column would have destroyed it.
    expect(await rows('AI_DATA_PROCESSING')).toBe(2);
  });

  it('re-grants after a withdrawal, with the newest row deciding', async () => {
    await asTenant(() => consents.record({ kind: 'AI_DATA_PROCESSING', state: 'GRANTED' }));

    expect(await asTenant(() => consents.permits('CLASSIFY'))).toBe(true);
    expect(await rows('AI_DATA_PROCESSING')).toBe(3);
  });

  it('records the evidence without the raw request fingerprint', async () => {
    const row = await runWithTenant(context, () =>
      prisma.client.consents.findFirst({
        where: { kind: 'AI_DATA_PROCESSING' },
        orderBy: [{ recorded_at: 'desc' }, { id: 'desc' }],
      }),
    );

    const evidence = row?.evidence as Record<string, unknown>;
    expect(evidence['decision']).toBe('GRANTED');
    expect(evidence['requestId']).toBe('consent-it');
    expect(evidence['householdId']).toBe(householdId);
    expect(row?.policy_version).toBeTruthy();
    // The resolver hashes the fingerprint; the service never sees a raw IP. Nothing here may look
    // like one.
    expect(JSON.stringify(evidence)).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  });

  it('scopes the record to the session Household', async () => {
    // The other Household has recorded nothing, and must not be able to see this one's decision.
    expect(await runWithTenant(otherContext, () => consents.permits('CLASSIFY'))).toBe(false);
    const other = await runWithTenant(otherContext, () => consents.overview());
    expect(other.every((view) => view.state === 'NOT_ASKED')).toBe(true);

    // …and the grant is on the row, so a missing `household_id` predicate would be visible here.
    const row = await runWithTenant(context, () =>
      prisma.client.consents.findFirst({ where: { kind: 'AI_DATA_PROCESSING' } }),
    );
    expect(row?.household_id).toBe(householdId);
  });

  it('fails closed with no tenant context at all', async () => {
    // A background job that forgot `runWithTenant`, or a gate asked during boot: there is no
    // Household whose consent could have been read, so the answer is no.
    await expect(consents.permits('CLASSIFY')).resolves.toBe(false);
  });

  it('keeps the mutation OWNER-only (docs/08 §6.6, Q-11)', () => {
    // The guard is unit-tested in `guards.spec.ts`; what this asserts is that the *metadata* is on
    // the handler, because a resolver that forgot the decorator would silently accept a MEMBER.
    const roles = Reflect.getMetadata(ROLES_KEY, ConsentsResolver.prototype.recordAiConsent) as
      | readonly string[]
      | undefined;
    expect(roles).toEqual(['OWNER']);
  });
});
