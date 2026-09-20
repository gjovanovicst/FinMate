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
 * ADR-033's decision table (amended), which is the whole of R-27(b)'s security surface.
 *
 * An **unlocked** install whose restore failed because nothing answered reaches the app's own screens —
 * every route, because each screen serves the record it has (the dashboard snapshot, the ledger cache,
 * the queue) or its own "needs a connection" state. A refused session (`401`) stays on the sign-in path,
 * and a locked install never sees local data.
 */
interface Stubs {
  readonly restore: ReturnType<typeof vi.fn>;
  readonly result: unknown;
}

async function run(options: {
  authenticated?: boolean;
  restoreFailure?: SessionFailure | null;
  lockState?: 'OFF' | 'LOCKED' | 'UNLOCKED';
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

  const result = await TestBed.runInInjectionContext(() =>
    authenticatedGuard({} as ActivatedRouteSnapshot, {} as never),
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

  it('admits an unlocked, unreachable install to the app, on any route', async () => {
    // No route declares itself offline-capable any more (ADR-033 amended): the offline app is the app,
    // and each screen is responsible for what it can honestly show without a server.
    const { result } = await run({ restoreFailure: 'UNREACHABLE', lockState: 'UNLOCKED' });
    expect(result).toBe(true);
  });

  it('keeps a locked install out even when the restore was unreachable', async () => {
    // The data key is not in memory, so every offline read would be empty anyway.
    const { result } = await run({ restoreFailure: 'UNREACHABLE', lockState: 'LOCKED' });
    expect(result).toEqual({ commands: ['/sign-in'] });
  });

  it.each<SessionFailure>(['REFUSED', 'SIGNED_OUT'])(
    'respects a %s session and stays on the sign-in path',
    async (failure) => {
      const { result } = await run({ restoreFailure: failure, lockState: 'UNLOCKED' });
      expect(result).toEqual({ commands: ['/sign-in'] });
    },
  );

  it('does not re-ask the server once this page load has an answer', async () => {
    const { restore, result } = await run({ restoreFailure: 'REFUSED', lockState: 'UNLOCKED' });
    expect(result).toEqual({ commands: ['/sign-in'] });
    expect(restore).not.toHaveBeenCalled();
  });
});
