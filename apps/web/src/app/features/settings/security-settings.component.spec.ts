// @vitest-environment jsdom
// FIRST import, deliberately: it loads the JIT compiler before any Angular import (docs/15 §9).
import { initAngularTesting } from '@web-test/angular-testing';

import { CUSTOM_ELEMENTS_SCHEMA, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppLockService } from '../../core/app-lock/app-lock.service';
import { AuthStore } from '../../core/auth/auth.store';
import type { AccountSession, MfaState } from '../../core/auth/profile.service';
import { ProfileService } from '../../core/auth/profile.service';
import { SyncService } from '../../core/offline/sync.service';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { TotpQrComponent } from '../../shared/ui/totp-qr/totp-qr.component';
import { SecuritySettingsComponent } from './security-settings.component';

initAngularTesting();

/**
 * The **Security** pane: the account's factors, the device lock, and the sessions.
 *
 * The lock's decisions are `app-lock.service.spec.ts`'s subject; what a rendered screen must prove is
 * that the **right controls** are offered for the state — an armed install cannot arm again, an install
 * with a queue is told to drain it first rather than being refused silently, and turning the lock off
 * says that it deletes what is stored, because that is what it does. The two-step and session halves
 * are asserted just far enough to prove the pane wired them.
 */

const SESSIONS: readonly AccountSession[] = [
  {
    id: 's-1',
    current: true,
    createdAt: '2026-09-01T09:00:00.000Z',
    lastSeenAt: '2026-09-20T09:00:00.000Z',
    expiresAt: '2026-10-01T09:00:00.000Z',
  },
  {
    id: 's-2',
    current: false,
    createdAt: '2026-09-02T09:00:00.000Z',
    lastSeenAt: '2026-09-19T09:00:00.000Z',
    expiresAt: '2026-10-02T09:00:00.000Z',
  },
];

const MFA: MfaState = {
  totpEnabled: false,
  emailOtpEnabled: false,
  totpAvailable: true,
  recoveryCodesRemaining: 0,
};

function profileStub(sessions: readonly AccountSession[] = SESSIONS, mfa: MfaState = MFA) {
  return {
    loading: signal(false),
    profile: signal(null),
    sessions: signal<readonly AccountSession[]>(sessions),
    mfa: signal<MfaState | null>(mfa),
    ensureLoaded: vi.fn(async () => ({ sessionsFailed: false, mfaFailed: false })),
    revokeSession: vi.fn(async () => ({ revoked: true, current: false })),
    revokeOtherSessions: vi.fn(async () => 2),
  };
}

async function mount(
  state: 'OFF' | 'LOCKED' | 'UNLOCKED',
  options: { pending?: number; webauthn?: boolean; failure?: string | null; profile?: ReturnType<typeof profileStub> } = {},
) {
  const lock = {
    state: vi.fn(() => state),
    webauthnPossible: options.webauthn ?? true,
    busy: vi.fn(() => false),
    failure: vi.fn(() => options.failure ?? null),
    enableWithPin: vi.fn(() => Promise.resolve(true)),
    enableWithWebAuthn: vi.fn(() => Promise.resolve(true)),
    lock: vi.fn(),
    purge: vi.fn(() => Promise.resolve()),
  };
  const profile = options.profile ?? profileStub();
  const auth = { role: signal('OWNER'), clear: vi.fn(), refresh: vi.fn(), resendVerification: vi.fn() };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AppLockService, useValue: lock },
      { provide: ProfileService, useValue: profile },
      { provide: AuthStore, useValue: auth },
      {
        provide: SyncService,
        useValue: { pendingCount: signal(options.pending ?? 0), refresh: vi.fn(() => Promise.resolve()) },
      },
    ],
  });
  // `fm-icon` and the QR are signal-input children the JIT runner cannot bind from a parent template
  // (NG0950 — the same limitation `settings.component.spec.ts` records); their own specs cover them.
  TestBed.overrideComponent(SecuritySettingsComponent, {
    remove: { imports: [IconComponent, TotpQrComponent] },
    add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
  });
  const fixture = TestBed.createComponent(SecuritySettingsComponent);
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, lock, profile, auth };
}

function text(fixture: { nativeElement: unknown }): string {
  return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

function button(fixture: { nativeElement: unknown }, label: string): HTMLButtonElement | undefined {
  return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).find((entry) =>
    entry.textContent?.includes(label),
  );
}

