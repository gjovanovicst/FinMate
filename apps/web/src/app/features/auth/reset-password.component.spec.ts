// @vitest-environment jsdom
// FIRST import, deliberately: it loads `@angular/compiler` before anything that touches
// `@angular/router` (docs/15 §9). The two new screens link with `routerLink`, so they need it.
import { initAngularTesting } from '@web-test/angular-testing';

import { provideZonelessChangeDetection } from '@angular/core';
import type { FormGroup } from '@angular/forms';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthStore } from '../../core/auth/auth.store';
import { ResetPasswordComponent } from './reset-password.component';

initAngularTesting();

/**
 * The password-reset screen — F-28, task 5.8.
 *
 * Two questions on one route, and the assertions below are the ones that make the recovery path real:
 * the request form **never reveals whether an address exists**, a weak or mismatched password never
 * reaches the API, a spent token turns into the one action that helps (ask for another link), and a
 * failure that is *not* the token is shown as itself rather than blamed on the link.
 */

function makeStore() {
  return {
    requestPasswordReset: vi.fn(() => Promise.resolve()),
    resetPassword: vi.fn(() => Promise.resolve()),
  };
}

async function mount(token: string, store = makeStore()) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ResetPasswordComponent],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      // A real `ParamMap`, because that is what the component reads: an absent token is an absent query
      // parameter, which is exactly the case a router-bound input got wrong (docs/15).
      {
        provide: ActivatedRoute,
        useValue: { queryParamMap: of(convertToParamMap(token === '' ? {} : { token })) },
      },
      { provide: AuthStore, useValue: store },
    ],
  });
  const fixture = TestBed.createComponent(ResetPasswordComponent);
  const component = fixture.componentInstance;
  await fixture.whenStable();
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    component,
    store,
    text: () => root.textContent ?? '',
    // The two forms have different control sets, so the helper takes the loosest group type: the point
    // is to put a value in a named control, not to model the form's shape a second time.
    fill: (name: 'email' | 'password' | 'repeat', value: string) => {
      const group: FormGroup = component.requestForm.contains(name)
        ? (component.requestForm as FormGroup)
        : (component.setForm as FormGroup);
      const control = group.get(name);
      if (control === null) throw new Error(`no control ${name}`);
      control.setValue(value);
    },
  };
}

/** Angular's `HttpErrorResponse` shape, as `apiErrorCode` reads it. */
function apiError(code: string) {
  return { error: { error: { code, message: 'server said so' } } };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('ResetPasswordComponent — asking for a link', () => {
  it('asks without a token and says only that a link is on its way', async () => {
    const screen = await mount('');

    expect(screen.text()).toContain('Reset password');
    screen.fill('email', 'someone@example.test');
    await screen.component.request();
    screen.fixture.detectChanges();

    expect(screen.store.requestPasswordReset).toHaveBeenCalledWith('someone@example.test');
    // The address is named back, but the sentence is conditional: the API answers 204 for an unknown
    // address too, so this screen must not become the enumeration oracle the API refuses to be.
    expect(screen.text()).toContain('Check your email');
    expect(screen.text()).toContain('If an account exists for someone@example.test');
  });

  it('refuses an unparseable address before the round trip', async () => {
    const screen = await mount('');

    screen.fill('email', 'not-an-address');
    await screen.component.request();

    expect(screen.store.requestPasswordReset).not.toHaveBeenCalled();
  });

  it('shows a refusal as itself and keeps the form', async () => {
    const store = makeStore();
    store.requestPasswordReset = vi.fn(() => Promise.reject(apiError('RATE_LIMITED')));
    const screen = await mount('', store);

    screen.fill('email', 'someone@example.test');
    await screen.component.request();
    screen.fixture.detectChanges();

    expect(screen.text()).toContain('Too many attempts');
    expect(screen.text()).not.toContain('Check your email');
  });
});

describe('ResetPasswordComponent — using a link', () => {
  it('asks for the new password when the link carries a token', async () => {
    const screen = await mount('token-1');

    expect(screen.text()).toContain('New password');
    expect(screen.text()).toContain('At least 12 characters');
  });

  it('never sends a password that is too short or does not match', async () => {
    const screen = await mount('token-1');

    screen.fill('password', 'short');
    screen.fill('repeat', 'short');
    await screen.component.save();
    expect(screen.store.resetPassword).not.toHaveBeenCalled();

    screen.fill('password', 'correct-horse-battery');
    screen.fill('repeat', 'correct-horse-battery-2');
    screen.fixture.detectChanges();
    expect(screen.text()).toContain('The two passwords are not the same.');
    await screen.component.save();

    expect(screen.store.resetPassword).not.toHaveBeenCalled();
  });

  it('sends the token and the password, then points at sign-in', async () => {
    const screen = await mount('token-1');

    screen.fill('password', 'correct-horse-battery');
    screen.fill('repeat', 'correct-horse-battery');
    await screen.component.save();
    screen.fixture.detectChanges();

    expect(screen.store.resetPassword).toHaveBeenCalledWith('token-1', 'correct-horse-battery');
    expect(screen.text()).toContain('Password changed');
    expect(screen.text()).toContain('Sign in with the new password.');
  });

  it('turns a spent token into the one action that helps', async () => {
    // Unknown, already-used and expired all answer one code, and the client has checked the length
    // rule already — so this is the only thing a `VALIDATION_FAILED` here can mean.
    const store = makeStore();
    store.resetPassword = vi.fn(() => Promise.reject(apiError('VALIDATION_FAILED')));
    const screen = await mount('token-1', store);

    screen.fill('password', 'correct-horse-battery');
    screen.fill('repeat', 'correct-horse-battery');
    await screen.component.save();
    screen.fixture.detectChanges();

    expect(screen.text()).toContain('This link cannot be used');
    expect(screen.text()).toContain('Request a new link');
    // Not the generic "check the details you entered": nothing in the form is wrong.
    expect(screen.text()).not.toContain('Please check the details');
    expect(screen.text()).not.toContain('Password changed');
  });

  it('does not blame the link for a failure that is not the token', async () => {
    const store = makeStore();
    store.resetPassword = vi.fn(() => Promise.reject({ status: 0, message: 'Failed to fetch' }));
    const screen = await mount('token-1', store);

    screen.fill('password', 'correct-horse-battery');
    screen.fill('repeat', 'correct-horse-battery');
    await screen.component.save();
    screen.fixture.detectChanges();

    expect(screen.text()).toContain('server is not reachable');
    expect(screen.text()).not.toContain('This link cannot be used');
  });
});
