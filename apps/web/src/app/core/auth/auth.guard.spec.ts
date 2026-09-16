// @vitest-environment jsdom
// The guard is a plain function, but it reads injected services, so this spec runs it in an Angular
// injection context against stubs — the real `AuthStore` fetches over `HttpClient` and the real lock
// reads IndexedDB, neither of which this decision table is about.
import { initAngularTesting } from '@web-test/angular-testing';

import { TestBed } from '@angular/core/testing';
import { Router, type ActivatedRouteSnapshot } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppLockService } from '../app-lock/app-lock.service';
import { AuthStore, type SessionFailure } from './auth.store';
import { authenticatedGuard } from './auth.guard';

initAngularTesting();

/**
 * ADR-033's decision table, which is the whole of R-27(b)'s security surface.
 *
 * Only an **unlocked** install whose restore failed because nothing answered may reach the routes that
 * read what is already on the device. A refused session (`401`) stays on the sign-in path, a locked
 * install never sees local data, and a route that has not declared itself offline-capable is redirected
 * to the tray rather than served.
 */
interface Stubs {
  readonly restore: ReturnType<typeof vi.fn>;
  readonly result: unknown;
}

async function run(options: {
  authenticated?: boolean;
  restoreFailure?: SessionFailure | null;
  lockState?: 'OFF' | 'LOCKED' | 'UNLOCKED';
  offlineRoute?: boolean;
}): Promise<Stubs> {
  const restore = vi.fn(() => Promise.resolve());

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: AuthStore,
        useValue: {
          isAuthenticated: () => options.authenticated === true,
          restoreFailure: () => options.restoreFailure ?? null,
          restore,
        },
      },
      {
        provide: AppLockService,
        useValue: { ready: () => Promise.resolve(), state: () => options.lockState ?? 'OFF' },
      },
      {
        provide: Router,
        useValue: { createUrlTree: (commands: readonly string[]) => ({ commands }) },
      },
    ],
  });

  const route = { data: options.offlineRoute === true ? { offline: true } : {} };
  const result = await TestBed.runInInjectionContext(() =>
    authenticatedGuard(route as unknown as ActivatedRouteSnapshot, {} as never),
  );
  return { restore, result };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('authenticatedGuard', () => {
  it('admits a session without asking the server again', async () => {
    const { restore, result } = await run({ authenticated: true });
    expect(result).toBe(true);
    expect(restore).not.toHaveBeenCalled();
  });

  it('admits an unlocked, unreachable install to an offline-capable route', async () => {
    const { result } = await run({
      restoreFailure: 'UNREACHABLE',
      lockState: 'UNLOCKED',
      offlineRoute: true,
    });
    expect(result).toBe(true);
  });

  it('sends an unlocked, unreachable install to the tray from any other route', async () => {
    const { result } = await run({
      restoreFailure: 'UNREACHABLE',
      lockState: 'UNLOCKED',
      offlineRoute: false,
    });
    expect(result).toEqual({ commands: ['/pending'] });
  });

  it('keeps a locked install out even when the restore was unreachable', async () => {
    // The data key is not in memory, so every offline read would be empty anyway.
    const { result } = await run({
      restoreFailure: 'UNREACHABLE',
      lockState: 'LOCKED',
      offlineRoute: true,
    });
    expect(result).toEqual({ commands: ['/sign-in'] });
  });

  it.each<SessionFailure>(['REFUSED', 'SIGNED_OUT'])(
    'respects a %s session and stays on the sign-in path',
    async (failure) => {
      const { result } = await run({
        restoreFailure: failure,
        lockState: 'UNLOCKED',
        offlineRoute: true,
      });
      expect(result).toEqual({ commands: ['/sign-in'] });
    },
  );

  it('does not re-ask the server once this page load has an answer', async () => {
    const { restore, result } = await run({ restoreFailure: 'REFUSED', lockState: 'UNLOCKED' });
    expect(result).toEqual({ commands: ['/sign-in'] });
    expect(restore).not.toHaveBeenCalled();
  });
});
