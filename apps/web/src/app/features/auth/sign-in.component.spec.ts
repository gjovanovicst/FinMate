// @vitest-environment jsdom
// FIRST import, deliberately: it loads `@angular/compiler` before anything that touches
// `@angular/router` (docs/15 §9).
import { initAngularTesting } from '@web-test/angular-testing';

import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthStore, type MfaChallenge } from '../../core/auth/auth.store';
import { SignInComponent } from './sign-in.component';

initAngularTesting();

/**
 * Sign-in, and the second step 5.8 did not have.
 *
 * What matters here is the **shape of the flow**: with a second factor on, a correct password must
 * not navigate (the API sets no cookie, so there is nothing to navigate with), the code form must
 * survive a refused code, and the recovery flow link must stay reachable from the password step.
 */

interface StoreStub {
  signIn: ReturnType<typeof vi.fn>;
  verifyMfa: ReturnType<typeof vi.fn>;
  resendMfaCode: ReturnType<typeof vi.fn>;
  cancelMfa: ReturnType<typeof vi.fn>;
  mfaChallenge: () => MfaChallenge | null;
}

function challenge(overrides: Partial<MfaChallenge> = {}): MfaChallenge {
  return {
    challengeToken: 'challenge-1',
    methods: ['TOTP'],
    emailHint: 'a***@example.test',
    expiresAt: '2026-09-20T12:05:00.000Z',
    ...overrides,
  };
}