afterEach(() => TestBed.resetTestingModule());

describe('SecuritySettingsComponent — the app lock', () => {
  it('offers both ways to arm when the device has a platform authenticator', async () => {
    const { fixture } = await mount('OFF');

    expect(text(fixture)).toContain('App lock');
    expect(button(fixture, 'Use this device’s lock')).toBeDefined();
    // The panel has to say what arming buys, because it is the reason to do it at all.
    expect(text(fixture)).toContain('survive closing the app');
    // And what the device path buys over the PIN: one tap, and a longer idle window (ADR-029's
    // amendment). The PIN is the *fallback* docs/08 §3.9 names, so it sits behind this.
    expect(text(fixture)).toContain('One tap');
    expect(button(fixture, 'Use a PIN instead')).toBeDefined();
    expect((fixture.nativeElement as HTMLElement).querySelector('#new-pin')).toBeNull();
  });

  it('offers only the PIN when the browser has no credential API', async () => {
    const { fixture } = await mount('OFF', { webauthn: false });

    expect(button(fixture, 'Use this device’s lock')).toBeUndefined();
    // No platform authenticator means no fallback to hide: the PIN is the only path and shows itself.
    expect(button(fixture, 'Use a PIN')).toBeDefined();
    expect((fixture.nativeElement as HTMLElement).querySelector('#new-pin')).not.toBeNull();
    expect(button(fixture, 'Use a PIN instead')).toBeUndefined();
  });

  it('tells the user to drain the queue first instead of refusing silently', async () => {
    const { fixture, lock } = await mount('OFF', { pending: 2 });

    expect(text(fixture)).toContain('2 captures waiting to send');
    // The link is the way to act on that sentence.
    expect((fixture.nativeElement as HTMLElement).querySelector('a[href="/pending"]')).not.toBeNull();
    // And nothing was attempted behind the user's back.
    expect(lock.enableWithPin).not.toHaveBeenCalled();
  });

  it('arms with a PIN, once the fallback has been asked for', async () => {
    const { fixture, lock } = await mount('OFF');

    button(fixture, 'Use a PIN instead')!.click();
    fixture.detectChanges();

    const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('#new-pin')!;
    input.value = '246810';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    button(fixture, 'Use a PIN')!.click();
    await fixture.whenStable();

    expect(lock.enableWithPin).toHaveBeenCalledWith('246810', 0);
    expect(input.value).toBe('');
  });

  it('offers Lock now and a plainly-named delete once the lock is armed', async () => {
    const { fixture } = await mount('UNLOCKED');

    expect(button(fixture, 'Lock now')).toBeDefined();
    // The label says what the button does: turning the lock off wipes the store (ADR-029 decision 9).
    expect(button(fixture, 'Turn off and delete stored data')).toBeDefined();
    expect(text(fixture)).toContain('deletes everything stored on this device');
    // Nothing to arm again.
    expect(button(fixture, 'Use a PIN')).toBeUndefined();
  });

  it('shows the reason a lock could not be armed', async () => {
    const { fixture } = await mount('OFF', { failure: 'WEBAUTHN_UNAVAILABLE' });

    expect(text(fixture)).toContain('cannot use its screen lock');
  });
});

describe('SecuritySettingsComponent — factors and sessions', () => {
  it('reports both factors and offers the authenticator setup', async () => {
    const { fixture } = await mount('OFF');
    expect(text(fixture)).toContain('Authenticator app: off');
    expect(button(fixture, 'Set up an authenticator app')).toBeDefined();
  });

  it('lists the sessions and marks this one without offering to revoke it', async () => {
    const { fixture } = await mount('OFF');
    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll('.session');

    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('button')).toBeNull();
    expect(rows[1]!.querySelector('button')).not.toBeNull();
    expect(button(fixture, 'Sign out all other devices')).toBeDefined();
  });

  it('says a section failed instead of blanking the pane', async () => {
    const profile = profileStub();
    profile.ensureLoaded = vi.fn(async () => ({ sessionsFailed: true, mfaFailed: true }));
    const { fixture } = await mount('OFF', { profile });

    // Both flags are set through the real `load()` path in the component's constructor.
    expect(text(fixture)).toContain('could not be loaded');
  });
});
