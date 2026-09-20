import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { runWithTenant } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { AuthModule } from './auth.module';
import { AuthService } from './auth.service';
import { totpCode } from './totp';

/**
 * Two-factor authentication end to end, against a real database (ADR-041).
 *
 * The algorithm itself is pinned by RFC 6238's vectors in `totp.spec.ts`; what only an integration
 * test can prove is the *flow*: that a correct password with a factor on mints **no session**, that a
 * challenge is single-use, that a recovery code works exactly once, and that the stored secret is
 * ciphertext rather than the shared secret.
 *
 * `MFA_ENCRYPTION_KEY` is set before the config module loads, because the authenticator factor is
 * deliberately unavailable without it.
 */
process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');

describe('two-factor authentication (integration)', () => {
  let moduleRef: TestingModule;
  let auth: AuthService;
  let prisma: PrismaService;
  let rateLimit: RateLimitService;

  const sent: { kind: 'verify' | 'reset' | 'change' | 'login'; to: string; value: string }[] = [];
  const created: { userId: string; householdId: string }[] = [];
  const password = 'correct horse battery staple';

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule, AuthModule],
    })
      .overrideProvider(MailService)
      .useValue({
        sendEmailVerification: async (to: string, token: string) => {
          sent.push({ kind: 'verify', to, value: token });
        },
        sendPasswordReset: async (to: string, token: string) => {
          sent.push({ kind: 'reset', to, value: token });
        },
        sendEmailChange: async (to: string, token: string) => {
          sent.push({ kind: 'change', to, value: token });
        },
        sendLoginCode: async (to: string, code: string) => {
          sent.push({ kind: 'login', to, value: code });
        },
        sendNotification: async () => undefined,
      })
      .compile();

    auth = moduleRef.get(AuthService);
    prisma = moduleRef.get(PrismaService);
    rateLimit = moduleRef.get(RateLimitService);
  });

  afterAll(async () => {
    for (const { userId, householdId } of created) {
      await runWithTenant({ householdId, userId, role: 'OWNER', requestId: 'test-teardown' }, async () => {
        await prisma.client.households.deleteMany({ where: { id: householdId } });
      });
    }
    const ids = created.map((entry) => entry.userId);
    if (ids.length > 0) await prisma.client.users.deleteMany({ where: { id: { in: ids } } });
    await moduleRef?.close();
  });

  beforeEach(async () => {
    sent.length = 0;
    // Redis-backed and shared by the per-IP scope, so it outlives a run (see the profile spec).
    await rateLimit.reset('login:ip', 'unknown');
  });

  const uniqueEmail = (): string => `mfa-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const nowCode = (secret: string): string => totpCode(secret, Math.floor(Date.now() / 1000 / 30));
  const lastLoginCode = (): string | undefined =>
    sent.filter((entry) => entry.kind === 'login').slice(-1)[0]?.value;

  async function signup(): Promise<{ userId: string; email: string }> {
    const email = uniqueEmail();
    await auth.signup({ email, password, displayName: 'MFA Test', userAgentHash: null, ipHash: null });
    const user = await prisma.client.users.findFirst({ where: { email } });
    if (!user) throw new Error('signup did not create a user');
    const memberships = await prisma.client.$queryRaw<{ household_id: string }[]>`
      SELECT household_id FROM household_members WHERE user_id = ${user.id}::uuid
    `;
    const householdId = memberships[0]?.household_id;
    if (householdId) created.push({ userId: user.id, householdId });
    return { userId: user.id, email };
  }

  /** Enable TOTP and return the secret plus the recovery codes the API handed back once. */
  async function enableTotp(userId: string): Promise<{ secret: string; recoveryCodes: string[] }> {
    const setup = await auth.startTotpSetup(userId, password);
    const recoveryCodes = await auth.enableTotp(userId, password, nowCode(setup.secret));
    return { secret: setup.secret, recoveryCodes };
  }

  async function challengeFor(email: string) {
    const outcome = await auth.login({ email, password, userAgentHash: null, ipHash: null });
    if (outcome.kind !== 'mfa') throw new Error('expected a second-factor challenge');
    return outcome.challenge;
  }

  it('mints no session while a second factor is on, and none of the stored secret is plaintext', async () => {
    const { userId, email } = await signup();
    const { secret } = await enableTotp(userId);

    const stored = await prisma.client.users.findFirst({ where: { id: userId } });
    expect(stored?.totp_secret).not.toBeNull();
    expect(stored?.totp_secret).not.toContain(secret);
    expect(stored?.totp_secret?.startsWith('v1.')).toBe(true);
    expect(stored?.totp_confirmed_at).not.toBeNull();

    const outcome = await auth.login({ email, password, userAgentHash: null, ipHash: null });
    expect(outcome.kind).toBe('mfa');
  });

  it('completes login with a current authenticator code', async () => {
    const { userId, email } = await signup();
    const { secret } = await enableTotp(userId);
    const challenge = await challengeFor(email);

    expect(challenge.methods).toContain('TOTP');
    expect(challenge.emailHint).toBe(`${email.slice(0, 1)}***${email.slice(email.indexOf('@'))}`);
    expect(challenge.challengeToken.length).toBeGreaterThan(20);

    const tokens = await auth.verifyMfa({
      challengeToken: challenge.challengeToken,
      code: nowCode(secret),
      userAgentHash: null,
      ipHash: null,
    });
    expect(await auth.resolveSession(tokens.accessToken)).not.toBeNull();
  });

  it('refuses a wrong code and kills the challenge after the attempt cap', async () => {
    const { userId, email } = await signup();
    const { secret } = await enableTotp(userId);
    const challenge = await challengeFor(email);

    const wrong = (code: string) =>
      auth.verifyMfa({
        challengeToken: challenge.challengeToken,
        code,
        userAgentHash: null,
        ipHash: null,
      });

    // Four wrong codes are simply wrong; the fifth is the cap and says so, because "start again" is
    // the actionable answer and one more try cannot work.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(wrong('000000')).rejects.toMatchObject({ code: 'MFA_INVALID_CODE' });
    }
    await expect(wrong('000000')).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    // The challenge is spent, so even the right code is refused now.
    await expect(wrong(nowCode(secret))).rejects.toBeInstanceOf(ApiError);
  });

  it('consumes a challenge, so a code cannot be replayed', async () => {
    const { userId, email } = await signup();
    const { secret } = await enableTotp(userId);
    const challenge = await challengeFor(email);
    const code = nowCode(secret);

    await auth.verifyMfa({ challengeToken: challenge.challengeToken, code, userAgentHash: null, ipHash: null });
    await expect(
      auth.verifyMfa({ challengeToken: challenge.challengeToken, code, userAgentHash: null, ipHash: null }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('accepts a recovery code exactly once and counts it down', async () => {
    const { userId, email } = await signup();
    const { recoveryCodes } = await enableTotp(userId);

    expect(recoveryCodes).toHaveLength(10);
    expect((await auth.mfaState(userId)).recoveryCodesRemaining).toBe(10);

    const first = await challengeFor(email);
    await auth.verifyMfa({
      challengeToken: first.challengeToken,
      // Presented the way a person types it back, not byte-identical to what was minted.
      code: recoveryCodes[0]!.toLowerCase().replace(/-/g, ' '),
      userAgentHash: null,
      ipHash: null,
    });

    expect((await auth.mfaState(userId)).recoveryCodesRemaining).toBe(9);

    const second = await challengeFor(email);
    await expect(
      auth.verifyMfa({
        challengeToken: second.challengeToken,
        code: recoveryCodes[0]!,
        userAgentHash: null,
        ipHash: null,
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('offers the emailed code, sends it, and accepts it', async () => {
    const { userId, email } = await signup();
    await enableTotp(userId);
    const minted = await auth.setEmailOtp(userId, password, true);
    // A factor was already on, so no new codes were minted by the second one.
    expect(minted).toHaveLength(0);

    const challenge = await challengeFor(email);
    expect(challenge.methods).toEqual(expect.arrayContaining(['TOTP', 'EMAIL']));

    await auth.resendMfaEmailCode(challenge.challengeToken);
    const code = lastLoginCode();
    expect(code).toMatch(/^\d{6}$/);

    const tokens = await auth.verifyMfa({
      challengeToken: challenge.challengeToken,
      code: code!,
      userAgentHash: null,
      ipHash: null,
    });
    expect(await auth.resolveSession(tokens.accessToken)).not.toBeNull();
  });

  it('mails the code straight away when email is the only factor', async () => {
    const { userId, email } = await signup();
    const minted = await auth.setEmailOtp(userId, password, true);
    // First factor on: recovery codes come with it, so losing the mailbox is not a dead end.
    expect(minted).toHaveLength(10);

    const challenge = await challengeFor(email);
    expect(challenge.methods).toEqual(['EMAIL']);
    expect(lastLoginCode()).toMatch(/^\d{6}$/);
  });

  it('turns factors off, and drops the recovery codes when the last one goes', async () => {
    const { userId, email } = await signup();
    await enableTotp(userId);

    await auth.disableTotp(userId, password);
    let state = await auth.mfaState(userId);
    expect(state.totpEnabled).toBe(false);
    // TOTP gone and email never on: the account has no second factor, so the codes go too.
    expect(state.recoveryCodesRemaining).toBe(0);

    // And a login no longer challenges.
    const outcome = await auth.login({ email, password, userAgentHash: null, ipHash: null });
    expect(outcome.kind).toBe('session');

    await auth.setEmailOtp(userId, password, true);
    state = await auth.mfaState(userId);
    expect(state.emailOtpEnabled).toBe(true);
    await auth.setEmailOtp(userId, password, false);
    expect((await auth.mfaState(userId)).emailOtpEnabled).toBe(false);
  });

  it('re-authenticates every factor change', async () => {
    const { userId } = await signup();
    await expect(auth.startTotpSetup(userId, 'not the password')).rejects.toBeInstanceOf(ApiError);
    await expect(auth.setEmailOtp(userId, 'not the password', true)).rejects.toBeInstanceOf(ApiError);
    await expect(auth.regenerateRecoveryCodes(userId, 'not the password')).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it('refuses a recovery-code regeneration with no factor on', async () => {
    const { userId } = await signup();
    await expect(auth.regenerateRecoveryCodes(userId, password)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
