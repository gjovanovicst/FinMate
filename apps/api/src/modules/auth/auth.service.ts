import { Inject, Injectable, Logger } from '@nestjs/common';

import { uuidv7 } from '@finmate/domain';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import { resolveCopyLocale, tr } from '../../common/i18n/copy';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { runWithTenant } from '../../common/tenancy/tenant-context';
import { CONFIG, type AppConfig } from '../../config/config';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { MembershipLookup, type Membership } from './membership.lookup';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

export interface AuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresIn: number;
}

export interface AuthenticatedSession {
  readonly userId: string;
  readonly sessionId: string;
  readonly membership: Membership;
}

/** The account's own view of itself — docs/02 §4.18's **Profil** section. */
export interface ProfileView {
  readonly userId: string;
  readonly email: string;
  /** A staged address change awaiting its confirmation link, or `null`. */
  readonly pendingEmail: string | null;
  readonly displayName: string;
  readonly locale: string;
  readonly emailVerified: boolean;
  readonly createdAt: Date;
}

/**
 * One live session, as the profile screen renders it.
 *
 * There is no device label: only hashes of the User-Agent and IP are stored (docs/08 §3.9), so the
 * screen shows when the session started and when it was last used, and nothing it cannot know.
 */
export interface SessionView {
  readonly id: string;
  readonly current: boolean;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
}

