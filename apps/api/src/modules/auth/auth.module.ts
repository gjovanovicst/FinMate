import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { RedisService } from '../../common/redis/redis.service';
import { SESSION_RESOLVER } from '../../common/tenancy/session-resolver';
import { CONFIG, type AppConfig } from '../../config/config';
import { MailService } from '../mail/mail.service';
import { AuthSessionResolver } from './auth-session.resolver';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MembershipLookup } from './membership.lookup';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

/**
 * Authentication, sessions and tenancy resolution.
 *
 * `@Global` because two cross-cutting concerns depend on it and neither can import a feature
 * module: `SESSION_RESOLVER` is consumed by the tenancy middleware, and `RateLimitService` is used
 * by other modules' write paths (AI quota in Phase 2).
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [CONFIG],
      useFactory: (config: AppConfig) => ({ secret: config.JWT_SECRET }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthSessionResolver,
    MembershipLookup,
    PasswordService,
    TokenService,
    MailService,
    RedisService,
    RateLimitService,
    // The seam the tenancy middleware consumes. `useExisting` keeps a single AuthSessionResolver
    // instance rather than constructing a second one.
    { provide: SESSION_RESOLVER, useExisting: AuthSessionResolver },
  ],
  exports: [AuthService, TokenService, PasswordService, MembershipLookup, MailService, RedisService, RateLimitService, SESSION_RESOLVER],
})
export class AuthModule {}
