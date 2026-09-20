// @vitest-environment jsdom
// FIRST import, deliberately: it loads `@angular/compiler` before anything that touches
// `@angular/router` (docs/15 §9).
import { initAngularTesting } from '@web-test/angular-testing';

import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthStore } from '../../core/auth/auth.store';
import { SUPPORTED_CURRENCIES } from '../../core/i18n/currency-names';
import { SignUpComponent } from './sign-up.component';

initAngularTesting();

/**
 * Sign-up's post-submit state, which is sign-in's.
 *
 * Both screens navigate to the **lazy** dashboard once the credentials are accepted, and the router keeps
 * the component mounted until that route is ready — so the form is replaced by a status line for the
 * whole submit instead of sitting on screen with a disabled button. `sign-in.component.spec.ts` owns the
 * fuller assertions; this pins that the second screen has the same shape, because a fix applied to one
 * of two copies is how the two drift.
 */
async function mount(store: { signUp: ReturnType<typeof vi.fn> }) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [SignUpComponent],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AuthStore, useValue: store },
    ],
  });
  const fixture = TestBed.createComponent(SignUpComponent);
  await fixture.whenStable();
  fixture.detectChanges();
  return {
    fixture,
    component: fixture.componentInstance,
    root: fixture.nativeElement as HTMLElement,
  };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('SignUpComponent', () => {
  it('replaces the form while the sign-up and the navigation are in flight', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const screen = await mount({ signUp: vi.fn(() => pending) });

    screen.component.form.setValue({
      displayName: 'Ana',
      email: 'ana@example.test',
      password: 'correct-horse',
      currency: 'EUR',
    });
    const submitting = screen.component.submit();
    screen.fixture.detectChanges();

    expect(screen.root.querySelector('form')).toBeNull();
    expect(screen.root.querySelectorAll('input')).toHaveLength(0);
    expect(screen.root.querySelector('[role="status"]')?.textContent).toContain('Creating account');

    release();
    await submitting;
  });

  /**
   * The ledger currency (ADR-045).
   *
   * Before this, the server wrote the literal `'RSD'` at signup, so a reader anywhere else was given a
   * dinar ledger without ever being asked — and a wrong ledger currency mislabels every amount the
   * Household goes on to record.
   */
  it('offers every supported currency, pre-filled, and sends the confirmed one', async () => {
    const signUp = vi.fn(
      (_email: string, _password: string, _displayName: string, _locale?: string, _currency?: string) =>
        Promise.resolve(),
    );
    const screen = await mount({ signUp });

    const control = screen.component.form.controls.currency;
    // Pre-filled from the browser's region rather than left empty or hardcoded.
    expect(SUPPORTED_CURRENCIES).toContain(control.value);
    expect(control.hasError('required')).toBe(false);

    const select = screen.root.querySelector('select');
    expect(select).not.toBeNull();
    expect(select!.querySelectorAll('option')).toHaveLength(SUPPORTED_CURRENCIES.length);
    // The label names the currency in the reader's language, via CLDR rather than a hand-written table.
    expect(select!.textContent).toContain('EUR');

    screen.component.form.setValue({
      displayName: 'Ana',
      email: 'ana@example.test',
      password: 'correct-horse',
      currency: 'EUR',
    });
    await screen.component.submit();

    expect(signUp).toHaveBeenCalledTimes(1);
    expect(signUp.mock.calls[0]?.[4]).toBe('EUR');
  });
});