/**
 * A hash of a known-unguessable string, used to equalise the cost of a login attempt when the
 * email does not exist. Without it, "no such user" returns in microseconds while a real user costs
 * ~50 ms of argon2id, which is a user-enumeration oracle (docs/08 §2, threat T-02).
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$Zm9yLXRpbWluZy1lcXVhbGlzYXRpb24tb25seQ';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly memberships: MembershipLookup,
    private readonly mail: MailService,
    private readonly rateLimit: RateLimitService,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Signup
  // -------------------------------------------------------------------------------------------

  /**
   * Create a User, their Household, and the OWNER Membership — then log them in.
   *
   * The Household exists from the first request because docs/03 §3.3 and ADR-008 make it the
   * tenancy boundary: a solo user simply has a Household of one. This is what turns "add family
   * sharing" into additive UI rather than a data migration.
   */
  async signup(params: {
    email: string;
    password: string;
    displayName: string;
    /** The reader's language, from the client that signed up. Absent means the product default. */
    locale?: string | null;
    userAgentHash: string | null;
    ipHash: string | null;
  }): Promise<AuthTokens> {
    const strength = this.passwords.validateStrength(params.password);
    if (!strength.ok) throw new ApiError('VALIDATION_FAILED', strength.reason);

    // Resolved once, here: it names the Household below and it is what every later email and
    // notification is written in (ADR-040). Stored as our own locale code rather than the raw tag.
    const copyLocale = resolveCopyLocale(params.locale, resolveCopyLocale(this.config.APP_DEFAULT_LOCALE));

    const email = params.email.trim().toLowerCase();
    const existing = await this.prisma.client.users.findFirst({ where: { email } });
    if (existing) {
      // Signup is the one place enumeration is hard to avoid: the user must be told the address is
      // taken. Rate limiting plus this wording is the mitigation (docs/08 §3).
      throw new ApiError('CONFLICT', 'An account with that email already exists.');
    }

    const passwordHash = await this.passwords.hashPassword(params.password);
    const userId = uuidv7();
    const householdId = uuidv7();

    // The new Household's id is generated here, so the tenancy context can be established BEFORE
    // the first insert — the guard never has to be bypassed, even during signup.
    await runWithTenant(
      { householdId, userId, role: 'OWNER', requestId: `signup:${userId}` },
      async () => {
        await this.prisma.client.$transaction(async (tx) => {
          await tx.users.create({
            data: {
              id: userId,
              email,
              password_hash: passwordHash,
              display_name: params.displayName.trim(),
              // Stored so a later email or notification can be written in the reader's language.
              locale: copyLocale,
            },
          });
          await tx.households.create({
            // Named in the signer's own language. This was the literal `Moje domaćinstvo`, so every
            // English Household was born with a Serbian name that lives in `households.name` forever.
            data: {
              id: householdId,
              name: tr(copyLocale, { en: 'My household', sr: 'Moje domaćinstvo' }),
              ledger_currency: 'RSD',
              owner_user_id: userId,
            },
          });
          await tx.household_members.create({
            data: { id: uuidv7(), household_id: householdId, user_id: userId, role: 'OWNER' },
          });
        });
      },
    );

    await this.issueEmailToken(userId, 'VERIFY_EMAIL');

    return this.startSession({
      userId,
      householdId,
      userAgentHash: params.userAgentHash,
      ipHash: params.ipHash,
    });
  }

  /**
   * Remember the reader's language.
   *
   * The language switcher is client-side (ADR-019), so without this the API never learns the choice and
   * every message it composes later — a verification mail, a password reset, an alert from the daily
   * job — is written in the server's default. The client calls this when the choice changes.
   */
  async updateLocale(userId: string, locale: string): Promise<void> {
    const resolved = resolveCopyLocale(locale, resolveCopyLocale(this.config.APP_DEFAULT_LOCALE));
    await this.prisma.client.users.update({ where: { id: userId }, data: { locale: resolved } });
  }

  // -------------------------------------------------------------------------------------------
  // Profile
  // -------------------------------------------------------------------------------------------

  /**
   * The account's own view of itself (docs/02 §4.18's **Profil** section).
   *
   * `emailVerified` is derived rather than stored as a boolean so the column stays the single
   * source of truth, and `pendingEmail` is exposed so the screen can honestly say a change is
   * waiting for confirmation instead of showing the old address as if nothing had happened.
   */
  async profile(userId: string): Promise<ProfileView> {
    const user = await this.prisma.client.users.findFirst({ where: { id: userId } });
    if (!user) throw new ApiError('NOT_FOUND', 'User not found.');
    return {
      userId: user.id,
      email: user.email,
      pendingEmail: user.pending_email,
      displayName: user.display_name,
      locale: user.locale,
      emailVerified: user.email_verified_at !== null,
      createdAt: user.created_at,
    };
  }

  /** Rename. The only free-text identity field, and the one the shell's account block shows. */
  async updateProfile(userId: string, displayName: string): Promise<void> {
    const trimmed = displayName.trim();
    if (trimmed.length === 0) {
      throw new ApiError('VALIDATION_FAILED', 'Display name is required.');
    }
    await this.prisma.client.users.update({
      where: { id: userId },
      data: { display_name: trimmed },
    });
  }

  /**
   * Change the password, keeping the current session and ending every other one.
   *
   * The current password is required even though the request is already authenticated: a borrowed
   * session must not be able to change the credential that would let the owner take it back
   * (docs/08 §3). Every *other* session is revoked for the same reason a reset revokes all of them —
   * if the old password leaked, whoever else holds a session should not keep it. The caller's own
   * session is deliberately spared, because signing the person out of the device they are typing on
   * is not a security improvement.
   */
  async changePassword(
    userId: string,
    currentSessionId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.client.users.findFirst({ where: { id: userId } });
    if (!user || !user.password_hash) {
      throw new ApiError('UNAUTHENTICATED', 'This account has no password to change.');
    }

    const ok = await this.passwords.verifyPassword(user.password_hash, currentPassword);
    if (!ok) throw new ApiError('UNAUTHENTICATED', 'Current password is incorrect.');

    const strength = this.passwords.validateStrength(newPassword);
    if (!strength.ok) throw new ApiError('VALIDATION_FAILED', strength.reason);

    const passwordHash = await this.passwords.hashPassword(newPassword);
    await this.prisma.client.users.update({
      where: { id: userId },
      data: { password_hash: passwordHash },
    });
    await this.revokeOtherSessionsForUser(userId, currentSessionId, 'PASSWORD_CHANGE');
  }

  /**
   * Begin an email change: remember the new address and mail it a confirmation link.
   *
   * The change is staged in `pending_email` rather than applied here. An address is half of every
   * login, so it is only moved once the mailbox proves it can receive — which is also what makes a
   * typo harmless. Sending to the new address rather than the old one is the point: only someone who
   * can read the mailbox being added may consent to adding it.
   */
  async changeEmail(userId: string, newEmail: string, password: string): Promise<void> {
    const user = await this.prisma.client.users.findFirst({ where: { id: userId } });
    if (!user || !user.password_hash) {
      throw new ApiError('UNAUTHENTICATED', 'This account has no password.');
    }

    const ok = await this.passwords.verifyPassword(user.password_hash, password);
    if (!ok) throw new ApiError('UNAUTHENTICATED', 'Password is incorrect.');

    const next = newEmail.trim().toLowerCase();
    if (next === user.email.toLowerCase()) {
      throw new ApiError('VALIDATION_FAILED', 'That is already your email address.');
    }

    const taken = await this.prisma.client.users.findFirst({ where: { email: next } });
    if (taken && taken.id !== userId) {
      throw new ApiError('CONFLICT', 'An account with that email already exists.');
    }

    await this.prisma.client.users.update({
      where: { id: userId },
      data: { pending_email: next },
    });
    await this.issueEmailToken(userId, 'CHANGE_EMAIL', next);
  }

  /**
   * Confirm a staged email change.
   *
   * Re-checks uniqueness at the moment of the swap, because the address could have been claimed by
   * somebody else in the days between requesting and confirming. The new address is marked verified
   * without a second round trip: the link that reached it *is* the proof.
   */
  async confirmEmailChange(token: string): Promise<void> {
    const userId = await this.consumeEmailToken(token, 'CHANGE_EMAIL');
    const user = await this.prisma.client.users.findFirst({ where: { id: userId } });
    if (!user?.pending_email) {
      // A consumed or superseded request: the token was valid but there is nothing staged.
      throw new ApiError('VALIDATION_FAILED', 'This link is invalid or has expired.');
    }

    const taken = await this.prisma.client.users.findFirst({ where: { email: user.pending_email } });
    if (taken && taken.id !== userId) {
      throw new ApiError('CONFLICT', 'That email address is no longer available.');
    }

    await this.prisma.client.users.update({
      where: { id: userId },
      data: {
        email: user.pending_email,
        pending_email: null,
        email_verified_at: new Date(),
      },
    });
  }

  // -------------------------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------------------------

  /**
   * The account's live sessions, newest activity first.
   *
   * Deliberately no device name: `sessions` stores **hashes** of the User-Agent and IP (docs/08
   * §3.9), so the raw values are not recoverable by design. Showing a plausible-looking "Chrome on
   * macOS" would mean either storing the raw agent or inventing one, and the screen says what it
   * actually knows instead — when the session started and when it was last used.
   */
  async listSessions(userId: string, currentSessionId: string): Promise<SessionView[]> {
    const rows = await this.prisma.client.sessions.findMany({
      where: { user_id: userId, revoked_at: null, expires_at: { gt: new Date() } },
      orderBy: { last_seen_at: 'desc' },
    });
    return rows.map((row) => ({
      id: row.id,
      current: row.id === currentSessionId,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
    }));
  }

  /**
   * End one session the caller owns.
   *
   * Scoped by `user_id` as well as `id`, so a session id from another account is a no-op rather than
   * a cross-account logout. Returns how many rows were revoked; the controller compares the id with
   * the caller's own session to decide whether the client has to sign itself out.
   */
  async revokeOwnSession(userId: string, sessionId: string): Promise<number> {
    const result = await this.prisma.client.sessions.updateMany({
      where: { id: sessionId, user_id: userId, revoked_at: null },
      data: { revoked_at: new Date(), revoked_reason: 'LOGOUT' },
    });
    return result.count;
  }

  /** End every session except the one making the request. */
  async revokeOtherSessions(userId: string, currentSessionId: string): Promise<number> {
    const result = await this.prisma.client.sessions.updateMany({
      where: { user_id: userId, revoked_at: null, id: { not: currentSessionId } },
      data: { revoked_at: new Date(), revoked_reason: 'LOGOUT' },
    });
    return result.count;
  }

  private async revokeOtherSessionsForUser(
    userId: string,
    keepSessionId: string,
    reason: 'PASSWORD_CHANGE',
  ): Promise<void> {
    await this.prisma.client.sessions.updateMany({
      where: { user_id: userId, revoked_at: null, id: { not: keepSessionId } },
      data: { revoked_at: new Date(), revoked_reason: reason },
    });
  }

  // -------------------------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------------------------

  async login(params: {
    email: string;
    password: string;
    userAgentHash: string | null;
    ipHash: string | null;
  }): Promise<AuthTokens> {
    const email = params.email.trim().toLowerCase();

    // Throttle per email AND per IP: per-email alone lets an attacker spray many accounts from one
    // host, and per-IP alone lets a botnet spread across IPs.
    for (const [scope, subject] of [
      ['login:email', email],
      ['login:ip', params.ipHash ?? 'unknown'],
    ] as const) {
      const verdict = await this.rateLimit.consume(
        scope,
        subject,
        this.config.LOGIN_MAX_ATTEMPTS,
        this.config.LOGIN_WINDOW_SECONDS,
      );
      if (!verdict.allowed) {
        throw new ApiError(
          'RATE_LIMITED',
          'Too many login attempts. Please try again later.',
          true,
        );
      }
    }

    const user = await this.prisma.client.users.findFirst({ where: { email } });

    // Always perform a verification, even for an unknown email, so response time does not reveal
    // whether the account exists.
    const passwordOk = user
      ? await this.passwords.verifyPassword(user.password_hash ?? DUMMY_HASH, params.password)
      : await this.passwords.verifyPassword(DUMMY_HASH, params.password);

    if (!user || !user.password_hash || !passwordOk) {
      throw new ApiError('UNAUTHENTICATED', 'Incorrect email or password.');
    }
    if (user.status !== 'ACTIVE') {
      throw new ApiError('FORBIDDEN', 'This account is not active.');
    }

    const membership = await this.memberships.activeMembership(user.id);
    if (!membership) {
      // A user with no Membership cannot be tenanted, so there is no data they may legitimately
      // reach. Failing closed is the correct outcome (docs/03 §3.3).
      this.logger.error(`user ${user.id} has no Membership; refusing login`);
      throw new ApiError('FORBIDDEN', 'This account is not attached to a household.');
    }

    // Transparently upgrade a hash created with weaker parameters.
    if (this.passwords.needsRehash(user.password_hash)) {
      const rehashed = await this.passwords.hashPassword(params.password);
      await this.prisma.client.users.update({ where: { id: user.id }, data: { password_hash: rehashed } });
    }

    await this.rateLimit.reset('login:email', email);

    return this.startSession({
      userId: user.id,
      householdId: membership.householdId,
      userAgentHash: params.userAgentHash,
      ipHash: params.ipHash,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Refresh with rotation and reuse detection
  // -------------------------------------------------------------------------------------------

  /**
   * Exchange a refresh token for a new pair, rotating the token.
   *
   * **Reuse detection.** Rotated tokens are marked `used_at`. If a token that has already been used
   * is presented again, either the legitimate client retried a lost response or an attacker
   * replayed a stolen token — we cannot tell which, so we revoke the entire session. That is the
   * conservative choice: it forces a re-login rather than leaving a thief with a live session
   * (docs/08 §3).
   */
  async refresh(params: {
    refreshToken: string;
    userAgentHash: string | null;
    ipHash: string | null;
  }): Promise<AuthTokens> {
    const presentedHash = this.tokens.hashToken(params.refreshToken);

    const stored = await this.prisma.client.refresh_tokens.findFirst({
      where: { token_hash: presentedHash },
      include: { sessions: true },
    });

    if (!stored) {
      throw new ApiError('UNAUTHENTICATED', 'Invalid session. Please sign in again.');
    }

    const session = stored.sessions;

    if (stored.used_at !== null) {
      this.logger.error(
        `refresh token reuse detected for session ${session.id} (user ${session.user_id}); revoking the session`,
      );
      await this.revokeSession(session.id, 'ROTATION_REUSE');
      throw new ApiError('UNAUTHENTICATED', 'Session ended for security reasons. Please sign in again.');
    }

    if (session.revoked_at !== null || session.expires_at.getTime() <= Date.now()) {
      throw new ApiError('UNAUTHENTICATED', 'Session expired. Please sign in again.');
    }
    if (stored.expires_at.getTime() <= Date.now()) {
      throw new ApiError('UNAUTHENTICATED', 'Session expired. Please sign in again.');
    }

    const membership = await this.memberships.activeMembership(session.user_id);
    if (!membership) throw new ApiError('FORBIDDEN', 'This account is not attached to a household.');

    // Rotate: mark used, issue a successor linked to its predecessor.
    const next = this.tokens.generateRefreshToken();
    const nextId = uuidv7();

    await this.prisma.client.$transaction(async (tx) => {
      // ORDER MATTERS: `rotated_to_id` is a self-referencing foreign key, so the successor row must
      // exist before the predecessor can point at it. Doing the update first fails with
      // `refresh_tokens_rotated_to_id_fkey` (verified by an integration test).
      await tx.refresh_tokens.create({
        data: {
          id: nextId,
          session_id: session.id,
          token_hash: next.hash,
          expires_at: new Date(Date.now() + this.tokens.refreshTokenTtlSeconds() * 1000),
        },
      });
      await tx.refresh_tokens.update({
        where: { id: stored.id },
        data: { used_at: new Date(), rotated_to_id: nextId },
      });
      await tx.sessions.update({ where: { id: session.id }, data: { last_seen_at: new Date() } });
    });

    return {
      accessToken: await this.tokens.signAccessToken({
        userId: session.user_id,
        sessionId: session.id,
      }),
      refreshToken: next.token,
      accessTokenExpiresIn: this.tokens.accessTokenTtlSeconds(),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Logout
  // -------------------------------------------------------------------------------------------

  async logout(sessionId: string): Promise<void> {
    await this.revokeSession(sessionId, 'LOGOUT');
  }

  /** Revoke every session for a user. Used after a password reset. */
  async revokeAllSessionsForUser(userId: string, reason: 'PASSWORD_CHANGE'): Promise<void> {
    await this.prisma.client.sessions.updateMany({
      where: { user_id: userId, revoked_at: null },
      data: { revoked_at: new Date(), revoked_reason: reason },
    });
  }

  private async revokeSession(
    sessionId: string,
    reason: 'LOGOUT' | 'ROTATION_REUSE' | 'ADMIN' | 'PASSWORD_CHANGE' | 'EXPIRED',
  ): Promise<void> {
    await this.prisma.client.sessions.updateMany({
      where: { id: sessionId, revoked_at: null },
      data: { revoked_at: new Date(), revoked_reason: reason },
    });
  }

  // -------------------------------------------------------------------------------------------
  // Email verification and password reset
  // -------------------------------------------------------------------------------------------

  /**
   * Request a password reset.
   *
   * Always reports success, even for an unknown address: this endpoint is unauthenticated, so a
   * different response for a known email would be a free account-enumeration oracle.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    const verdict = await this.rateLimit.consume(
      'password-reset',
      normalized,
      5,
      this.config.LOGIN_WINDOW_SECONDS,
    );
    if (!verdict.allowed) throw new ApiError('RATE_LIMITED', 'Too many requests. Try again later.', true);

    const user = await this.prisma.client.users.findFirst({ where: { email: normalized } });
    if (user) await this.issueEmailToken(user.id, 'RESET_PASSWORD');
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const strength = this.passwords.validateStrength(newPassword);
    if (!strength.ok) throw new ApiError('VALIDATION_FAILED', strength.reason);

    const userId = await this.consumeEmailToken(token, 'RESET_PASSWORD');
    const passwordHash = await this.passwords.hashPassword(newPassword);

    await this.prisma.client.users.update({ where: { id: userId }, data: { password_hash: passwordHash } });

    // A reset implies the old sessions may be compromised. Signing them all out is the safe default.
    await this.revokeAllSessionsForUser(userId, 'PASSWORD_CHANGE');
  }

  async verifyEmail(token: string): Promise<void> {
    const userId = await this.consumeEmailToken(token, 'VERIFY_EMAIL');
    await this.prisma.client.users.update({
      where: { id: userId },
      data: { email_verified_at: new Date() },
    });
  }

  private async issueEmailToken(
    userId: string,
    purpose: 'VERIFY_EMAIL' | 'RESET_PASSWORD' | 'CHANGE_EMAIL',
    /**
     * Where the mail goes, when it is not the account's current address. An email change must reach
     * the **new** mailbox — the old one is not proof that its owner still controls the account — so
     * `CHANGE_EMAIL` passes `pending_email` here.
     */
    to?: string,
  ): Promise<void> {
    const { token, hash } = this.tokens.generateEmailToken();

    // Invalidate outstanding tokens for the same purpose: only the newest link should work.
    await this.prisma.client.email_tokens.updateMany({
      where: { user_id: userId, purpose, consumed_at: null },
      data: { consumed_at: new Date() },
    });
    await this.prisma.client.email_tokens.create({
      data: {
        id: uuidv7(),
        user_id: userId,
        purpose,
        token_hash: hash,
        expires_at: new Date(Date.now() + this.tokens.emailTokenTtlSeconds() * 1000),
      },
    });

    const user = await this.prisma.client.users.findFirst({ where: { id: userId } });
    if (!user) throw new ApiError('NOT_FOUND', 'User not found.');

    // The recipient's stored language: an email is composed once and read later, by someone who may
    // not be the caller. `en` is the column default, so a reader who never chose keeps the primary.
    const locale = resolveCopyLocale(user.locale, resolveCopyLocale(this.config.APP_DEFAULT_LOCALE));
    const recipient = to ?? user.email;
    if (purpose === 'VERIFY_EMAIL') await this.mail.sendEmailVerification(recipient, token, locale);
    else if (purpose === 'RESET_PASSWORD') await this.mail.sendPasswordReset(recipient, token, locale);
    else await this.mail.sendEmailChange(recipient, token, locale);
  }

  private async consumeEmailToken(
    token: string,
    purpose: 'VERIFY_EMAIL' | 'RESET_PASSWORD' | 'CHANGE_EMAIL',
  ): Promise<string> {
    const hash = this.tokens.hashToken(token);
    const stored = await this.prisma.client.email_tokens.findFirst({
      where: { token_hash: hash, purpose },
    });

    if (!stored || stored.consumed_at !== null || stored.expires_at.getTime() <= Date.now()) {
      // One message for every failure mode: unknown, already used, or expired. Distinguishing them
      // tells an attacker whether a guessed token ever existed.
      throw new ApiError('VALIDATION_FAILED', 'This link is invalid or has expired.');
    }

    await this.prisma.client.email_tokens.update({
      where: { id: stored.id },
      data: { consumed_at: new Date() },
    });
    return stored.user_id;
  }

  // -------------------------------------------------------------------------------------------
  // Session creation
  // -------------------------------------------------------------------------------------------

  private async startSession(params: {
    userId: string;
    householdId: string;
    userAgentHash: string | null;
    ipHash: string | null;
  }): Promise<AuthTokens> {
    const sessionId = uuidv7();
    const refresh = this.tokens.generateRefreshToken();

    await this.prisma.client.$transaction(async (tx) => {
      await tx.sessions.create({
        data: {
          id: sessionId,
          user_id: params.userId,
          user_agent_hash: params.userAgentHash,
          ip_hash: params.ipHash,
          expires_at: new Date(Date.now() + this.tokens.refreshTokenTtlSeconds() * 1000),
        },
      });
      await tx.refresh_tokens.create({
        data: {
          id: uuidv7(),
          session_id: sessionId,
          token_hash: refresh.hash,
          expires_at: new Date(Date.now() + this.tokens.refreshTokenTtlSeconds() * 1000),
        },
      });
    });

    return {
      accessToken: await this.tokens.signAccessToken({ userId: params.userId, sessionId }),
      refreshToken: refresh.token,
      accessTokenExpiresIn: this.tokens.accessTokenTtlSeconds(),
    };
  }

  /** Resolve an access token into an authenticated session, or `null`. Used per request. */
  async resolveSession(accessToken: string): Promise<AuthenticatedSession | null> {
    const claims = await this.tokens.verifyAccessToken(accessToken);
    if (!claims) return null;

    const session = await this.prisma.client.sessions.findFirst({
      where: { id: claims.sessionId, user_id: claims.userId },
    });
    if (!session || session.revoked_at !== null || session.expires_at.getTime() <= Date.now()) {
      return null;
    }

    // Authority is read from the database, never from the token, so a role change or a removal
    // takes effect on the next request (docs/08 §3).
    const membership = await this.memberships.activeMembership(claims.userId);
    if (!membership) return null;

    // Best-effort liveness tracking; a failure here must not break the request.
    void this.prisma.client.sessions
      .update({ where: { id: session.id }, data: { last_seen_at: new Date() } })
      .catch(() => undefined);

    return { userId: claims.userId, sessionId: session.id, membership };
  }
}
