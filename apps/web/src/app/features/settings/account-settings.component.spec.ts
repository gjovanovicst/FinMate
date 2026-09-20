// @vitest-environment jsdom
// FIRST import, deliberately: it loads the JIT compiler before any Angular import (docs/15 §9).
import { initAngularTesting } from '@web-test/angular-testing';

import { CUSTOM_ELEMENTS_SCHEMA, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthStore } from '../../core/auth/auth.store';
import { ProfileService, type Profile } from '../../core/auth/profile.service';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { LanguageSwitcherComponent } from '../../shared/ui/language-switcher/language-switcher.component';
import { AccountSettingsComponent } from './account-settings.component';

initAngularTesting();

/**
 * The **Account** pane — name, email, password, language.
 *
 * What a rendered screen owes the person: the states are distinguishable (confirmed vs not, a staged
 * change vs an applied one), a password change says that other devices were signed out, and the
 * re-send control appears exactly when it can help. The server behaviour is `profile.integration.spec`
 * and `profile.service.spec`'s subject; this proves the pane offers the right controls.
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

function profileStub(initial: Profile = PROFILE) {
  const profile = signal<Profile | null>(initial);
  return {
    profile,
    loading: signal(false),
    ensureLoaded: vi.fn(async () => ({ sessionsFailed: false, mfaFailed: false })),
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
  };
}

async function mount(service = profileStub()) {
  const auth = {
    refresh: vi.fn(async () => undefined),
    clear: vi.fn(),
    resendVerification: vi.fn(async () => undefined),
    role: signal('OWNER'),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: ProfileService, useValue: service },
      { provide: AuthStore, useValue: auth },
    ],
  });
  // `fm-icon` and the language switcher are signal-input children; the JIT runner cannot bind one from
  // a parent template (NG0950). What they render is their own specs' subject.
  TestBed.overrideComponent(AccountSettingsComponent, {
    remove: { imports: [IconComponent, LanguageSwitcherComponent] },
    add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
  });
  const fixture = TestBed.createComponent(AccountSettingsComponent);
  await fixture.whenStable();
  return { fixture, component: fixture.componentInstance, service, auth };
}

function text(fixture: { nativeElement: unknown }): string {
  return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('AccountSettingsComponent', () => {
  it('shows the address and says it is confirmed', async () => {
    const { fixture } = await mount();
    expect(text(fixture)).toContain('owner@example.com');
    expect(text(fixture)).toContain('Confirmed');
  });

  it('says a change is waiting when one is staged', async () => {
    const { fixture } = await mount(profileStub({ ...PROFILE, pendingEmail: 'new@example.com' }));
    expect(text(fixture)).toContain('new@example.com');
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
});
