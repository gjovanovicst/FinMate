import { createHash } from 'node:crypto';

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { AllowUnverified, AuthenticatedGuard, Public } from '../../common/auth/guards';
import { CurrentTenant } from '../../common/auth/current-tenant.decorator';
import { readCookie, REFRESH_TOKEN_COOKIE, ACCESS_TOKEN_COOKIE } from '../../common/tenancy/session-resolver';
import { requireSessionId, type TenantContext } from '../../common/tenancy/tenant-context';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CONFIG, type AppConfig } from '../../config/config';
import {
  changeEmailSchema,
  changePasswordSchema,
  loginSchema,
  mfaChallengeSchema,
  mfaEmailToggleSchema,
  mfaEnableTotpSchema,
  mfaPasswordSchema,
  mfaVerifySchema,
  refreshSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  signupSchema,
  tokenSchema,
  updateLocaleSchema,
  updateProfileSchema,
  uuidSchema,
  type ChangeEmailInput,
  type ChangePasswordInput,
  type LoginInput,
  type MfaChallengeInput,
  type MfaEmailToggleInput,
  type MfaEnableTotpInput,
  type MfaPasswordInput,
  type MfaVerifyInput,
  type RefreshInput,
  type RequestPasswordResetInput,
  type ResetPasswordInput,
  type SignupInput,
  type TokenInput,
  type UpdateLocaleInput,
  type UpdateProfileInput,
} from './auth.dto';
import {
  AuthService,
  type AuthTokens,
  type MfaMethod,
  type MfaState,
  type ProfileView,
  type SessionView,
} from './auth.service';

/**
 * Authentication endpoints — REST, not GraphQL.
 *
 * Deviation from docs/06 §2, which sketched these as GraphQL mutations, and deliberate: session
 * handling needs to set and clear `httpOnly` cookies, and cookie semantics sit awkwardly in a
 * GraphQL response where every operation shares one envelope. Keeping auth on REST also means the
 * refresh cookie can be scoped to `/auth`, so it is not attached to every data request. Recorded in
 * docs/06 §2.
 *
 * Rate limiting lives in `AuthService` rather than in a decorator, because the limiter needs the
 * email address and the IP hash — request-level metadata a guard cannot see cleanly.
 *
 * The whole controller is `@AllowUnverified()`: when this deployment requires a confirmed address
 * (`REQUIRE_EMAIL_VERIFICATION`), an unconfirmed account must still be able to see its own state,
 * resend the link, fix a typo, change its password and sign out. What it cannot reach is anybody's
 * data — the guard refuses every other route, GraphQL included.
 */
@AllowUnverified()
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly auth: AuthService,
  ) {}

@Public()
  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  async signup(
    @Body(new ZodValidationPipe(signupSchema)) body: SignupInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const tokens = await this.auth.signup({
      email: body.email,
      password: body.password,
      displayName: body.displayName,
      locale: body.locale ?? null,
      // Pre-filled by the client from the reader's locale; the service validates it before it becomes
      // the Household's ledger currency (ADR-045).
      currency: body.currency ?? null,
      userAgentHash: fingerprint(request.headers['user-agent']),
      ipHash: fingerprint(request.ip),
    });
    this.writeCookies(response, tokens);
    return { accessToken: tokens.accessToken, expiresIn: tokens.accessTokenExpiresIn };
  }

@Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponseBody> {
    const outcome = await this.auth.login({
      email: body.email,
      password: body.password,
      userAgentHash: fingerprint(request.headers['user-agent']),
      ipHash: fingerprint(request.ip),
    });

    // A correct password with a second factor on mints **no** session and sets **no** cookie: the
    // only thing the client holds is the single-use challenge (ADR-041).
    if (outcome.kind === 'mfa') {
      return {
        mfaRequired: true,
        challengeToken: outcome.challenge.challengeToken,
        methods: outcome.challenge.methods,
        emailHint: outcome.challenge.emailHint,
        expiresAt: outcome.challenge.expiresAt.toISOString(),
      };
    }

    this.writeCookies(response, outcome.tokens);
    return {
      mfaRequired: false,
      accessToken: outcome.tokens.accessToken,
      expiresIn: outcome.tokens.accessTokenExpiresIn,
    };
  }

  /**
   * Complete a two-factor login.
   *
   * Public, because at this point the caller has no session by construction — the challenge token is
   * the credential. The code may be a TOTP code, an emailed code or a recovery code; the service
   * decides which from the challenge, not from anything the client claims.
   */
