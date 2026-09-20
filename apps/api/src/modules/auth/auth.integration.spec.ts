import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runWithTenant } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthModule } from './auth.module';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';

/**
 * Integration test for the session lifecycle, against a real PostgreSQL.
 *
 * It exists for two reasons:
 *
 *  1. **It caught a real bug.** `rotated_to_id` is a self-referencing foreign key, so the successor
 *     refresh-token row must be inserted *before* the predecessor points at it. Updating first
 *     failed with `refresh_tokens_rotated_to_id_fkey` — a 500 on every refresh, invisible to unit
 *     tests because the failure is a database constraint, not application logic.
 *  2. **It proves decorator metadata is emitted.** `Test.createTestingModule` resolves constructor
 *     dependencies from `design:paramtypes`; if the SWC transform ever regressed, DI would fail
 *     here rather than silently in the running app (ADR-020).
 *
 * Requires the dev database. docs/10 calls for Testcontainers so this is hermetic in CI; until
 * then it runs against `DATABASE_URL`, which is why the cleanup is explicit and scoped to the
 * Households it created.
 */
describe('AuthService session lifecycle (integration)', () => {
  let moduleRef: TestingModule;
  let auth: AuthService;
  let prisma: PrismaService;
  let tokenService: TokenService;
  /** Cleanup needs the Household, because the tenancy guard refuses an unscoped delete. */
  const created: { userId: string; householdId: string }[] = [];

  const password = 'correct horse battery staple';

  beforeAll(async () => {
    // Mirrors AppModule's wiring. AuthModule consumes the global CONFIG token, so a test that
    // imported AuthModule alone would fail to resolve it — a useful reminder that the module is
    // only self-sufficient in the presence of the global config module.
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule, AuthModule],
    }).compile();
    auth = moduleRef.get(AuthService);
    prisma = moduleRef.get(PrismaService);
    tokenService = moduleRef.get(TokenService);
  });

  afterAll(async () => {
    // Teardown has to establish a TenantContext per Household: the guard (correctly) refuses an
    // unscoped household delete, which is exactly the behaviour under test elsewhere. Doing it
    // this way also keeps the test honest about the production access pattern.
    for (const { userId, householdId } of created) {
      await runWithTenant({ householdId, userId, role: 'OWNER', requestId: 'test-teardown' }, async () => {
        await prisma.client.households.deleteMany({ where: { id: householdId } });
      });
    }
    const ids = created.map((entry) => entry.userId);
    if (ids.length > 0) {
      // ORDER MATTERS: `households.owner_user_id` references `users`, so Households go first.
      await prisma.client.users.deleteMany({ where: { id: { in: ids } } });
    }
    await moduleRef?.close();
  });

  const uniqueEmail = (): string => `it-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  async function signup(
    email: string,
    options: { locale?: string; currency?: string } = {},
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const tokens = await auth.signup({
      email,
      password,
      displayName: 'Integration Test',
      locale: options.locale ?? null,
      currency: options.currency ?? null,
      userAgentHash: null,
      ipHash: null,
    });
    const user = await prisma.client.users.findFirst({ where: { email } });
    if (user) {
      const memberships = await prisma.client.$queryRaw<{ household_id: string }[]>`
        SELECT household_id FROM household_members WHERE user_id = ${user.id}::uuid
      `;
      const householdId = memberships[0]?.household_id;
      if (householdId) created.push({ userId: user.id, householdId });
    }
    return tokens;
  }

  it('signup creates exactly one Household and an OWNER Membership', async () => {
    const email = uniqueEmail();
    await signup(email);

    const user = await prisma.client.users.findFirst({ where: { email } });
    expect(user).not.toBeNull();

    // The critical assertion: signup must actually persist the password, or the account is
    // passwordless. This was a real defect caught during implementation.
    expect(user?.password_hash).toMatch(/^\$argon2id\$/);

    const memberships = await prisma.client.$queryRaw<{ household_id: string; role: string }[]>`
      SELECT household_id, role FROM household_members WHERE user_id = ${user!.id}::uuid
    `;
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe('OWNER');
  });

  /** The Household's ledger currency as stored. Raw SQL, like the membership read above, so the
   *  tenancy guard does not need a context for a row this test owns. */
  async function ledgerCurrencyOf(userId: string): Promise<string | undefined> {
    const rows = await prisma.client.$queryRaw<{ ledger_currency: string }[]>`
      SELECT ledger_currency FROM households WHERE owner_user_id = ${userId}::uuid
    `;
    return rows[0]?.ledger_currency;
  }

  it('creates the Household in the currency the reader confirmed (ADR-045)', async () => {
    // The defect this pins: `ledger_currency` was the literal `'RSD'`, so a Household signed up in
    // Berlin was born with a dinar ledger and nobody was ever asked.
    const email = uniqueEmail();
    await signup(email, { currency: 'EUR' });
    const user = await prisma.client.users.findFirst({ where: { email } });
    expect(await ledgerCurrencyOf(user!.id)).toBe('EUR');
  });

  it('falls back rather than storing a currency the ledger cannot keep (ADR-045)', async () => {
    // `money()` throws on an unsupported currency, so accepting `ZZZ` here would create a Household
    // that cannot record a single Transaction. The service is the floor: the DTO rejects it too.
    const email = uniqueEmail();
    await signup(email, { currency: 'ZZZ' });
    const user = await prisma.client.users.findFirst({ where: { email } });
    expect(await ledgerCurrencyOf(user!.id)).toBe('RSD');
  });

  it('stores the reader\'s own language rather than collapsing it to English (ADR-044)', async () => {
    // Before ADR-044 `resolveCopyLocale` mapped every non-Serbian, non-English tag to `'en'` and this
    // result was written to `users.locale` — so a German reader was *persisted as English* and every
    // later email and notification was English regardless of the picker.
    const email = uniqueEmail();
    await signup(email, { locale: 'de-DE' });
    const user = await prisma.client.users.findFirst({ where: { email } });
    expect(user?.locale).toBe('de');
  });

  it('stores only the digests of tokens, never the tokens themselves', async () => {
    const email = uniqueEmail();
    const tokens = await signup(email);

    const stored = await prisma.client.refresh_tokens.findFirst({
      where: { token_hash: tokenService.hashToken(tokens.refreshToken) },
    });
    expect(stored).not.toBeNull();

    // The raw token must appear nowhere in the table.
    const leaked = await prisma.client.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM refresh_tokens WHERE token_hash = ${tokens.refreshToken}
    `;
    expect(Number(leaked[0]?.count ?? 0)).toBe(0);
  });

  it('resolves a session from an access token, with authority read from the database', async () => {
    const tokens = await signup(uniqueEmail());
    const session = await auth.resolveSession(tokens.accessToken);

    expect(session).not.toBeNull();
    expect(session?.membership.role).toBe('OWNER');
    expect(session?.membership.householdId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects a garbage access token', async () => {
    await expect(auth.resolveSession('not.a.token')).resolves.toBeNull();
  });

  it('ROTATES the refresh token, and the successor is usable', async () => {
    const tokens = await signup(uniqueEmail());
    const rotated = await auth.refresh({ refreshToken: tokens.refreshToken, userAgentHash: null, ipHash: null });

    expect(rotated.refreshToken).not.toBe(tokens.refreshToken);
    expect(rotated.accessToken).not.toBe(tokens.accessToken);

    // The regression guard for the FK-ordering bug: this is the call that used to fail with
    // refresh_tokens_rotated_to_id_fkey.
    await expect(
      auth.refresh({ refreshToken: rotated.refreshToken, userAgentHash: null, ipHash: null }),
    ).resolves.toBeTruthy();
  });

  it('DETECTS reuse of a rotated token and revokes the whole session', async () => {
    const tokens = await signup(uniqueEmail());
    const rotated = await auth.refresh({ refreshToken: tokens.refreshToken, userAgentHash: null, ipHash: null });

    // Replaying the consumed token is indistinguishable from theft, so the session must die.
    await expect(
      auth.refresh({ refreshToken: tokens.refreshToken, userAgentHash: null, ipHash: null }),
    ).rejects.toThrow(/security reasons/);

    // The legitimate successor must also be dead — a thief must not keep a live session.
    await expect(
      auth.refresh({ refreshToken: rotated.refreshToken, userAgentHash: null, ipHash: null }),
    ).rejects.toThrow();

    // And the access token must stop resolving immediately, not at expiry.
    await expect(auth.resolveSession(rotated.accessToken)).resolves.toBeNull();
  });

  it('logout revokes the session so the access token stops working', async () => {
    const tokens = await signup(uniqueEmail());
    const session = await auth.resolveSession(tokens.accessToken);
    expect(session).not.toBeNull();

    await auth.logout(session!.sessionId);
    await expect(auth.resolveSession(tokens.accessToken)).resolves.toBeNull();
  });

  it('rejects a refresh token that was never issued', async () => {
    await expect(
      auth.refresh({ refreshToken: 'x'.repeat(43), userAgentHash: null, ipHash: null }),
    ).rejects.toThrow(/Invalid session/);
  });
});
