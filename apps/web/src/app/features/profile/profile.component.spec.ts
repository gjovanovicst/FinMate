// @vitest-environment jsdom
// FIRST import, deliberately: it loads the JIT compiler before any Angular import (docs/15 §9).
import { initAngularTesting } from '@web-test/angular-testing';

import { CUSTOM_ELEMENTS_SCHEMA, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthStore } from '../../core/auth/auth.store';
import {
  ProfileService,
  type AccountSession,
  type MfaState,
  type Profile,
} from '../../core/auth/profile.service';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { LanguageSwitcherComponent } from '../../shared/ui/language-switcher/language-switcher.component';
import { TotpQrComponent } from '../../shared/ui/totp-qr/totp-qr.component';
import { ProfileComponent } from './profile.component';

initAngularTesting();

/**
 * The profile screen (docs/02 §4.18's **Profil** section).
 *
 * What a rendered screen owes the person: the states are distinguishable (confirmed vs not, a staged
 * change vs an applied one), a password change says that other devices were signed out, and revoking
 * the session you are using takes you to sign-in rather than leaving a dead screen behind. The
 * server behaviour is `profile.integration.spec.ts`'s subject; this proves the screen offers the
 * right controls and phrases the answers honestly.
 */

const PROFILE: Profile = {
  userId: 'u-1',
  email: 'owner@example.com',
  pendingEmail: null,
  displayName: 'Owner',
  locale: 'en',
  emailVerified: true,
  createdAt: '2026-09-01T09:00:00.000Z',
};

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

function profileStub(initial: Profile = PROFILE, sessions: readonly AccountSession[] = SESSIONS) {
  const profile = signal<Profile | null>(initial);
  const sessionList = signal<readonly AccountSession[]>(sessions);
  const mfa = signal<MfaState | null>({
    totpEnabled: false,
    emailOtpEnabled: false,
    totpAvailable: true,
    recoveryCodesRemaining: 0,
  });
  return {
    profile,
    sessions: sessionList,
    mfa,
    loading: signal(false),
    load: vi.fn(async () => ({ sessionsFailed: false, mfaFailed: false })),
    rename: vi.fn(async (displayName: string) => {
      const next = { ...(profile() as Profile), displayName };
      profile.set(next);
      return next;
    }),
    changeEmail: vi.fn(async (email: string) => {
      const next = { ...(profile() as Profile), pendingEmail: email };
      profile.set(next);
      return next;
    }),
    changePassword: vi.fn(async () => undefined),
    revokeSession: vi.fn(async () => ({ revoked: true, current: false })),
    revokeOtherSessions: vi.fn(async () => 2),
    reloadMfa: vi.fn(async () => mfa()),
    startTotpSetup: vi.fn(async () => ({
      secret: 'JBSWY3DPEHPK3PXP',
      otpauthUri: 'otpauth://totp/FinMate:a%40b.c?secret=JBSWY3DPEHPK3PXP&issuer=FinMate',
    })),
    enableTotp: vi.fn(async () => ['AAAA-AAAA-AAAA-AAAA']),
    disableTotp: vi.fn(async () => undefined),
    setEmailOtp: vi.fn(async () => [] as string[]),
    regenerateRecoveryCodes: vi.fn(async () => ['BBBB-BBBB-BBBB-BBBB']),
  };
}

