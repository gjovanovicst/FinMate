// @vitest-environment jsdom
// FIRST import, deliberately: it loads `@angular/compiler` before anything that touches
// `@angular/router` (docs/15 §9).
import { initAngularTesting } from '@web-test/angular-testing';

import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthStore } from '../../core/auth/auth.store';
import { SignInComponent } from './sign-in.component';

initAngularTesting();

/**
 * Sign-in — the one thing 5.8 changed here.
 *
 * The screen itself is Phase 0's; what the reset work added is the way into the recovery flow, and the
 * assertion that matters is that the link is a real route reachable from the form rather than a
 * sentence telling the user to find another way in.
 */
async function mount(store = { signIn: vi.fn(() => Promise.resolve()) }) {
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
    const store = { signIn: vi.fn(() => Promise.reject({ error: { error: { code: 'UNAUTHENTICATED' } } })) };
    const screen = await mount(store);

    screen.component.form.setValue({ email: 'someone@example.test', password: 'wrong-password' });
    await screen.component.submit();
    screen.fixture.detectChanges();

    expect(screen.text()).toContain('Incorrect email or password');
  });
});