async function mount(overrides: Partial<StoreStub> = {}) {
  const store: StoreStub = {
    signIn: vi.fn(async () => 'SESSION'),
    verifyMfa: vi.fn(async () => undefined),
    resendMfaCode: vi.fn(async () => undefined),
    cancelMfa: vi.fn(),
    mfaChallenge: () => null,
    ...overrides,
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [SignInComponent],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AuthStore, useValue: store },
    ],
  });
  const fixture = TestBed.createComponent(SignInComponent);
  await fixture.whenStable();
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  return { fixture, component: fixture.componentInstance, store, root, text: () => root.textContent ?? '' };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('SignInComponent', () => {
  it('offers the password-reset screen', async () => {
    const screen = await mount();
    const link = screen.root.querySelector<HTMLAnchorElement>('a[href="/reset-password"]');

    expect(link).not.toBeNull();
    expect(link?.textContent).toContain('Forgot your password?');
  });

  it('reports a refused sign-in and stays on the form', async () => {
    const screen = await mount({
      signIn: vi.fn(() => Promise.reject({ error: { error: { code: 'UNAUTHENTICATED' } } })),
    });

    screen.component.form.setValue({ email: 'someone@example.test', password: 'wrong-password' });
    await screen.component.submit();
    screen.fixture.detectChanges();

    expect(screen.text()).toContain('Incorrect email or password');
  });

  it('replaces the form while the sign-in and the navigation are in flight', async () => {
    // The dashboard is a lazy route and the router keeps this component mounted until its chunk and
    // guards are ready — so the form used to sit on screen for the whole load, with a disabled button as
    // its only signal. `submitting` spans the credentials call *and* `navigateByUrl`, so the form is gone
    // for both.
    let release!: () => void;
    const pending = new Promise<string>((resolve) => {
      release = () => resolve('SESSION');
    });
    const screen = await mount({ signIn: vi.fn(() => pending) });

    screen.component.form.setValue({ email: 'someone@example.test', password: 'correct-horse' });
    const submitting = screen.component.submit();
    screen.fixture.detectChanges();

    expect(screen.root.querySelector('form')).toBeNull();
    expect(screen.root.querySelectorAll('input')).toHaveLength(0);
    // Announced rather than silent, and drawn in the form's own place.
    expect(screen.root.querySelector('[role="status"]')?.textContent).toContain('Signing in');
    // The way out to sign-up goes with the form: it is a navigation away from a submit in flight.
    expect(screen.root.querySelector('a[href="/sign-up"]')).toBeNull();

    release();
    await submitting;
  });

  it('swaps to the code form when the account has a second factor', async () => {
    const active = signal<MfaChallenge | null>(null);
    const screen = await mount({
      signIn: vi.fn(async () => {
        active.set(challenge());
        return 'MFA';
      }),
      mfaChallenge: () => active(),
    });

    screen.component.form.setValue({ email: 'someone@example.test', password: 'correct-horse' });
    await screen.component.submit();
    screen.fixture.detectChanges();

    // The password fields are gone — this is a different step, not an error on the same form.
    expect(screen.root.querySelector('input[type="email"]')).toBeNull();
    expect(screen.text()).toContain('authenticator app');
    expect(screen.root.querySelector('input[autocomplete="one-time-code"]')).not.toBeNull();
  });

  it('finishes the login with the code, and only then', async () => {
    const active = signal<MfaChallenge | null>(challenge());
    const screen = await mount({
      signIn: vi.fn(async () => 'MFA'),
      mfaChallenge: () => active(),
    });
    screen.component.step.set('MFA');
    screen.component.codeForm.setValue({ code: '123456' });
    screen.fixture.detectChanges();

    await screen.component.verify();

    expect(screen.store.verifyMfa).toHaveBeenCalledWith('123456');
  });

  it('submits the code through the form itself, and cancels the browser default', async () => {
    // The bug this guards: the code form bound `(ngSubmit)` with **no form directive**, so nothing ever
    // emitted `ngSubmit` and nothing called `preventDefault()`. Clicking *Verify* did a native GET submit
    // to the same URL — the page reloaded, the challenge and access token (both in memory) were gone, and
    // the password form came back. Every other MFA test called `verify()` directly and so could not see
    // it: this one drives the real DOM path and asserts both halves of the contract.
    const active = signal<MfaChallenge | null>(challenge());
    const screen = await mount({
      signIn: vi.fn(async () => 'MFA'),
      mfaChallenge: () => active(),
    });
    screen.component.step.set('MFA');
    screen.fixture.detectChanges();

    const form = screen.root.querySelector('form');
    const input = screen.root.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]');
    expect(form).not.toBeNull();
    expect(input).not.toBeNull();
    input!.value = '654321';
    input!.dispatchEvent(new Event('input', { bubbles: true }));

    const submit = new Event('submit', { bubbles: true, cancelable: true });
    const notCancelled = form!.dispatchEvent(submit);
    await screen.fixture.whenStable();

    expect(screen.store.verifyMfa).toHaveBeenCalledWith('654321');
    // A native submit is what reloads the page and loses the challenge.
    expect(notCancelled).toBe(false);
    expect(submit.defaultPrevented).toBe(true);
  });

  it('keeps the code form when the code is refused', async () => {
    const active = signal<MfaChallenge | null>(challenge());
    const screen = await mount({
      signIn: vi.fn(async () => 'MFA'),
      verifyMfa: vi.fn(() => Promise.reject({ error: { error: { code: 'MFA_INVALID_CODE' } } })),
      mfaChallenge: () => active(),
    });
    screen.component.step.set('MFA');
    screen.component.codeForm.setValue({ code: '000000' });
    screen.fixture.detectChanges();

    await screen.component.verify();
    screen.fixture.detectChanges();

    expect(screen.text()).toContain('not correct');
    // The challenge survives a wrong code, so the person does not retype their password.
    expect(screen.root.querySelector('input[autocomplete="one-time-code"]')).not.toBeNull();
  });

  it('offers an emailed code only when the account has that factor', async () => {
    const active = signal<MfaChallenge | null>(challenge({ methods: ['TOTP'] }));
    const screen = await mount({ mfaChallenge: () => active() });
    screen.component.step.set('MFA');
    screen.fixture.detectChanges();
    expect(screen.text()).not.toContain('Email me a code');

    active.set(challenge({ methods: ['TOTP', 'EMAIL'] }));
    screen.fixture.detectChanges();
    expect(screen.text()).toContain('Email me a code');
  });

  it('names the masked address when email is the only factor', async () => {
    const active = signal<MfaChallenge | null>(challenge({ methods: ['EMAIL'] }));
    const screen = await mount({ mfaChallenge: () => active() });
    screen.component.step.set('MFA');
    screen.fixture.detectChanges();

    expect(screen.text()).toContain('a***@example.test');
  });

  it('goes back to the password form and drops the half-finished challenge', async () => {
    const active = signal<MfaChallenge | null>(challenge());
    const screen = await mount({ mfaChallenge: () => active() });
    screen.component.step.set('MFA');
    screen.fixture.detectChanges();

    screen.component.back();
    screen.fixture.detectChanges();

    expect(screen.store.cancelMfa).toHaveBeenCalled();
    expect(screen.component.step()).toBe('PASSWORD');
    expect(screen.root.querySelector('input[type="email"]')).not.toBeNull();
  });
});
