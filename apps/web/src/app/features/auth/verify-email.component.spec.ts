// @vitest-environment jsdom
// FIRST import, deliberately: it loads `@angular/compiler` before anything that touches
// `@angular/router` (docs/15 §9).
import { initAngularTesting } from '@web-test/angular-testing';

import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthStore } from '../../core/auth/auth.store';
import { VerifyEmailComponent } from './verify-email.component';

initAngularTesting();

/**
 * The email-confirmation screen — F-28, task 5.8.
 *
 * There is no form here, so the only things worth asserting are the ones a wrong implementation gets
 * wrong: the token is POSTed **exactly once** (it is single-use, and a retry would turn a success into a
 * failure in front of the user), a link with no token never calls the API at all, and a dead link says
 * what is true — the address is unconfirmed and the app still works.
 */

function makeStore() {
  return { verifyEmail: vi.fn(() => Promise.resolve()) };
}

async function mount(token: string, store = makeStore()) {
  TestBed.resetTestingModule();
  // A `Subject`, so a spec can change the URL under a live component — the case the single-use guard
  // exists for. The component subscribes in its constructor, so the first value must already be queued.
  const params = new Subject<ReturnType<typeof convertToParamMap>>();
  TestBed.configureTestingModule({
    imports: [VerifyEmailComponent],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { queryParamMap: params.asObservable() } },
      { provide: AuthStore, useValue: store },
    ],
  });
  const fixture = TestBed.createComponent(VerifyEmailComponent);
  const component = fixture.componentInstance;
  params.next(convertToParamMap(token === '' ? {} : { token }));
  await fixture.whenStable();
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    component,
    store,
    /** Move the component to a different `?token=`, as a navigation would. */
    revisit: (nextToken: string) => {
      params.next(convertToParamMap(nextToken === '' ? {} : { token: nextToken }));
    },
    text: () => root.textContent ?? '',
  };
}

afterEach(() => {
  TestBed.resetTestingModule();
});

describe('VerifyEmailComponent', () => {
  it('confirms the address the link carries', async () => {
    const screen = await mount('token-1');

    expect(screen.store.verifyEmail).toHaveBeenCalledWith('token-1');
    expect(screen.text()).toContain('Email confirmed');
    expect(screen.text()).toContain('your address is confirmed');
  });

  it('sends the token once, however many times the screen renders', async () => {
    // The API consumes the token on the first call, so a second POST answers "invalid or expired" —
    // a screen that retried on a re-render would report a failure for a confirmed address.
    const screen = await mount('token-1');
    screen.fixture.detectChanges();
    await screen.fixture.whenStable();
    screen.fixture.detectChanges();

    expect(screen.store.verifyEmail).toHaveBeenCalledTimes(1);
  });

  it('never re-sends a token it has already used, even if the input returns to it', async () => {
    const screen = await mount('token-1');
    expect(screen.store.verifyEmail).toHaveBeenCalledTimes(1);

    screen.revisit('token-2');
    await screen.fixture.whenStable();
    expect(screen.store.verifyEmail).toHaveBeenCalledTimes(2);

    screen.revisit('token-1');
    await screen.fixture.whenStable();
    expect(screen.store.verifyEmail).toHaveBeenCalledTimes(2);
  });

  it('reports a dead link, and says the app still works', async () => {
    const store = makeStore();
    store.verifyEmail = vi.fn(() =>
      Promise.reject({ error: { error: { code: 'VALIDATION_FAILED', message: 'no' } } }),
    );
    const screen = await mount('spent', store);

    expect(screen.text()).toContain('This link cannot be used');
    // The truth as the build stands: nothing reads `email_verified_at`, so nobody is locked out
    // (docs/09 5.8). The copy must not imply a gate that does not exist.
    expect(screen.text()).toContain('not required yet');
    expect(screen.text()).not.toContain('Email confirmed');
  });

  it('calls the API not at all when the link has no token', async () => {
    const screen = await mount('');

    expect(screen.store.verifyEmail).not.toHaveBeenCalled();
    expect(screen.text()).toContain('This link is incomplete');
  });
});
