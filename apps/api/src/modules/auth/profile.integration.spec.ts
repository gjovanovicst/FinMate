import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import { runWithTenant } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { AuthModule } from './auth.module';
import { AuthService } from './auth.service';

/**
 * Integration test for the profile screen's server half (docs/02 §4.18, docs/06 §2).
 *
 * It exists for the things only a real database can prove: that `pending_email` survives until the
 * link is consumed, that confirming actually moves the login identity, that a password change
 * revokes the *other* sessions and keeps the caller's, and that a session id belonging to another
 * account is a no-op rather than a cross-account logout (ADR-008's spirit applied to `sessions`).
 *
 * Requires the dev database, like `auth.integration.spec.ts`, and cleans up the Households it made.
 */
describe('profile and sessions (integration)', () => {
  let moduleRef: TestingModule;
  let auth: AuthService;
  let prisma: PrismaService;

  /** Captured mail, so the test reads the token instead of Mailhog. */
  const sent: { kind: 'verify' | 'reset' | 'change'; to: string; token: string }[] = [];

  const created: { userId: string; householdId: string }[] = [];
  const password = 'correct horse battery staple';
  const nextPassword = 'a different correct horse staple';

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule, AuthModule],
    })
      .overrideProvider(MailService)
      .useValue({
        sendEmailVerification: async (to: string, token: string) => {
          sent.push({ kind: 'verify', to, token });
        },
        sendPasswordReset: async (to: string, token: string) => {
          sent.push({ kind: 'reset', to, token });
        },
        sendEmailChange: async (to: string, token: string) => {
          sent.push({ kind: 'change', to, token });
        },
        sendNotification: async () => undefined,
      })
      .compile();

    auth = moduleRef.get(AuthService);
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    for (const { userId, householdId } of created) {
      await runWithTenant({ householdId, userId, role: 'OWNER', requestId: 'test-teardown' }, async () => {
        await prisma.client.households.deleteMany({ where: { id: householdId } });
      });
    }
    const ids = created.map((entry) => entry.userId);
    if (ids.length > 0) {
      // Households first: `households.owner_user_id` references `users`.
      await prisma.client.users.deleteMany({ where: { id: { in: ids } } });
    }
    await moduleRef?.close();
  });

  beforeEach(() => {
    sent.length = 0;
  });

  const uniqueEmail = (): string =>
    `profile-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  async function signup(email: string): Promise<{ userId: string; sessionId: string }> {
    const tokens = await auth.signup({
      email,
      password,
      displayName: 'Profile Test',
      userAgentHash: null,
      ipHash: null,
    });
    const user = await prisma.client.users.findFirst({ where: { email } });
    if (!user) throw new Error('signup did not create a user');

    const memberships = await prisma.client.$queryRaw<{ household_id: string }[]>`
      SELECT household_id FROM household_members WHERE user_id = ${user.id}::uuid
    `;
    const householdId = memberships[0]?.household_id;
    if (householdId) created.push({ userId: user.id, householdId });

    const session = await auth.resolveSession(tokens.accessToken);
    if (!session) throw new Error('signup did not create a session');
    return { userId: user.id, sessionId: session.sessionId };
  }

  /** A second, independent session for the same user — the one a password change must revoke. */
  async function secondSession(email: string): Promise<string> {
    const tokens = await auth.login({ email, password, userAgentHash: null, ipHash: null });
    const session = await auth.resolveSession(tokens.accessToken);
    if (!session) throw new Error('login did not create a session');
    return session.sessionId;
  }

  /** Whether a session row is still live, read straight from the table. */
  async function isSessionLive(sessionId: string): Promise<boolean> {
    const row = await prisma.client.sessions.findFirst({ where: { id: sessionId } });
    return row !== null && row.revoked_at === null && row.expires_at.getTime() > Date.now();
  }

  it('renames the account and reads it back', async () => {
    const { userId } = await signup(uniqueEmail());
    await auth.updateProfile(userId, '  New Name  ');

    const profile = await auth.profile(userId);
    expect(profile.displayName).toBe('New Name');
    expect(profile.emailVerified).toBe(false);
    expect(profile.pendingEmail).toBeNull();
  });

  it('refuses a blank display name', async () => {
    const { userId } = await signup(uniqueEmail());
    await expect(auth.updateProfile(userId, '   ')).rejects.toBeInstanceOf(ApiError);
  });

  it('changes the password, keeps this session and revokes the others', async () => {
    const email = uniqueEmail();
    const { userId, sessionId } = await signup(email);
    const other = await secondSession(email);

    await auth.changePassword(userId, sessionId, password, nextPassword);

    expect(await isSessionLive(sessionId)).toBe(true);
    const otherRow = await prisma.client.sessions.findFirst({ where: { id: other } });
    expect(otherRow?.revoked_at).not.toBeNull();
    expect(otherRow?.revoked_reason).toBe('PASSWORD_CHANGE');

    // The new password works and the old one does not.
    await expect(
      auth.login({ email, password, userAgentHash: null, ipHash: null }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      auth.login({ email, password: nextPassword, userAgentHash: null, ipHash: null }),
    ).resolves.toBeTruthy();
  });

  it('refuses a password change when the current password is wrong', async () => {
    const { userId, sessionId } = await signup(uniqueEmail());
    await expect(
      auth.changePassword(userId, sessionId, 'not the password', nextPassword),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('stages an email change and only moves the identity when the link is consumed', async () => {
    const email = uniqueEmail();
    const { userId } = await signup(email);
    const next = uniqueEmail();

    await auth.changeEmail(userId, next, password);

    // Staged, not applied: the old address is still the login identity.
    const staged = await auth.profile(userId);
    expect(staged.email).toBe(email.toLowerCase());
    expect(staged.pendingEmail).toBe(next.toLowerCase());

    const mail = sent.find((entry) => entry.kind === 'change');
    expect(mail?.to).toBe(next.toLowerCase());
    if (!mail) throw new Error('no change mail was sent');

    await auth.confirmEmailChange(mail.token);

    const moved = await auth.profile(userId);
    expect(moved.email).toBe(next.toLowerCase());
    expect(moved.pendingEmail).toBeNull();
    expect(moved.emailVerified).toBe(true);
  });

  it('refuses a new address that belongs to another account', async () => {
    const first = await signup(uniqueEmail());
    const second = await signup(uniqueEmail());

    const otherEmail = (await auth.profile(second.userId)).email;
    await expect(auth.changeEmail(first.userId, otherEmail, password)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('refuses a confirmation with no staged change', async () => {
    const { userId } = await signup(uniqueEmail());
    const next = uniqueEmail();
    await auth.changeEmail(userId, next, password);
    const mail = sent.find((entry) => entry.kind === 'change');
    if (!mail) throw new Error('no change mail was sent');

    await auth.confirmEmailChange(mail.token);
    // The token is one-shot: replaying it must not move anything a second time.
    await expect(auth.confirmEmailChange(mail.token)).rejects.toBeInstanceOf(ApiError);
  });

  it('lists live sessions, marks the current one, and revokes by owner only', async () => {
    const email = uniqueEmail();
    const { userId, sessionId } = await signup(email);
    await secondSession(email);

    const sessions = await auth.listSessions(userId, sessionId);
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.filter((session) => session.current)).toHaveLength(1);

    // A session id belonging to another account is not revoked by this user.
    const stranger = await signup(uniqueEmail());
    const count = await auth.revokeOwnSession(userId, stranger.sessionId);
    expect(count).toBe(0);
    expect(await isSessionLive(stranger.sessionId)).toBe(true);
  });

  it('revokes every other session but leaves this one', async () => {
    const email = uniqueEmail();
    const { userId, sessionId } = await signup(email);
    const other = await secondSession(email);

    const revoked = await auth.revokeOtherSessions(userId, sessionId);
    expect(revoked).toBeGreaterThanOrEqual(1);
    expect(await isSessionLive(sessionId)).toBe(true);
    expect(await isSessionLive(other)).toBe(false);
  });
});
