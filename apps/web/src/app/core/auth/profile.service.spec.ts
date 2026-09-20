// @vitest-environment jsdom
// FIRST import, deliberately: `TestBed.inject` needs a DOM even for a service with no template (docs/15 §9).
import { initAngularTesting } from '@web-test/angular-testing';

import { HttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProfileService } from './profile.service';

initAngularTesting();

/**
 * `ProfileService.load` reads three things at once, and **only one of them is required**.
 *
 * This is the regression that made a working `/profile` render "failed to load" with nothing on it: a
 * deployment serving the previous release answered `404` for `/auth/mfa`, and a `Promise.all` over
 * the three discarded the profile and the session list that had loaded fine. The identity still
 * propagates its failure — there is nothing honest to draw without it — but the other two degrade and
 * report themselves.
 */
const PROFILE = {
  userId: 'u-1',
  email: 'owner@example.com',
  pendingEmail: null,
  displayName: 'Owner',
  locale: 'en',
  emailVerified: true,
  createdAt: '2026-09-01T09:00:00.000Z',
};
const MFA = {
  totpEnabled: false,
  emailOtpEnabled: false,
  totpAvailable: true,
  recoveryCodesRemaining: 0,
};

function mount(overrides: Partial<Record<string, () => unknown>> = {}): ProfileService {
  const handlers: Record<string, () => unknown> = {
    '/api/auth/profile': () => of(PROFILE),
    '/api/auth/sessions': () => of([]),
    '/api/auth/mfa': () => of(MFA),
    ...overrides,
  };
  const http = {
    get: vi.fn((url: string) => handlers[url]!()),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: HttpClient, useValue: http }] });
  return TestBed.inject(ProfileService);
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('ProfileService.load', () => {
  it('reads all three and reports no failures', async () => {
    const service = mount();
    const result = await service.load();

    expect(service.profile()?.displayName).toBe('Owner');
    expect(service.mfa()?.totpAvailable).toBe(true);
    expect(result).toEqual({ sessionsFailed: false, mfaFailed: false });
  });

  it('keeps the identity when the factor state cannot be read', async () => {
    const service = mount({ '/api/auth/mfa': () => throwError(() => new Error('404')) });
    const result = await service.load();

    expect(service.profile()?.displayName).toBe('Owner');
    // Null, not a stale panel: the section renders an honest failure line instead.
    expect(service.mfa()).toBeNull();
    expect(result.mfaFailed).toBe(true);
  });

  it('keeps the identity when the session list cannot be read', async () => {
    const service = mount({ '/api/auth/sessions': () => throwError(() => new Error('500')) });
    const result = await service.load();

    expect(service.profile()?.displayName).toBe('Owner');
    expect(service.sessions()).toEqual([]);
    expect(result.sessionsFailed).toBe(true);
  });

  it('rejects when the identity itself cannot be read', async () => {
    const service = mount({ '/api/auth/profile': () => throwError(() => new Error('401')) });
    await expect(service.load()).rejects.toThrow();
  });
});
