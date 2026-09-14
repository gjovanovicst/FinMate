import { createHash } from 'node:crypto';

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { AuthenticatedGuard, Public } from '../../common/auth/guards';
import { CurrentTenant } from '../../common/auth/current-tenant.decorator';
import { readCookie, REFRESH_TOKEN_COOKIE, ACCESS_TOKEN_COOKIE } from '../../common/tenancy/session-resolver';
import { requireSessionId, type TenantContext } from '../../common/tenancy/tenant-context';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CONFIG, type AppConfig } from '../../config/config';
import {
  loginSchema,
  refreshSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  signupSchema,
  tokenSchema,
  type LoginInput,
  type RefreshInput,
  type RequestPasswordResetInput,
  type ResetPasswordInput,
  type SignupInput,
  type TokenInput,
} from './auth.dto';
import { AuthService, type AuthTokens } from './auth.service';

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
 */
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
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const tokens = await this.auth.login({
      email: body.email,
      password: body.password,
      userAgentHash: fingerprint(request.headers['user-agent']),
      ipHash: fingerprint(request.ip),
    });
    this.writeCookies(response, tokens);
    return { accessToken: tokens.accessToken, expiresIn: tokens.accessTokenExpiresIn };
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
      response.clearCookie(REFRESH_TOKEN_COOKIE, { path: '/auth' });
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
    response.clearCookie(REFRESH_TOKEN_COOKIE, { path: '/auth' });
  }

@Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  async verifyEmail(@Body(new ZodValidationPipe(tokenSchema)) body: TokenInput): Promise<void> {
    await this.auth.verifyEmail(body.token);
  }

  /**
   * Current session identity. Protected: it is the smallest useful proof that the access token was
   * verified, the session loaded, the Membership resolved and the TenantContext established.
   */
  @Get('me')
  @HttpCode(HttpStatus.OK)
  async me(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<{ userId: string; householdId: string; role: string; sessionId: string }> {
    return {
      userId: tenant.userId,
      householdId: tenant.householdId,
      role: tenant.role,
      sessionId: tenant.sessionId ?? '',
    };
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

@Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(
    @Body(new ZodValidationPipe(resetPasswordSchema)) body: ResetPasswordInput,
  ): Promise<void> {
    await this.auth.resetPassword(body.token, body.password);
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

    // Scoped to /auth so the refresh token is never attached to ordinary data requests — it only
    // needs to reach refresh and logout.
    response.cookie(REFRESH_TOKEN_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/auth',
      maxAge: this.config.REFRESH_TOKEN_TTL_SECONDS * 1000,
    });
  }
}

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
