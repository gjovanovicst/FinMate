// @vitest-environment jsdom
// FIRST import, deliberately: it loads the JIT compiler before any Angular import (docs/15 §9).
import { initAngularTesting } from '@web-test/angular-testing';

import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppLockService } from '../../../core/app-lock/app-lock.service';
import { AuthStore } from '../../../core/auth/auth.store';
import { SyncService } from '../../../core/offline/sync.service';
import { AppLockScreenComponent } from './app-lock-screen.component';

initAngularTesting();

/**
 * The re-auth screen, mounted (task 4.2.6b).
 *
 * What a rendered component proves here and a pure function cannot: that the screen asks for the
 * secret the lock actually has — a PIN-armed lock has no credential to ask for, and a WebAuthn-armed
 * lock has no PIN — that a wrong PIN is shown rather than swallowed, and that the input can only ever
 * hold six digits.
 */
interface Mounted {
  readonly fixture: ReturnType<typeof TestBed.createComponent<AppLockScreenComponent>>;
  readonly lock: {
    state: ReturnType<typeof vi.fn>;
    method: ReturnType<typeof vi.fn>;
    busy: ReturnType<typeof vi.fn>;
    failure: ReturnType<typeof vi.fn>;
    unlockWithPin: ReturnType<typeof vi.fn>;
    unlockWithWebAuthn: ReturnType<typeof vi.fn>;
    purge: ReturnType<typeof vi.fn>;
  };
  readonly sync: { refresh: ReturnType<typeof vi.fn> };
}

async function mount(
  options: { method?: 'PIN' | 'WEBAUTHN'; failure?: string | null; pinResult?: boolean } = {},
): Promise<Mounted> {
  const lock = {
    state: vi.fn(() => 'LOCKED'),
    method: vi.fn(() => options.method ?? 'PIN'),
    busy: vi.fn(() => false),
    failure: vi.fn(() => options.failure ?? null),
    unlockWithPin: vi.fn(() => Promise.resolve(options.pinResult ?? true)),
    unlockWithWebAuthn: vi.fn(() => Promise.resolve(true)),
    purge: vi.fn(() => Promise.resolve()),
  };
  const sync = { refresh: vi.fn(() => Promise.resolve()) };

  TestBed.configureTestingModule({
    imports: [AppLockScreenComponent],
    providers: [
      provideZonelessChangeDetection(),
      { provide: AppLockService, useValue: lock },
      { provide: SyncService, useValue: sync },
      { provide: AuthStore, useValue: { signOut: vi.fn(() => Promise.resolve()) } },
    ],
  });
  const fixture = TestBed.createComponent(AppLockScreenComponent);
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, lock, sync };
}

function text(fixture: { nativeElement: unknown }): string {
  return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

function buttonByText(fixture: { nativeElement: unknown }, label: string): HTMLButtonElement | undefined {
  return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).find((entry) =>
    entry.textContent?.trim() === label,
  );
}

function pinInput(fixture: { nativeElement: unknown }): HTMLInputElement | null {
  return (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('#lock-pin');
}

afterEach(() => TestBed.resetTestingModule());

describe('AppLockScreenComponent (mounted)', () => {
  it('asks for a PIN only, when that is how the lock was armed', async () => {
    const { fixture } = await mount({ method: 'PIN' });

    expect(pinInput(fixture)).not.toBeNull();
    expect(text(fixture)).toContain('Unlock the app');
    // A credential was never created, so offering the biometric button would offer a control that
    // always fails.
    expect(text(fixture)).not.toContain('Unlock with this device');
  });

  it('asks for the device only, when that is how the lock was armed', async () => {
    const { fixture } = await mount({ method: 'WEBAUTHN' });

    // No PIN was ever chosen, so a PIN field would be a lock with a second secret nobody set.
    expect(pinInput(fixture)).toBeNull();
    expect(text(fixture)).toContain('Unlock with this device');
    // Never prompted on load: the button is the gesture WebAuthn requires.
    expect(text(fixture)).not.toContain('Checking…');
  });

  it('keeps only digits, caps at six, and refuses to submit short', async () => {
    const { fixture, lock } = await mount({ method: 'PIN' });
    const input = pinInput(fixture)!;
    input.value = 'ab12cd34ef56';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(input.value).toBe('123456');
    // A submit with fewer than six digits cannot be a PIN, so it must not spend a PBKDF2 derivation.
    const form = (fixture.nativeElement as HTMLElement).querySelector('form')!;
    input.value = '123';
    input.dispatchEvent(new Event('input'));
    form.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(lock.unlockWithPin).not.toHaveBeenCalled();
  });

  it('unlocks, clears the field, and re-reads the queue the key just made readable', async () => {
    const { fixture, lock, sync } = await mount({ method: 'PIN' });
    const input = pinInput(fixture)!;
    input.value = '123456';
    input.dispatchEvent(new Event('input'));
    (fixture.nativeElement as HTMLElement).querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    // No auto-detection in TestBed: the signal write needs one pass before the DOM reflects it.
    fixture.detectChanges();

    expect(lock.unlockWithPin).toHaveBeenCalledWith('123456');
    // The store switches backing on unlock, so every count on screen was stale by definition.
    expect(sync.refresh).toHaveBeenCalledTimes(1);
    // The field is cleared in the model, so a second press cannot re-send the same PIN: with an empty
    // one the submit button is disabled and the handler returns before it derives anything.
    expect(fixture.componentInstance.pin()).toBe('');
    expect(buttonByText(fixture, 'Unlock')?.disabled).toBe(true);
  });

  it('shows a wrong PIN as a message, and keeps the field for another try', async () => {
    const { fixture, sync } = await mount({ method: 'PIN', failure: 'WRONG_SECRET', pinResult: false });

    expect(text(fixture)).toContain('That PIN is not right.');
    expect(pinInput(fixture)).not.toBeNull();
    // Nothing became readable, so nothing was refreshed.
    expect(sync.refresh).not.toHaveBeenCalled();
  });

  it('offers a way out for somebody who is not the owner', async () => {
    const { fixture, lock } = await mount({ method: 'PIN' });

    expect(text(fixture)).toContain('Sign out instead');
    const signOut = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Sign out instead'),
    )!;
    signOut.click();
    await fixture.whenStable();

    // Signing out wipes rather than leaving an unlockable database behind (ADR-029 decision 9).
    expect(lock.purge).toHaveBeenCalledTimes(1);
  });
});
