// @vitest-environment jsdom
// FIRST import, deliberately: `TestBed.inject` needs a DOM even for a service with no template, and
// `@angular/router`'s partially compiled package needs the JIT compiler already loaded (docs/15 §9).
import { initAngularTesting } from '@web-test/angular-testing';

import { HttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthStore } from './auth.store';

initAngularTesting();

/**
 * The store's one rule about *when* it asks the server for a session.
 *
 * `restore()` is called unconditionally by `anonymousGuard` on `/sign-in` — which is where the shell
 * navigates on sign-out — so a sign-out that happened **offline** would have its retry answered
 * `UNREACHABLE`, flipping `restoreFailure` and dropping the person into the offline shell (and the queue
 * they had just left) instead of onto the login form. ADR-033 makes the user's own choice final for the
 * page load, so the store is where that is enforced rather than in each caller.
 */
function mount(): {
  store: AuthStore;
  http: { post: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
} {
  const http = {
    post: vi.fn(() => of({ accessToken: 'token', expiresIn: 900 })),
    get: vi.fn(() =>
      of({
        userId: 'u-1',
        householdId: 'h-1',
        role: 'OWNER',
        sessionId: 's-1',
        email: 'owner@example.com',
        displayName: 'Owner',
        locale: 'en',
        emailVerified: true,
        pendingEmail: null,
      }),
    ),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: HttpClient, useValue: http }] });
  return { store: TestBed.inject(AuthStore), http };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('AuthStore.restore', () => {
  it('asks the server once on a fresh page load', async () => {
    const { store, http } = mount();

    await store.restore();

    expect(http.post).toHaveBeenCalledWith('/api/auth/refresh', {});
    expect(store.isAuthenticated()).toBe(true);
    expect(store.restoreFailure()).toBeNull();
  });

  it('does not re-attempt a restore after the user signed out', async () => {
    const { store, http } = mount();
    await store.restore();
    await store.signOut();
    expect(store.restoreFailure()).toBe('SIGNED_OUT');
    http.post.mockClear();

    await store.restore();

    expect(http.post).not.toHaveBeenCalled();
    expect(store.isAuthenticated()).toBe(false);
    // The reason survives too: `UNREACHABLE` here would reopen the offline shell over the login form.
    expect(store.restoreFailure()).toBe('SIGNED_OUT');
  });
});
