// @vitest-environment jsdom
// FIRST import, deliberately: it loads the JIT compiler before any Angular import (docs/15 §9).
import { initAngularTesting } from '@web-test/angular-testing';

import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppLockService } from '../../core/app-lock/app-lock.service';
import { SyncService } from '../../core/offline/sync.service';
import { SettingsComponent } from './settings.component';

initAngularTesting();

/**
 * The settings shell's first section: arming the app lock (task 4.2.6b).
 *
 * The decisions are `app-lock.service.spec.ts`'s subject; what a rendered screen must prove is that
 * the **right controls** are offered for the state — an armed install cannot arm again, an install
 * with a queue is told to drain it first rather than being refused silently, and turning the lock off
 * says that it deletes what is stored, because that is what it does.
 */
interface Mounted {
  readonly fixture: ReturnType<typeof TestBed.createComponent<SettingsComponent>>;
  readonly lock: {
    state: ReturnType<typeof vi.fn>;
    webauthnPossible: boolean;
    busy: ReturnType<typeof vi.fn>;
    failure: ReturnType<typeof vi.fn>;
    enableWithPin: ReturnType<typeof vi.fn>;
    enableWithWebAuthn: ReturnType<typeof vi.fn>;
    lock: ReturnType<typeof vi.fn>;
    purge: ReturnType<typeof vi.fn>;
  };
}

async function mount(
  state: 'OFF' | 'LOCKED' | 'UNLOCKED',
  options: { pending?: number; webauthn?: boolean; failure?: string | null } = {},
): Promise<Mounted> {
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

  TestBed.configureTestingModule({
    imports: [SettingsComponent],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AppLockService, useValue: lock },
      {
        provide: SyncService,
        useValue: { pendingCount: signal(options.pending ?? 0), refresh: vi.fn(() => Promise.resolve()) },
      },
    ],
  });
  const fixture = TestBed.createComponent(SettingsComponent);
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, lock };
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

describe('SettingsComponent (mounted)', () => {
  it('offers both ways to arm when the device has a platform authenticator', async () => {
    const { fixture } = await mount('OFF');

    expect(text(fixture)).toContain('App lock');
    expect(button(fixture, 'Use this device’s lock')).toBeDefined();
    expect(button(fixture, 'Use a PIN')).toBeDefined();
    // The panel has to say what arming buys, because it is the reason to do it at all.
    expect(text(fixture)).toContain('survive closing the app');
  });

  it('offers only the PIN when the browser has no credential API', async () => {
    const { fixture } = await mount('OFF', { webauthn: false });

    expect(button(fixture, 'Use this device’s lock')).toBeUndefined();
    expect(button(fixture, 'Use a PIN')).toBeDefined();
  });

  it('tells the user to drain the queue first instead of refusing silently', async () => {
    const { fixture, lock } = await mount('OFF', { pending: 2 });

    expect(text(fixture)).toContain('2 captures waiting to send');
    // The link is the way to act on that sentence.
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('a[href="/pending"]'),
    ).not.toBeNull();
    // And nothing was attempted behind the user's back.
    expect(lock.enableWithPin).not.toHaveBeenCalled();
  });

  it('arms with a PIN and clears the field', async () => {
    const { fixture, lock } = await mount('OFF');
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

  it('links to the screen that owns notifications rather than duplicating it', async () => {
    const { fixture } = await mount('OFF');

    // docs/02 §4.18 puts preferences in this shell; until the rest of it exists, the row is a link.
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('a[href="/notifications"]'),
    ).not.toBeNull();
  });
});
