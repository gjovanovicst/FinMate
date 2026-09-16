import { describe, expect, it, vi } from 'vitest';

import { runWithTenant } from '../../common/tenancy/tenant-context';
import type { AppConfig } from '../../config/config';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from '../../common/tenancy/session-resolver';
import { AuthController } from './auth.controller';
import type { AuthService, AuthTokens } from './auth.service';

/**
 * The refresh cookie's scope — R-26, task 4.3.5.
 *
 * This is a unit test rather than an integration one on purpose. The bug it pins is not in the database
 * or in the session lifecycle; it is a `Path` attribute in a response header, and the whole failure was
 * that the attribute described the path the *API* serves (`/auth`) instead of the path the *browser*
 * requests (`/api/auth`). Only the controller can be wrong about that, so only the controller needs
 * exercising — no database, no HTTP server, no tenant context.
 *
 * `Response` is faked down to the two calls the controller makes, capturing options rather than emitting
 * headers, because the options *are* the contract: `express` turns them into `Set-Cookie` verbatim.
 */
interface CookieCall {
  readonly name: string;
  readonly value: string;
  readonly options: Record<string, unknown>;
}

function fakeResponse() {
  const set: CookieCall[] = [];
  const cleared: CookieCall[] = [];
  return {
    set,
    cleared,
    cookie: (name: string, value: string, options: Record<string, unknown>) => {
      set.push({ name, value, options });
      return undefined;
    },
    clearCookie: (name: string, options: Record<string, unknown>) => {
      cleared.push({ name, value: '', options });
      return undefined;
    },
  };
}

const TOKENS: AuthTokens = {
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
  accessTokenExpiresIn: 900,
};

function controller(publicApiPrefix: string, auth: Partial<AuthService> = {}) {
  return new AuthController(
    { PUBLIC_API_PREFIX: publicApiPrefix, NODE_ENV: 'test', REFRESH_TOKEN_TTL_SECONDS: 60 * 60 * 24 * 30 } as AppConfig,
    { signup: vi.fn(async () => TOKENS), logout: vi.fn(async () => undefined), ...auth } as unknown as AuthService,
  );
}

const request = { headers: {}, ip: '127.0.0.1' } as never;

describe('AuthController — the refresh cookie path (R-26)', () => {
  it('scopes the refresh cookie to the prefix the browser sees, not the path the API serves', async () => {
    const response = fakeResponse();
    await controller('/api').signup({ email: 'a@b.c', password: 'x'.repeat(12), displayName: 'A' }, request, response as never);

    const refresh = response.set.find((call) => call.name === REFRESH_TOKEN_COOKIE);
    const access = response.set.find((call) => call.name === ACCESS_TOKEN_COOKIE);

    // The whole of R-26: `/auth` here means a cookie the browser never attaches to `/api/auth/refresh`,
    // so `restore()` gets an empty token and every hard reload lands on /sign-in.
    expect(refresh?.options['path']).toBe('/api/auth');
    // The access token is not scoped: it rides every API request by design.
    expect(access?.options['path']).toBe('/');
    // The narrow scope is preserved — this is the property the original `/auth` was chosen for.
    expect(refresh?.options['httpOnly']).toBe(true);
    expect(refresh?.options['sameSite']).toBe('lax');
  });

  it('mounts at the root when no prefix is configured', async () => {
    const response = fakeResponse();
    await controller('').signup({ email: 'a@b.c', password: 'x'.repeat(12), displayName: 'A' }, request, response as never);

    expect(response.set.find((call) => call.name === REFRESH_TOKEN_COOKIE)?.options['path']).toBe('/auth');
  });

  it('clears the cookie at the same path it was set at, or the token survives a logout', async () => {
    const response = fakeResponse();
    // `logout` resolves the session from the TenantContext (ADR-008), the same way it does in production.
    const auth = controller('/api');
    await runWithTenant(
      // `sessionId` is what `auth.logout` revokes; without it the context is rejected, which is the
      // guard doing its job rather than a test inconvenience.
      { householdId: 'h1', userId: 'u1', role: 'OWNER', requestId: 'spec', sessionId: 's1' },
      () => auth.logout(response as never),
    );

    // A browser only deletes a cookie whose attributes match the stored one, so a clear at `/auth` while
    // the cookie lives at `/api/auth` is a logout that does not log out.
    expect(response.cleared.find((call) => call.name === REFRESH_TOKEN_COOKIE)?.options['path']).toBe('/api/auth');
    expect(response.cleared.find((call) => call.name === ACCESS_TOKEN_COOKIE)?.options['path']).toBe('/');
  });

  it('clears at the same path on a refresh that presents no token at all', async () => {
    const response = fakeResponse();
    await controller('/api').refresh({}, { headers: {}, ip: '127.0.0.1' } as never, response as never);

    expect(response.cleared.find((call) => call.name === REFRESH_TOKEN_COOKIE)?.options['path']).toBe('/api/auth');
  });
});