async function mount(service = profileStub()) {
  const auth = {
    refresh: vi.fn(async () => undefined),
    clear: vi.fn(),
    rememberLocale: vi.fn(),
    resendVerification: vi.fn(async () => undefined),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: ProfileService, useValue: service },
      { provide: AuthStore, useValue: auth },
    ],
  });
  // `fm-icon` and `fm-language-switcher` are signal-input children; the JIT runner cannot bind one
  // from a parent template (NG0950 — the same limitation `settings.component.spec.ts` records), so
  // they are removed and left as opaque elements. What they render is their own specs' subject.
  TestBed.overrideComponent(ProfileComponent, {
    remove: { imports: [IconComponent, LanguageSwitcherComponent, TotpQrComponent] },
    add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
  });
  const fixture = TestBed.createComponent(ProfileComponent);
  await fixture.whenStable();
  return { fixture, component: fixture.componentInstance, service, auth, router: TestBed.inject(Router) };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('ProfileComponent', () => {
  it('shows the address and says it is confirmed', async () => {
    const { fixture } = await mount();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('owner@example.com');
    expect(text).toContain('Confirmed');
  });

  it('says a change is waiting when one is staged', async () => {
    const staged = profileStub({ ...PROFILE, pendingEmail: 'new@example.com' });
    const { fixture } = await mount(staged);
    expect(fixture.nativeElement.textContent).toContain('new@example.com');
  });

  it('renames through the service and refreshes the shell session', async () => {
    const { component, service, auth } = await mount();
    component.displayName.set('Renamed');
    await component.saveName(new Event('submit'));

    expect(service.rename).toHaveBeenCalledWith('Renamed');
    // The header renders the session's copy of the name, so it has to be re-read.
    expect(auth.refresh).toHaveBeenCalled();
  });

  it('keeps the password button disabled until the form is valid', async () => {
    const { component } = await mount();
    expect(component.passwordValid()).toBe(false);

    component.currentPassword.set('old-password');
    component.newPassword.set('short');
    expect(component.passwordValid()).toBe(false);

    component.newPassword.set('a long enough password');
    expect(component.passwordValid()).toBe(true);
  });

  it('changes the password and says other devices were signed out', async () => {
    const { component, service } = await mount();
    component.currentPassword.set('old-password');
    component.newPassword.set('a long enough password');
    await component.submitPassword(new Event('submit'));

    expect(service.changePassword).toHaveBeenCalledWith('old-password', 'a long enough password');
    expect(component.message()).toContain('Other devices');
  });

  it('offers no revoke button for the current session', async () => {
    const { fixture } = await mount();
    const rows = fixture.nativeElement.querySelectorAll('.session');
    expect(rows).toHaveLength(2);
    // The first row is this device: it has no button. The second has one.
    expect(rows[0].querySelector('button')).toBeNull();
    expect(rows[1].querySelector('button')).not.toBeNull();
  });

  it('signs out and navigates to sign-in when the current session is revoked', async () => {
    const service = profileStub();
    service.revokeSession = vi.fn(async () => ({ revoked: true, current: true }));
    const { component, auth, router } = await mount(service);
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);

    await component.revoke('s-1');

    expect(auth.clear).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/sign-in');
  });

  it('reports how many other sessions were ended', async () => {
    const { component, service } = await mount();
    await component.revokeOthers();
    expect(service.revokeOtherSessions).toHaveBeenCalled();
    expect(component.message()).toContain('2');
  });

  it('offers a re-send when the address is not confirmed, and nothing when it is', async () => {
    const unverified = await mount(profileStub({ ...PROFILE, emailVerified: false }));
    await unverified.component.resendVerification();
    expect(unverified.auth.resendVerification).toHaveBeenCalled();
    expect(unverified.component.message()).toBeTruthy();
  });

  it('shows no re-send control for a confirmed address', async () => {
    const { fixture } = await mount();
    const labels = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ).map((button) => button.textContent ?? '');
    expect(labels.some((label) => label.includes('Send the link again'))).toBe(false);
  });

  it('reports both factors as off and offers the authenticator setup', async () => {
    const { fixture, component } = await mount();
    expect(component.mfaStatus(component.profile.mfa()!)).toContain('off');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'Set up an authenticator app',
    );
  });

  it('walks the authenticator setup and shows the recovery codes only once', async () => {
    const { component, service } = await mount();
    component.mfaPassword.set('correct horse battery staple');

    await component.startTotp();
    expect(service.startTotpSetup).toHaveBeenCalledWith('correct horse battery staple');
    expect(component.totpSetup()?.secret).toBe('JBSWY3DPEHPK3PXP');

    component.totpCode.set('123456');
    await component.enableTotp();
    expect(service.enableTotp).toHaveBeenCalledWith('correct horse battery staple', '123456');
    expect(component.recoveryCodes()).toEqual(['AAAA-AAAA-AAAA-AAAA']);
    // The setup panel goes away once the factor is confirmed.
    expect(component.totpSetup()).toBeNull();

    component.dismissCodes();
    expect(component.recoveryCodes()).toEqual([]);
  });

  it('turns the emailed factor on and says so', async () => {
    const { component, service } = await mount();
    component.mfaPassword.set('correct horse battery staple');

    await component.toggleEmail(component.profile.mfa()!);

    expect(service.setEmailOtp).toHaveBeenCalledWith('correct horse battery staple', true);
    expect(component.mfaMessage()).toBeTruthy();
  });

  it('surfaces a rejected password on a factor change rather than failing silently', async () => {
    const { component, service } = await mount();
    service.setEmailOtp = vi.fn(async () => {
      throw new Error('Password is incorrect.');
    });
    component.mfaPassword.set('wrong');

    await component.toggleEmail(component.profile.mfa()!);

    expect(component.mfaError()).toContain('incorrect');
  });

  it('generates fresh recovery codes', async () => {
    const { component, service } = await mount();
    component.mfaPassword.set('correct horse battery staple');

    await component.regenerateCodes();

    expect(service.regenerateRecoveryCodes).toHaveBeenCalled();
    expect(component.recoveryCodes()).toEqual(['BBBB-BBBB-BBBB-BBBB']);
  });

  it('keeps the page up when the two-step read failed, and says so', async () => {
    const service = profileStub();
    service.load = vi.fn(async () => {
      // What the real service does when `/auth/mfa` cannot be read.
      service.mfa.set(null);
      return { sessionsFailed: false, mfaFailed: true };
    });
    const { fixture } = await mount(service);
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    // The identity is still there — this used to be an empty "failed to load".
    expect(text).toContain('owner@example.com');
    expect(text).toContain('could not be loaded');
  });
});