@Public()
  @Post('login/mfa')
  @HttpCode(HttpStatus.OK)
  async verifyMfa(
    @Body(new ZodValidationPipe(mfaVerifySchema)) body: MfaVerifyInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const tokens = await this.auth.verifyMfa({
      challengeToken: body.challengeToken,
      code: body.code,
      userAgentHash: fingerprint(request.headers['user-agent']),
      ipHash: fingerprint(request.ip),
    });
    this.writeCookies(response, tokens);
    return { accessToken: tokens.accessToken, expiresIn: tokens.accessTokenExpiresIn };
  }

  /** Send a fresh emailed code for a live challenge. Public, for the same reason as `login/mfa`. */
@Public()
  @Post('login/mfa/resend')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resendMfaCode(
    @Body(new ZodValidationPipe(mfaChallengeSchema)) body: MfaChallengeInput,
  ): Promise<void> {
    await this.auth.resendMfaEmailCode(body.challengeToken);
  }

@Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body(new ZodValidationPipe(refreshSchema)) body: RefreshInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const presented = body.refreshToken ?? readCookie(request, REFRESH_TOKEN_COOKIE);
    if (!presented) {
      // No token at all: respond as unauthenticated without touching the AuthService.
      response.clearCookie(ACCESS_TOKEN_COOKIE, { path: '/' });
      response.clearCookie(REFRESH_TOKEN_COOKIE, { path: this.refreshCookiePath() });
      return { accessToken: '', expiresIn: 0 };
    }

    const tokens = await this.auth.refresh({
      refreshToken: presented,
      userAgentHash: fingerprint(request.headers['user-agent']),
      ipHash: fingerprint(request.ip),
    });
    this.writeCookies(response, tokens);
    return { accessToken: tokens.accessToken, expiresIn: tokens.accessTokenExpiresIn };
  }

  /**
   * Log out.
   *
   * Works from either credential: an authenticated access token revokes the current session, and a
   * refresh token revokes the session it belongs to. The second path matters because a user whose
   * access token has already expired must still be able to end their session.
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AuthenticatedGuard)
  async logout(@Res({ passthrough: true }) response: Response): Promise<void> {
    await this.auth.logout(requireSessionId('auth.logout'));
    response.clearCookie(ACCESS_TOKEN_COOKIE, { path: '/' });
    response.clearCookie(REFRESH_TOKEN_COOKIE, { path: this.refreshCookiePath() });
  }

@Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  async verifyEmail(@Body(new ZodValidationPipe(tokenSchema)) body: TokenInput): Promise<void> {
    await this.auth.verifyEmail(body.token);
  }

  /**
   * Send a fresh confirmation link to this account's own address.
   *
   * Authenticated, so the address is the session's and never the caller's input — no open relay, no
   * enumeration oracle. 204 whatever happens (including an already-confirmed address), because the
   * only thing a different answer could reveal is something about their own account that they can
   * already see on `/profile`.
   */
  @Post('resend-verification')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resendVerification(@CurrentTenant() tenant: TenantContext): Promise<void> {
    await this.auth.resendVerification(tenant.userId);
  }

  /**
   * Current session identity. Protected: it is the smallest useful proof that the access token was
   * verified, the session loaded, the Membership resolved and the TenantContext established.
   */
  @Get('me')
  @HttpCode(HttpStatus.OK)
  async me(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<{
    userId: string;
    householdId: string;
    role: string;
    sessionId: string;
    email: string;
    displayName: string;
    locale: string;
    emailVerified: boolean;
    pendingEmail: string | null;
    /**
     * Whether **this deployment** refuses an unconfirmed account (`REQUIRE_EMAIL_VERIFICATION`).
     *
     * Exposed so the client can tell an advisory state from a blocking one: with it false the
     * interface says nothing about confirming an address, because nothing is waiting on it. It is a
     * deployment capability, like `pushPublicKey`, not a property of the account.
     */
    emailVerificationRequired: boolean;
  }> {
    // The session's own identity plus the account fields the shell renders (its account block shows
    // the display name since 0.6.4) and the profile screen edits. One read, because every caller of
    // `me` needs the session and the shell needs the name on the same page load.
    const profile = await this.auth.profile(tenant.userId);
    return {
      userId: tenant.userId,
      householdId: tenant.householdId,
      role: tenant.role,
      sessionId: tenant.sessionId ?? '',
      email: profile.email,
      displayName: profile.displayName,
      locale: profile.locale,
      emailVerified: profile.emailVerified,
      pendingEmail: profile.pendingEmail,
      emailVerificationRequired: this.config.REQUIRE_EMAIL_VERIFICATION,
    };
  }

  /** The account's own profile — docs/02 §4.18's **Profil** section. */
  @Get('profile')
  @HttpCode(HttpStatus.OK)
  async profile(@CurrentTenant() tenant: TenantContext): Promise<ProfileView> {
    return this.auth.profile(tenant.userId);
  }

  /** Rename. The only free-text identity field; 204 because there is nothing to return. */
  @Patch('profile')
  @HttpCode(HttpStatus.NO_CONTENT)
  async updateProfile(
    @Body(new ZodValidationPipe(updateProfileSchema)) body: UpdateProfileInput,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<void> {
    await this.auth.updateProfile(tenant.userId, body.displayName);
  }

  /**
   * Change the password.
   *
   * Requires the **current** password even though the request is authenticated (docs/08 §3): a
   * borrowed session must not let someone change the credential that would take the account back.
   * Every other session is revoked; this one is kept.
   */
  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordInput,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<void> {
    await this.auth.changePassword(
      tenant.userId,
      requireSessionId('auth.changePassword'),
      body.currentPassword,
      body.newPassword,
    );
  }

  /**
   * Start an email change: stage the new address and mail it a confirmation link.
   *
   * 204 and not the staged address: the only thing that has happened is that a message is on its way.
   */
  @Post('change-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changeEmail(
    @Body(new ZodValidationPipe(changeEmailSchema)) body: ChangeEmailInput,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<void> {
    await this.auth.changeEmail(tenant.userId, body.email, body.password);
  }

  /** Confirm a staged email change. Public: the link is clicked from a mailbox, with or without a session. */
  @Public()
  @Post('confirm-email-change')
  @HttpCode(HttpStatus.NO_CONTENT)
  async confirmEmailChange(
    @Body(new ZodValidationPipe(tokenSchema)) body: TokenInput,
  ): Promise<void> {
    await this.auth.confirmEmailChange(body.token);
  }

  /** The account's live sessions, for the profile screen's **Active sessions** list. */
  @Get('sessions')
  @HttpCode(HttpStatus.OK)
  async sessions(@CurrentTenant() tenant: TenantContext): Promise<readonly SessionView[]> {
    return this.auth.listSessions(tenant.userId, tenant.sessionId ?? '');
  }

  /** End every session except this one. */
  @Post('sessions/revoke-others')
  @HttpCode(HttpStatus.OK)
  async revokeOtherSessions(@CurrentTenant() tenant: TenantContext): Promise<{ revoked: number }> {
    const revoked = await this.auth.revokeOtherSessions(
      tenant.userId,
      requireSessionId('auth.revokeOtherSessions'),
    );
    return { revoked };
  }

  /**
   * End one session.
   *
   * `current` tells the client whether it just ended the session it is using — the one case where it
   * must sign itself out rather than simply refresh the list.
   */
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.OK)
  async revokeSession(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<{ revoked: boolean; current: boolean }> {
    const count = await this.auth.revokeOwnSession(tenant.userId, id);
    return { revoked: count > 0, current: id === tenant.sessionId };
  }

  // -------------------------------------------------------------------------------------------
  // Two-factor authentication (ADR-041). All under `/auth`, so `@AllowUnverified()` covers them: an
  // unconfirmed account must still be able to secure itself. Every mutation re-authenticates.
  // -------------------------------------------------------------------------------------------

  /** What the profile screen shows about this account's second factors. */
  @Get('mfa')
  @HttpCode(HttpStatus.OK)
  async mfa(@CurrentTenant() tenant: TenantContext): Promise<MfaState> {
    return this.auth.mfaState(tenant.userId);
  }

  /**
   * Begin enrolling an authenticator app: returns the secret and its `otpauth://` URI **once**.
   *
   * The client renders the URI as a QR code; the server never sees a code at this step and stores
   * only the encrypted secret, unconfirmed.
   */
  @Post('mfa/totp/setup')
  @HttpCode(HttpStatus.OK)
  async setupTotp(
    @Body(new ZodValidationPipe(mfaPasswordSchema)) body: MfaPasswordInput,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<{ secret: string; otpauthUri: string }> {
    return this.auth.startTotpSetup(tenant.userId, body.password);
  }

  /** Confirm the authenticator with one code and receive the recovery codes, once. */
  @Post('mfa/totp/enable')
  @HttpCode(HttpStatus.OK)
  async enableTotp(
    @Body(new ZodValidationPipe(mfaEnableTotpSchema)) body: MfaEnableTotpInput,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<{ recoveryCodes: string[] }> {
    return { recoveryCodes: await this.auth.enableTotp(tenant.userId, body.password, body.code) };
  }

  @Post('mfa/totp/disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  async disableTotp(
    @Body(new ZodValidationPipe(mfaPasswordSchema)) body: MfaPasswordInput,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<void> {
    await this.auth.disableTotp(tenant.userId, body.password);
  }

  /**
   * Turn the emailed-code factor on or off.
   *
   * Returns recovery codes when enabling minted them, and an empty list otherwise — so the screen can
   * show them once without a second round trip.
   */
  @Post('mfa/email')
  @HttpCode(HttpStatus.OK)
  async setEmailOtp(
    @Body(new ZodValidationPipe(mfaEmailToggleSchema)) body: MfaEmailToggleInput,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<{ recoveryCodes: string[] }> {
    return {
      recoveryCodes: await this.auth.setEmailOtp(tenant.userId, body.password, body.enabled),
    };
  }

  /** Replace every unused recovery code with a fresh set, returned once. */
  @Post('mfa/recovery-codes')
  @HttpCode(HttpStatus.OK)
  async regenerateRecoveryCodes(
    @Body(new ZodValidationPipe(mfaPasswordSchema)) body: MfaPasswordInput,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<{ recoveryCodes: string[] }> {
    return { recoveryCodes: await this.auth.regenerateRecoveryCodes(tenant.userId, body.password) };
  }

  /** Always 204, even for an unknown address — see `AuthService.requestPasswordReset`. */
@Public()
  @Post('request-password-reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  async requestPasswordReset(
    @Body(new ZodValidationPipe(requestPasswordResetSchema)) body: RequestPasswordResetInput,
  ): Promise<void> {
    await this.auth.requestPasswordReset(body.email);
  }

  /**
   * Persist the signed-in reader's language (ADR-040).
   *
   * The switcher itself is a client signal (ADR-019) and needs no round trip to work; this exists so
   * the copy the **server** composes later is written in the same language. 204: there is nothing to
   * return, and a failure is a plain validation error.
   */
  @Post('locale')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AuthenticatedGuard)
  async updateLocale(
    @Body(new ZodValidationPipe(updateLocaleSchema)) body: UpdateLocaleInput,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<void> {
    await this.auth.updateLocale(tenant.userId, body.locale);
  }

@Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordSchema)) body: ResetPasswordInput,
  ): Promise<void> {
    await this.auth.resetPassword(body.token, body.password);
  }

  /**
   * Where the browser must send the refresh token, in the browser's own terms.
   *
   * `/auth` when the API is mounted at the root, `/api/auth` when a proxy exposes it under `/api` — which
   * is the dev setup, and the reason a hard reload used to sign the user out (R-26, task 4.3.5). The
   * *clear* has to use the same path: a browser only deletes a cookie whose attributes match, so a logout
   * that cleared `/auth` while the cookie lived at `/api/auth` would leave the refresh token in place.
   */
  private refreshCookiePath(): string {
    return `${this.config.PUBLIC_API_PREFIX}/auth`;
  }

  private writeCookies(response: Response, tokens: AuthTokens): void {
    const secure = this.config.NODE_ENV === 'production';

    response.cookie(ACCESS_TOKEN_COOKIE, tokens.accessToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: tokens.accessTokenExpiresIn * 1000,
    });

    // Scoped to the auth routes so the refresh token is never attached to ordinary data requests — it
    // only needs to reach refresh and logout — but scoped by the path the *browser* sees, not the one the
    // API serves internally (R-26).
    response.cookie(REFRESH_TOKEN_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: this.refreshCookiePath(),
      maxAge: this.config.REFRESH_TOKEN_TTL_SECONDS * 1000,
    });
  }
}

/**
 * What `POST /auth/login` answers.
 *
 * A discriminated union on `mfaRequired`, so a client cannot read `accessToken` off a challenge
 * response by accident — with a second factor on, there is no token yet and no cookie is set.
 */
export type LoginResponseBody =
  | { readonly mfaRequired: false; readonly accessToken: string; readonly expiresIn: number }
  | {
      readonly mfaRequired: true;
      readonly challengeToken: string;
      readonly methods: readonly MfaMethod[];
      /** `a***@example.com`, never the full address: the login screen is reachable by a stranger. */
      readonly emailHint: string;
      readonly expiresAt: string;
    };

/**
 * Hash a request fingerprint (IP or User-Agent) before it is stored.
 *
 * docs/03 requires `ip_hash` and `user_agent_hash` columns — never the raw values. Sessions must be
 * identifiable for theft detection without turning the database into a location history.
 */
function fingerprint(value: string | undefined): string | null {
  if (!value) return null;
  return createHash('sha256').update(value).digest('hex');
}
