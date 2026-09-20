// @vitest-environment jsdom
// FIRST import, deliberately: it loads the JIT compiler before any Angular import (docs/15 §9).
import { initAngularTesting } from '@web-test/angular-testing';

import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthStore, type Session } from '../../../core/auth/auth.store';
import { VerifyBannerComponent } from './verify-banner.component';

initAngularTesting();

/**
 * The unconfirmed-address banner (task 0.6.5).
 *
 * The decision under test is **when it is silent**: a deployment that does not require verification
 * must not nag, and a confirmed account must see nothing. The blocking case is the one that renders,
 * and its only action — a re-send — is what 5.8 left missing.
 */

const BASE: Session = {
  userId: 'u-1',
  householdId: 'h-1',
  role: 'OWNER',
  sessionId: 's-1',
  email: 'owner@example.com',
  displayName: 'Owner',
  locale: 'en',
  emailVerified: false,
  pendingEmail: null,
  emailVerificationRequired: true,
};

async function mount(session: Session | null) {
  const resendVerification = vi.fn(async () => undefined);
  const sessions = signal<Session | null>(session);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      {
        provide: AuthStore,
        useValue: { session: sessions.asReadonly(), resendVerification },
      },
    ],
  });
  const fixture = TestBed.createComponent(VerifyBannerComponent);
  await fixture.whenStable();
  return { fixture, resendVerification };
}

function text(fixture: { nativeElement: unknown }): string {
  return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('VerifyBannerComponent', () => {
  it('is silent for a confirmed account', async () => {
    const { fixture } = await mount({ ...BASE, emailVerified: true });
    expect(text(fixture).trim()).toBe('');
  });

  it('is silent when this deployment does not require verification', async () => {
    const { fixture } = await mount({ ...BASE, emailVerificationRequired: false });
    expect(text(fixture).trim()).toBe('');
  });

  it('is silent with no session', async () => {
    const { fixture } = await mount(null);
    expect(text(fixture).trim()).toBe('');
  });

  it('explains the block and names the address it wrote to', async () => {
    const { fixture } = await mount(BASE);
    expect(text(fixture)).toContain('owner@example.com');
    expect(text(fixture)).toContain('Send the link again');
  });

  it('re-sends and then says a new link is on its way', async () => {
    const { fixture, resendVerification } = await mount(BASE);
    const button = (fixture.nativeElement as HTMLElement).querySelector('button');
    expect(button).not.toBeNull();

    button!.click();
    await fixture.whenStable();

    expect(resendVerification).toHaveBeenCalledTimes(1);
    expect(text(fixture)).toContain('A new link is on its way');
  });
});
