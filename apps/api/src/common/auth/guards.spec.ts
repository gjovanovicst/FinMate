import { describe, expect, it } from 'vitest';

import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';

import { ApiError } from '../filters/all-exceptions.filter';
import { runWithTenant, type TenantContext } from '../tenancy/tenant-context';
import { AuthenticatedGuard, EmailVerifiedGuard, Roles, RolesGuard } from './guards';

const CONTEXT: TenantContext = {
  householdId: '11111111-1111-7111-8111-111111111111',
  userId: '22222222-2222-7222-8222-222222222222',
  role: 'MEMBER',
  sessionId: '33333333-3333-7333-8333-333333333333',
  requestId: 'req-1',
};

/** Minimal ExecutionContext stand-in — the guards only ever read handler/class metadata. */
function executionContext(handler = function handler(): void {}, cls = class Test {}): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({}) as never,
    getArgs: () => [],
    getArgByIndex: () => undefined,
    switchToRpc: () => ({}) as never,
    switchToWs: () => ({}) as never,
    getType: () => 'http',
  } as unknown as ExecutionContext;
}

describe('AuthenticatedGuard (deny by default)', () => {
  const guard = new AuthenticatedGuard(new Reflector());

  it('rejects a request with no TenantContext', () => {
    expect(() => guard.canActivate(executionContext())).toThrow(ApiError);
    expect(() => guard.canActivate(executionContext())).toThrow(/Authentication required/);
  });

  it('reports UNAUTHENTICATED so the client can trigger a refresh', () => {
    try {
      guard.canActivate(executionContext());
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as ApiError).code).toBe('UNAUTHENTICATED');
    }
  });

  it('allows a request inside a tenanted scope', () => {
    runWithTenant(CONTEXT, () => {
      expect(guard.canActivate(executionContext())).toBe(true);
    });
  });

  it('allows a route explicitly marked @Public(), so login stays reachable', () => {
    class PublicController {}
    const handler = function login(): void {};
    Reflect.defineMetadata('finmate:public', true, handler);

    // The real Reflector reads this metadata; assert the guard consults it at all.
    const reflector = new Reflector();
    expect(reflector.getAllAndOverride('finmate:public', [handler, PublicController])).toBe(true);
    expect(guard.canActivate(executionContext(handler, PublicController))).toBe(true);
  });
});

describe('RolesGuard (docs/06 §11 role matrix)', () => {
  it('allows a route with no @Roles requirement', () => {
    const guard = new RolesGuard(new Reflector());
    expect(guard.canActivate(executionContext())).toBe(true);
  });

  it('rejects when there is no authenticated context', () => {
    class C {}
    const handler = function handler(): void {};
    Roles('OWNER')(handler, 'handler');
    const guard = new RolesGuard(new Reflector());
    expect(() => guard.canActivate(executionContext(handler, C))).toThrow(/Authentication required/);
  });

  it('allows when the role matches', () => {
    class C {}
    const handler = function handler(): void {};
    Roles('MEMBER', 'OWNER')(handler, 'handler');
    const guard = new RolesGuard(new Reflector());
    runWithTenant(CONTEXT, () => {
      expect(guard.canActivate(executionContext(handler, C))).toBe(true);
    });
  });

  it('rejects with FORBIDDEN when the role does not match', () => {
    class C {}
    const handler = function handler(): void {};
    Roles('OWNER')(handler, 'handler');
    const guard = new RolesGuard(new Reflector());

    runWithTenant(CONTEXT, () => {
      // CONTEXT is a MEMBER, and AI consent / provider routing are OWNER-only (Q-11).
      expect(() => guard.canActivate(executionContext(handler, C))).toThrow(/does not permit/);
    });
  });
});

describe('EmailVerifiedGuard (opt-in, REQUIRE_EMAIL_VERIFICATION)', () => {
  const reflector = new Reflector();
  const guardFor = (required: boolean): EmailVerifiedGuard =>
    new EmailVerifiedGuard(reflector, { REQUIRE_EMAIL_VERIFICATION: required } as never);

  const unverified: TenantContext = { ...CONTEXT, emailVerified: false };
  const verified: TenantContext = { ...CONTEXT, emailVerified: true };

  it('is inert when the deployment does not require verification', () => {
    runWithTenant(unverified, () => {
      expect(guardFor(false).canActivate(executionContext())).toBe(true);
    });
  });

  it('refuses an unconfirmed account when it does require it', () => {
    runWithTenant(unverified, () => {
      try {
        guardFor(true).canActivate(executionContext());
        throw new Error('expected a rejection');
      } catch (error) {
        // Its own code, not FORBIDDEN: the client's answer is to offer a re-send, not to give up.
        expect((error as ApiError).code).toBe('EMAIL_NOT_VERIFIED');
        expect((error as ApiError).retryable).toBe(true);
      }
    });
  });

  it('allows a confirmed account', () => {
    runWithTenant(verified, () => {
      expect(guardFor(true).canActivate(executionContext())).toBe(true);
    });
  });

  it('lets @AllowUnverified() through, so an unconfirmed account can fix itself', () => {
    const handler = function resend(): void {};
    Reflect.defineMetadata('finmate:allow-unverified', true, handler);
    runWithTenant(unverified, () => {
      expect(guardFor(true).canActivate(executionContext(handler))).toBe(true);
    });
  });

  it('lets @Public() through, so login stays reachable', () => {
    const handler = function login(): void {};
    Reflect.defineMetadata('finmate:public', true, handler);
    runWithTenant(unverified, () => {
      expect(guardFor(true).canActivate(executionContext(handler))).toBe(true);
    });
  });

  it('does not authenticate: a request with no context is left to AuthenticatedGuard', () => {
    expect(guardFor(true).canActivate(executionContext())).toBe(true);
  });
});
